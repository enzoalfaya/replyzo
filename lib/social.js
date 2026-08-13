// =============================================================================
//  Automacao de redes sociais (o "ManyChat" caseiro).
// -----------------------------------------------------------------------------
//  Recebe webhooks da Meta (Instagram + Facebook), faz match de palavras-chave
//  nos comentarios e responde automaticamente:
//    - Facebook: resposta PUBLICA ao comentario.
//    - Instagram: resposta PUBLICA ao comentario + DM (private reply).
//
//  Tudo degrada com elegancia: se as variaveis de ambiente nao estiverem
//  definidas, o modulo nao parte nada — apenas regista e devolve { ok:false }.
//  Isto permite ligar o webhook e testar o handshake ANTES de ter os tokens.
//
//  Variaveis de ambiente (.env / Render):
//    META_VERIFY_TOKEN   -> segredo que TU inventas; tem de bater certo com o
//                           "Verify token" que escreves no painel da Meta.
//    META_APP_SECRET     -> "App secret" da app Meta (valida a assinatura POST).
//    META_GRAPH_VERSION  -> versao da Graph API (ex.: v21.0). Opcional.
//    PAGE_ID             -> id da Pagina de Facebook.
//    PAGE_ACCESS_TOKEN   -> token da Pagina (serve para o Facebook E para o
//                           Instagram ligado a essa Pagina).
//    IG_POLL_SECONDS     -> intervalo da sondagem de comentarios IG (def. 60).
// =============================================================================

import crypto from "node:crypto";
import {
  matchRule,
  claimAutomation,
  finishAutomation,
  setEventLink,
  getSetting,
  setSetting,
} from "./db.js";

// URL público desta app (para os links rastreados /r/{token}).
// O Render define RENDER_EXTERNAL_URL sozinho; PUBLIC_URL é o override manual.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "";
// Pode conter VÁRIAS chaves separadas por vírgula (uma app para o Facebook,
// outra para o Instagram — cada webhook chega assinado com a chave da sua app).
// Validamos contra qualquer uma delas.
const META_APP_SECRETS = (process.env.META_APP_SECRET || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PAGE_ID = process.env.PAGE_ID || "";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";

// -----------------------------------------------------------------------------
//  INSTAGRAM pelo caminho da PÁGINA (graph.facebook.com + PAGE_ACCESS_TOKEN).
//
//  Porque assim e nao com graph.instagram.com: a Meta so entrega WEBHOOKS de
//  comentarios do Instagram a apps com Advanced Access (exige App Review). Mas
//  LER comentarios, RESPONDER e mandar DM funciona sem isso — desde que se use
//  o token da PAGINA ligada a conta. E o que fazemos: lemos os comentarios por
//  sondagem (polling) em vez de esperar pelo webhook, e respondemos na mesma.
//
//  O token da Pagina vem de um "Usuario do Sistema" do negocio, por isso nao
//  expira nem morre quando se troca de perfil pessoal.
// -----------------------------------------------------------------------------

/** Id da conta de Instagram ligada a Pagina (descoberto e guardado na BD). */
let igUserId = null;
async function getIgUserId() {
  if (igUserId) return igUserId;
  const cached = getSetting("ig_user_id");
  if (cached) {
    igUserId = cached;
    return igUserId;
  }
  if (!PAGE_ID || !PAGE_ACCESS_TOKEN) return "";
  try {
    const res = await fetch(
      `${GRAPH}/${PAGE_ID}?fields=instagram_business_account&access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`
    );
    const data = await res.json().catch(() => ({}));
    const id = data?.instagram_business_account?.id || "";
    if (id) {
      setSetting("ig_user_id", id);
      igUserId = id;
    }
    return id;
  } catch (err) {
    console.error("[social] getIgUserId:", err.message);
    return "";
  }
}

/**
 * Mantido por compatibilidade: o token da Pagina nao expira, por isso nao ha
 * nada para renovar. (O servidor ainda chama isto no arranque.)
 */
export async function refreshIgToken() {
  return { ok: true, skipped: true, reason: "page token nao expira" };
}

/** Ha configuracao suficiente para responder no Instagram? */
export function igConfigured() {
  return Boolean(PAGE_ID && PAGE_ACCESS_TOKEN);
}
/** Ha configuracao suficiente para responder no Facebook? */
export function fbConfigured() {
  return Boolean(PAGE_ACCESS_TOKEN);
}

// -----------------------------------------------------------------------------
//  Limitador de RITMO das respostas. Serializa os envios à Graph API e garante
//  um intervalo mínimo entre eles: instantâneo quando há pouco movimento, mas
//  nos picos espaça as respostas (em vez de centenas em rajada) — é o que
//  evita que a Meta marque a app como spam. Ajustável com REPLY_MIN_GAP_MS.
// -----------------------------------------------------------------------------
const REPLY_MIN_GAP_MS = Number(process.env.REPLY_MIN_GAP_MS) || 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sendChain = Promise.resolve();
let lastSendStart = 0;
function rateLimited(fn) {
  const out = sendChain.then(async () => {
    const wait = lastSendStart + REPLY_MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastSendStart = Date.now();
    return fn();
  });
  sendChain = out.then(
    () => {},
    () => {}
  );
  return out;
}

// -----------------------------------------------------------------------------
//  1) Verificacao do webhook (GET) — devolve o hub.challenge se o token bate.
// -----------------------------------------------------------------------------
export function metaVerifyChallenge(query = {}) {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode === "subscribe" && token && META_VERIFY_TOKEN && token === META_VERIFY_TOKEN) {
    return challenge;
  }
  return null;
}

// -----------------------------------------------------------------------------
//  2) Assinatura do POST (X-Hub-Signature-256) — HMAC-SHA256 do corpo cru.
//     Sem App Secret configurado, aceita (util so em desenvolvimento) — mesma
//     filosofia do webhook do Stripe quando nao ha segredo definido.
// -----------------------------------------------------------------------------
export function verifyMetaSignature(rawBody, header) {
  if (META_APP_SECRETS.length === 0) return true; // dev: sem segredo, nao valida
  if (!header || !header.startsWith("sha256=")) return false;
  const a = Buffer.from(header);
  for (const secret of META_APP_SECRETS) {
    try {
      const expected =
        "sha256=" +
        crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch (err) {
      console.error("[social] verifyMetaSignature:", err.message);
    }
  }
  return false;
}

// -----------------------------------------------------------------------------
//  Chamadas de baixo nivel a Graph API. Todas devolvem { ok, id?, error? }.
//  ATENCAO aos hosts: tokens do "Instagram Login" (IGAA...) so funcionam em
//  graph.instagram.com; os da Pagina de Facebook em graph.facebook.com.
// -----------------------------------------------------------------------------

async function graphPost(base, pathSegment, params, token) {
  try {
    const body = new URLSearchParams({ ...params, access_token: token });
    const res = await fetch(`${base}/${pathSegment}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const msg = data.error?.message || `HTTP ${res.status}`;
      return { ok: false, error: msg };
    }
    return { ok: true, id: data.id, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Diagnóstico dos tokens: confirma se os tokens atuais (do ambiente do servidor)
 * ainda são válidos junto da Meta. Usado por GET /api/diag.
 */
export async function diagnostics() {
  const out = { ig: { configured: igConfigured() }, fb: { configured: fbConfigured() } };
  if (out.ig.configured) {
    try {
      const id = await getIgUserId();
      if (!id) throw new Error("conta IG nao encontrada na Pagina");
      const r = await fetch(
        `${GRAPH}/${id}?fields=username&access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`
      );
      const d = await r.json().catch(() => ({}));
      out.ig.valid = !d.error;
      out.ig.username = d.username || null;
      if (d.error) out.ig.error = d.error.message;
    } catch (e) { out.ig.valid = false; out.ig.error = e.message; }
  }
  if (out.fb.configured) {
    try {
      const r = await fetch(`${GRAPH}/me?fields=name&access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`);
      const d = await r.json().catch(() => ({}));
      out.fb.valid = !d.error;
      out.fb.name = d.name || null;
      if (d.error) out.fb.error = d.error.message;
    } catch (e) { out.fb.valid = false; out.fb.error = e.message; }
  }
  return out;
}

/** Facebook: resposta publica a um comentario da Pagina (passa pelo limitador). */
export function fbReplyToComment(commentId, message) {
  if (!fbConfigured()) return Promise.resolve({ ok: false, error: "FB nao configurado" });
  return rateLimited(() => graphPost(GRAPH, `${commentId}/comments`, { message }, PAGE_ACCESS_TOKEN));
}

/**
 * Facebook: DM (private reply) ao autor do comentario, pelo Messenger.
 * Serve para os LINKS: em comentarios de ANUNCIOS o Facebook nao torna os
 * links clicaveis, mas no Messenger sao. Mesmas regras da Meta que no
 * Instagram: janela de 7 dias e so 1x por comentario.
 * Precisa da permissao `pages_messaging` no token da Pagina.
 */
export function fbPrivateReply(commentId, text) {
  if (!fbConfigured()) return Promise.resolve({ ok: false, error: "FB nao configurado" });
  return rateLimited(async () => {
    try {
      const res = await fetch(`${GRAPH}/${PAGE_ID}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { comment_id: commentId },
          message: { text },
          access_token: PAGE_ACCESS_TOKEN,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        return { ok: false, error: data.error?.message || `HTTP ${res.status}` };
      }
      return { ok: true, id: data.message_id };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

/** Instagram: resposta publica a um comentario (pelo token da Pagina). */
export function igReplyToComment(commentId, message) {
  if (!igConfigured()) return Promise.resolve({ ok: false, error: "IG nao configurado" });
  return rateLimited(() => graphPost(GRAPH, `${commentId}/replies`, { message }, PAGE_ACCESS_TOKEN));
}

/**
 * Ja nao se usa: os webhooks de comentarios do Instagram exigem Advanced
 * Access (App Review). Em vez disso lemos os comentarios por sondagem — ver
 * pollInstagramComments(). Mantido porque o servidor ainda expoe /api/ig/subscribe.
 */
export function igSubscribeApp() {
  return Promise.resolve({ ok: true, skipped: true, reason: "IG usa polling, nao webhooks" });
}

/**
 * Instagram: DM ao autor do comentario (private reply).
 * Janela de 7 dias e SO 1x por comentario (regra imposta pela Meta).
 * ATENCAO: tem MESMO de ser o token da PAGINA — com outros tokens a Meta
 * devolve um "unknown error" (code 1) que nao explica nada.
 */
export function igPrivateReply(commentId, text) {
  if (!igConfigured()) return Promise.resolve({ ok: false, error: "IG nao configurado" });
  return rateLimited(async () => {
    try {
      const res = await fetch(`${GRAPH}/${PAGE_ID}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { comment_id: commentId },
          message: { text },
          access_token: PAGE_ACCESS_TOKEN,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        return { ok: false, error: data.error?.message || `HTTP ${res.status}` };
      }
      return { ok: true, id: data.message_id };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

// -----------------------------------------------------------------------------
//  3) Processamento do webhook. Percorre entries/changes, faz match da
//     palavra-chave e dispara as respostas (com dedup atomico por comentario).
// -----------------------------------------------------------------------------
export async function processMetaWebhook(body) {
  if (!body || !Array.isArray(body.entry)) return;
  const object = body.object; // "instagram" | "page"
  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      try {
        if (object === "instagram" && change.field === "comments") {
          await handleInstagramComment(change.value);
        } else if (object === "page" && change.field === "feed") {
          await handleFacebookFeed(change.value);
        }
      } catch (err) {
        console.error("[social] change:", err.message);
      }
    }
  }
}

/**
 * Substitui {nome} (ou {name}) pelo nome de quem comentou.
 * Sem nome disponível, remove o marcador e arruma os espaços que sobram,
 * para "Olá {nome}!" degradar para "Olá!" e não "Olá !".
 */
export function applyTemplate(text, name) {
  if (!text) return text;
  const out = text.replace(/\{\s*(?:nome|name)\s*\}/gi, name || "");
  if (name) return out;
  return out.replace(/ {2,}/g, " ").replace(/ ([!?.,;:])/g, "$1").trim();
}

// Slug para o utm_source: "QUERO JÁ" -> "quero-ja".
function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/;

/**
 * Rastreio de cliques: se a resposta/DM tiver um link, troca-o por um link
 * nosso (/r/{token}) que regista quem abriu e redireciona para o destino JA
 * com utm_source automático ("ig-quero"), para a venda aparecer atribuída na
 * aba de fontes de tráfego do checkout. Sem link (ou sem URL público), não
 * mexe em nada. Devolve { reply, dm } com o link trocado.
 */
export function trackLinks({ reply, dm }, rule, platform, commentId) {
  if (!PUBLIC_URL) return { reply, dm };
  const m = `${reply || ""} ${dm || ""}`.match(URL_RE);
  if (!m) return { reply, dm };
  const original = m[0];
  const token = crypto.randomBytes(6).toString("base64url");

  // Acrescenta os utm ao destino (respeita os que o texto já tiver).
  // utm_content=rzo_{token} é o código ANÓNIMO do clique: o checkout devolve-o
  // no ping de conversão e é assim que ligamos a venda a este comentário.
  let dest = original;
  try {
    const u = new URL(original);
    const kw = String(rule.keyword || "").split(",")[0];
    if (!u.searchParams.get("utm_source")) u.searchParams.set("utm_source", `${platform}-${slugify(kw)}`);
    if (!u.searchParams.get("utm_medium")) u.searchParams.set("utm_medium", "replyzo");
    if (!u.searchParams.get("utm_content")) u.searchParams.set("utm_content", `rzo_${token}`);
    dest = u.toString();
  } catch {
    /* URL fora do normal: segue sem utm */
  }

  setEventLink(platform, commentId, token, dest);
  const tracked = `${PUBLIC_URL}/r/${token}`;
  const swap = (t) => (t ? t.split(original).join(tracked) : t);
  return { reply: swap(reply), dm: swap(dm) };
}

async function handleInstagramComment(value = {}) {
  const commentId = value.id;
  const text = value.text || "";
  const fromId = value.from?.id || "";
  if (!commentId || !text) return;
  // Ignora os nossos proprios comentarios/respostas (evita loop).
  const selfId = await getIgUserId();
  if (fromId && selfId && fromId === selfId) return;

  const rule = matchRule("ig", text);
  if (!rule) return;

  // No Instagram o que temos e o username (sem @; quem quiser mencionar
  // escreve "@{nome}" no texto da regra).
  const who = value.from?.username || "";

  // Dedup atomico: so o PRIMEIRO evento deste comentario avanca.
  if (!claimAutomation("ig", commentId, rule.id, { username: who, strategy: rule.strategy })) return;

  let reply = applyTemplate(rule.reply_public, who);
  let dm = applyTemplate(rule.dm_text, who);
  ({ reply, dm } = trackLinks({ reply, dm }, rule, "ig", commentId));

  let didPublic = 0;
  let didDm = 0;
  let ok = 1;
  const errors = [];

  if (reply) {
    const r = await igReplyToComment(commentId, reply);
    if (r.ok) didPublic = 1;
    else { ok = 0; errors.push("public: " + r.error); }
  }
  if (dm) {
    const r = await igPrivateReply(commentId, dm);
    if (r.ok) didDm = 1;
    else { ok = 0; errors.push("dm: " + r.error); }
  }

  finishAutomation("ig", commentId, {
    did_public: didPublic,
    did_dm: didDm,
    ok,
    error: errors.join(" | ") || null,
  });
}

// -----------------------------------------------------------------------------
//  SONDAGEM (polling) dos comentarios do Instagram.
//  Substitui o webhook (que exige Advanced Access): de X em X segundos vamos
//  buscar os comentarios novos das publicacoes recentes e tratamos cada um
//  exatamente como se tivesse chegado por webhook. O dedup e o mesmo
//  (claimAutomation), por isso nunca respondemos duas vezes ao mesmo
//  comentario, mesmo que ele apareca em varias sondagens.
// -----------------------------------------------------------------------------
const IG_POLL_MEDIA = Number(process.env.IG_POLL_MEDIA) || 5; // publicacoes a vigiar
const IG_POLL_COMMENTS = Number(process.env.IG_POLL_COMMENTS) || 50; // comentarios por publicacao

async function graphGet(pathSegment, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: PAGE_ACCESS_TOKEN });
  const res = await fetch(`${GRAPH}/${pathSegment}?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error(data.error.message || "erro Graph");
  return data;
}

/**
 * Vai buscar os comentarios recentes e responde aos que fazem match.
 * Na PRIMEIRA vez nao responde a nada — apenas marca o momento de arranque,
 * para nao disparar centenas de respostas a comentarios antigos.
 */
export async function pollInstagramComments() {
  if (!igConfigured()) return { ok: false, error: "IG nao configurado" };
  const igId = await getIgUserId();
  if (!igId) return { ok: false, error: "conta IG nao encontrada na Pagina" };

  // Marco temporal: so tratamos comentarios feitos DEPOIS disto.
  let since = Number(getSetting("ig_poll_since")) || 0;
  const firstRun = !since;
  if (firstRun) {
    since = Math.floor(Date.now() / 1000);
    setSetting("ig_poll_since", String(since));
    console.log("[ig-poll] primeira sondagem — a partir de agora respondemos so a comentarios NOVOS.");
    return { ok: true, firstRun: true, since };
  }

  let seen = 0;
  let handled = 0;
  try {
    const media = await graphGet(`${igId}/media`, { fields: "id", limit: String(IG_POLL_MEDIA) });
    for (const m of media.data || []) {
      let comments;
      try {
        comments = await graphGet(`${m.id}/comments`, {
          fields: "id,text,username,timestamp,from",
          limit: String(IG_POLL_COMMENTS),
        });
      } catch (err) {
        console.error("[ig-poll] comentarios de", m.id, "->", err.message);
        continue;
      }
      for (const c of comments.data || []) {
        seen++;
        const ts = Math.floor(new Date(c.timestamp || 0).getTime() / 1000);
        if (!ts || ts <= since) continue; // antigo: ja tratado (ou anterior ao arranque)
        handled++;
        await handleInstagramComment({
          id: c.id,
          text: c.text,
          from: { id: c.from?.id, username: c.username || c.from?.username },
        });
      }
    }
  } catch (err) {
    return { ok: false, error: err.message, seen, handled };
  }
  // Avanca o marco, mas deixa 5 min de sobreposicao: se algum comentario
  // chegar fora de ordem, ainda o apanhamos na sondagem seguinte (e o dedup
  // impede resposta repetida).
  setSetting("ig_poll_since", String(Math.floor(Date.now() / 1000) - 300));
  return { ok: true, seen, handled };
}

async function handleFacebookFeed(value = {}) {
  // So nos interessam comentarios NOVOS (nao likes, posts, edicoes).
  if (value.item !== "comment" || value.verb !== "add") return;
  const commentId = value.comment_id;
  const text = value.message || "";
  const fromId = value.from?.id || "";
  if (!commentId || !text) return;
  // Ignora comentarios da propria Pagina (evita responder a nos proprios).
  if (fromId && PAGE_ID && fromId === PAGE_ID) return;

  const rule = matchRule("fb", text);
  if (!rule) return;

  // No Facebook vem o nome completo; para o {nome} usamos so o primeiro.
  const fullName = (value.from?.name || "").trim();
  const who = fullName.split(/\s+/)[0] || "";

  if (!claimAutomation("fb", commentId, rule.id, { username: fullName, strategy: rule.strategy })) return;

  let reply = applyTemplate(rule.reply_public, who);
  let dm = applyTemplate(rule.dm_text, who);
  ({ reply, dm } = trackLinks({ reply, dm }, rule, "fb", commentId));

  let didPublic = 0;
  let didDm = 0;
  let ok = 1;
  const errors = [];

  if (reply) {
    const r = await fbReplyToComment(commentId, reply);
    if (r.ok) didPublic = 1;
    else { ok = 0; errors.push("public: " + r.error); }
  }
  // DM pelo Messenger — é aqui que o link fica MESMO clicavel (nos comentarios
  // de anuncios o Facebook nao os torna clicaveis).
  if (dm) {
    const r = await fbPrivateReply(commentId, dm);
    if (r.ok) didDm = 1;
    else { ok = 0; errors.push("dm: " + r.error); }
  }

  finishAutomation("fb", commentId, {
    did_public: didPublic,
    did_dm: didDm,
    ok,
    error: errors.join(" | ") || null,
  });
}
