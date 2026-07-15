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
//    IG_USER_ID          -> id da conta Instagram (Business/Creator).
//    IG_ACCESS_TOKEN     -> token de acesso da conta Instagram.
//    PAGE_ID             -> id da Pagina de Facebook.
//    PAGE_ACCESS_TOKEN   -> token de acesso da Pagina de Facebook.
// =============================================================================

import crypto from "node:crypto";
import {
  matchRule,
  claimAutomation,
  finishAutomation,
  setEventLink,
} from "./db.js";

// URL público desta app (para os links rastreados /r/{token}).
// O Render define RENDER_EXTERNAL_URL sozinho; PUBLIC_URL é o override manual.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";

const IG_USER_ID = process.env.IG_USER_ID || "";
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || "";
const PAGE_ID = process.env.PAGE_ID || "";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";

/** Ha configuracao suficiente para responder no Instagram? */
export function igConfigured() {
  return Boolean(IG_USER_ID && IG_ACCESS_TOKEN);
}
/** Ha configuracao suficiente para responder no Facebook? */
export function fbConfigured() {
  return Boolean(PAGE_ACCESS_TOKEN);
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
  if (!META_APP_SECRET) return true; // dev: sem segredo, nao valida
  if (!header || !header.startsWith("sha256=")) return false;
  try {
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", META_APP_SECRET).update(rawBody).digest("hex");
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (err) {
    console.error("[social] verifyMetaSignature:", err.message);
    return false;
  }
}

// -----------------------------------------------------------------------------
//  Chamadas de baixo nivel a Graph API. Todas devolvem { ok, id?, error? }.
//  ATENCAO aos hosts: tokens do "Instagram Login" (IGAA...) so funcionam em
//  graph.instagram.com; os da Pagina de Facebook em graph.facebook.com.
// -----------------------------------------------------------------------------
const IG_GRAPH = `https://graph.instagram.com/${GRAPH_VERSION}`;

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

/** Facebook: resposta publica a um comentario da Pagina. */
export function fbReplyToComment(commentId, message) {
  if (!fbConfigured()) return Promise.resolve({ ok: false, error: "FB nao configurado" });
  return graphPost(GRAPH, `${commentId}/comments`, { message }, PAGE_ACCESS_TOKEN);
}

/** Instagram: resposta publica a um comentario. */
export function igReplyToComment(commentId, message) {
  if (!igConfigured()) return Promise.resolve({ ok: false, error: "IG nao configurado" });
  return graphPost(IG_GRAPH, `${commentId}/replies`, { message }, IG_ACCESS_TOKEN);
}

/**
 * Instagram: subscreve a CONTA aos webhooks de comentarios. A Meta exige isto
 * alem da subscricao da app (e idempotente — pode chamar-se a vontade).
 */
export function igSubscribeApp() {
  if (!igConfigured()) return Promise.resolve({ ok: false, error: "IG nao configurado" });
  return graphPost(IG_GRAPH, "me/subscribed_apps", { subscribed_fields: "comments" }, IG_ACCESS_TOKEN);
}

/**
 * Instagram: DM ao autor do comentario (private reply).
 * Janela de 7 dias e SO 1x por comentario (regra imposta pela Meta).
 */
export async function igPrivateReply(commentId, text) {
  if (!igConfigured()) return { ok: false, error: "IG nao configurado" };
  try {
    const res = await fetch(`${IG_GRAPH}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: { text },
        access_token: IG_ACCESS_TOKEN,
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
  if (fromId && IG_USER_ID && fromId === IG_USER_ID) return;

  const rule = matchRule("ig", text);
  if (!rule) return;

  // No Instagram o que temos e o username (sem @; quem quiser mencionar
  // escreve "@{nome}" no texto da regra).
  const who = value.from?.username || "";

  // Dedup atomico: so o PRIMEIRO evento deste comentario avanca.
  if (!claimAutomation("ig", commentId, rule.id, { username: who })) return;

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

  if (!claimAutomation("fb", commentId, rule.id, { username: fullName })) return;

  let reply = applyTemplate(rule.reply_public, who);
  ({ reply } = trackLinks({ reply }, rule, "fb", commentId));

  let didPublic = 0;
  let ok = 1;
  let error = null;

  if (reply) {
    const r = await fbReplyToComment(commentId, reply);
    if (r.ok) didPublic = 1;
    else { ok = 0; error = r.error; }
  }

  finishAutomation("fb", commentId, { did_public: didPublic, did_dm: 0, ok, error });
}
