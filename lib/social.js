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
  jaAtendido,
  jaTratadoComentario,
  finishAutomation,
  setEventLink,
  getSetting,
  setSetting,
  listRules,
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
// 5s entre envios: com 2,5s a Meta travava ("reduza a quantidade de dados").
// Sobe este valor (REPLY_MIN_GAP_MS) se voltar a travar em picos de comentarios.
const REPLY_MIN_GAP_MS = Number(process.env.REPLY_MIN_GAP_MS) || 5000;
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

// -----------------------------------------------------------------------------
//  Erros PASSAGEIROS da Meta. Quando ha muitos pedidos seguidos, a Meta trava
//  e devolve mensagens que nao explicam nada ("reduza a quantidade de dados",
//  "unknown error"). Nao e o nosso pedido que esta mal — basta esperar e
//  repetir. Sem isto, cada travagem destas perdia um comentario para sempre.
// -----------------------------------------------------------------------------
const CODIGOS_PASSAGEIROS = new Set([1, 2, 4, 17, 32, 341, 613]);
function ePassageiro(err = {}) {
  if (CODIGOS_PASSAGEIROS.has(Number(err.code))) return true;
  if (err.is_transient) return true;
  const m = String(err.message || "").toLowerCase();
  return (
    m.includes("reduce the amount of data") ||
    m.includes("please retry") ||
    m.includes("try again") ||
    m.includes("rate limit") ||
    m.includes("temporarily")
  );
}

/** Repete o envio quando a Meta trava, esperando cada vez mais entre tentativas. */
async function comRetry(fn, tentativas = 3) {
  let ultimo = { ok: false, error: "sem resposta" };
  for (let i = 0; i < tentativas; i++) {
    ultimo = await fn();
    if (ultimo.ok || !ultimo.passageiro) return ultimo;
    if (i < tentativas - 1) await sleep(2000 * Math.pow(2, i)); // 2s, 4s
  }
  return ultimo;
}

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
      return { ok: false, error: msg, passageiro: ePassageiro(data.error || {}) };
    }
    return { ok: true, id: data.id, data };
  } catch (err) {
    return { ok: false, error: err.message, passageiro: true };
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
  return rateLimited(() =>
    comRetry(() => graphPost(GRAPH, `${commentId}/comments`, { message }, PAGE_ACCESS_TOKEN))
  );
}

/**
 * Facebook: DM (private reply) ao autor do comentario, pelo Messenger.
 * Serve para os LINKS: em comentarios de ANUNCIOS o Facebook nao torna os
 * links clicaveis, mas no Messenger sao. Mesmas regras da Meta que no
 * Instagram: janela de 7 dias e so 1x por comentario.
 * Precisa da permissao `pages_messaging` no token da Pagina.
 */
export function fbPrivateReply(commentId, dm) {
  if (!fbConfigured()) return Promise.resolve({ ok: false, error: "FB nao configurado" });
  return enviarDm(commentId, dm);
}

/** Instagram: resposta publica a um comentario (pelo token da Pagina). */
export function igReplyToComment(commentId, message) {
  if (!igConfigured()) return Promise.resolve({ ok: false, error: "IG nao configurado" });
  return rateLimited(() =>
    comRetry(() => graphPost(GRAPH, `${commentId}/replies`, { message }, PAGE_ACCESS_TOKEN))
  );
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
 * Monta o corpo da mensagem: texto simples ou "template de botao" (uma
 * mensagem com um botao clicavel). O botao e util porque fica bem mais
 * visivel do que um link no meio do texto.
 */
function buildMessage(dm) {
  if (typeof dm === "string") return { text: dm };
  const { text = "", button } = dm || {};
  if (!button?.url) return { text };
  return {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text: text || " ",
        buttons: [
          {
            type: "web_url",
            url: button.url,
            // A Meta corta titulos de botao com mais de 20 caracteres.
            title: String(button.label || "Abrir").slice(0, 20),
          },
        ],
      },
    },
  };
}

/** Envia a DM (private reply) pelo token da PAGINA — serve IG e FB. */
function enviarDm(commentId, dm) {
  return rateLimited(() =>
    comRetry(async () => {
      try {
        const res = await fetch(`${GRAPH}/${PAGE_ID}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipient: { comment_id: commentId },
            message: buildMessage(dm),
            access_token: PAGE_ACCESS_TOKEN,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          return {
            ok: false,
            error: data.error?.message || `HTTP ${res.status}`,
            passageiro: ePassageiro(data.error || {}),
          };
        }
        return { ok: true, id: data.message_id };
      } catch (err) {
        return { ok: false, error: err.message, passageiro: true };
      }
    })
  );
}

/**
 * Instagram: DM ao autor do comentario (private reply).
 * Janela de 7 dias e SO 1x por comentario (regra imposta pela Meta).
 * ATENCAO: tem MESMO de ser o token da PAGINA — com outros tokens a Meta
 * devolve um "unknown error" (code 1) que nao explica nada.
 */
export function igPrivateReply(commentId, dm) {
  if (!igConfigured()) return Promise.resolve({ ok: false, error: "IG nao configurado" });
  return enviarDm(commentId, dm);
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
/**
 * Escolhe UMA das respostas publicas da regra, ao acaso. Variar o texto e o
 * que evita que a Meta veja centenas de comentarios identicos e marque como
 * spam. Se so houver uma resposta, devolve essa.
 */
export function pickReply(rule = {}) {
  let lista = [];
  try {
    const j = JSON.parse(rule.replies_json || "[]");
    if (Array.isArray(j)) lista = j.map((s) => String(s || "").trim()).filter(Boolean);
  } catch {
    /* json invalido: ignora e usa o reply_public */
  }
  if (!lista.length) return rule.reply_public || "";
  return lista[Math.floor(Math.random() * lista.length)];
}

export function applyTemplate(text, name) {
  if (!text) return text;
  if (name) return text.replace(/\{\s*(?:nome|name)\s*\}/gi, name);
  // Sem nome: tira o marcador E o que ficava pendurado a volta dele, senao
  // "Ola, {nome}!" virava "Ola,!" (ja aconteceu em mensagens reais).
  return text
    .replace(/[ \t]*,?[ \t]*\{\s*(?:nome|name)\s*\}/gi, "")
    .replace(/ {2,}/g, " ")
    .replace(/ ([!?.,;:])/g, "$1")
    .trim();
}

/**
 * Mencao CLICAVEL de quem comentou. Cada rede tem a sua forma:
 *   - Instagram: "@username" — o proprio Instagram torna isto clicavel.
 *   - Facebook:  "@[id]" — sintaxe da Graph API; com o nome nao fica clicavel.
 * Sem dados suficientes, devolve o nome simples (ou nada) para o texto nao
 * ficar estranho.
 */
export function buildMention(platform, { id, username, name } = {}) {
  if (platform === "ig") return username ? `@${username}` : name || "";
  return id ? `@[${id}]` : name || "";
}

/** Substitui {nome} e {mencao} no texto (a mencao primeiro). */
export function aplicarVars(text, { nome = "", mencao = "" } = {}) {
  if (!text) return text;
  // Sem mencao, leva consigo a pontuacao que ficava pendurada ("{mencao}, ola"
  // nao pode virar ", ola").
  const marca = mencao
    ? /[ \t]*\{\s*(?:men[cç][aã]o|mention)\s*\}/gi
    : /[ \t]*\{\s*(?:men[cç][aã]o|mention)\s*\}[ \t]*,?/gi;
  const out = mencao ? text.replace(marca, ` ${mencao}`) : text.replace(marca, "");
  return applyTemplate(out.replace(/^[\s,]+/, ""), nome);
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
export function trackLinks({ reply, dm, btnUrl }, rule, platform, commentId) {
  if (!PUBLIC_URL) return { reply, dm, btnUrl };
  // O link do BOTAO manda; se nao houver botao, usa-se o 1º link do texto.
  const m = `${reply || ""} ${dm || ""}`.match(URL_RE);
  const original = btnUrl || (m ? m[0] : null);
  if (!original) return { reply, dm, btnUrl };
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
  return { reply: swap(reply), dm: swap(dm), btnUrl: btnUrl ? tracked : btnUrl };
}

async function handleInstagramComment(value = {}, mediaId = "") {
  const commentId = value.id;
  const text = value.text || "";
  const fromId = value.from?.id || "";
  if (!commentId || !text) return;
  // Ignora os nossos proprios comentarios/respostas (evita loop).
  const selfId = await getIgUserId();
  if (fromId && selfId && fromId === selfId) return;

  const rule = matchRule("ig", text, mediaId || value.media?.id || "");
  if (!rule) return;

  // No Instagram o que temos e o username (sem @; quem quiser mencionar
  // escreve "@{nome}" no texto da regra).
  const who = value.from?.username || "";

  // "Responder a cada pessoa so uma vez": se ja a atendemos, ignora.
  if (rule.once_per_user && jaAtendido(rule.id, who)) return;

  // Dedup atomico: so o PRIMEIRO evento deste comentario avanca.
  if (!claimAutomation("ig", commentId, rule.id, { username: who, strategy: rule.strategy })) return;

  const mencao = buildMention("ig", { username: who });
  let reply = aplicarVars(pickReply(rule), { nome: who, mencao });
  let dm = aplicarVars(rule.dm_text, { nome: who, mencao });
  let btnUrl = rule.dm_kind === "button" ? rule.dm_btn_url || "" : "";
  ({ reply, dm, btnUrl } = trackLinks({ reply, dm, btnUrl }, rule, "ig", commentId));
  const dmPayload = btnUrl ? { text: dm, button: { url: btnUrl, label: rule.dm_btn_label } } : dm;

  let didPublic = 0;
  let didDm = 0;
  let ok = 1;
  const errors = [];

  if (reply) {
    const r = await igReplyToComment(commentId, reply);
    if (r.ok) didPublic = 1;
    else { ok = 0; errors.push("public: " + r.error); }
  }
  if (dm || btnUrl) {
    const r = await igPrivateReply(commentId, dmPayload);
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
// ORCAMENTO DE CHAMADAS: a Meta permite ~200 chamadas/hora a uma app normal.
// Cada sondagem gasta 1 (lista de publicacoes) + IG_POLL_MEDIA (comentarios).
// Com 5 publicacoes de 60 em 60s dava 360 chamadas/hora — quase o DOBRO do
// limite — e era isso que fazia a Meta bloquear a conta repetidamente.
// Agora: 1+3 = 4 chamadas a cada 180s = 80/hora, deixando folga para as
// respostas e DMs (que tambem gastam chamadas).
// Vigiar so as publicacoes mais recentes deixava de fora as regras presas a
// publicacoes antigas (que continuam a receber comentarios). Solucao:
//   - as N mais RECENTES sao vistas em TODAS as sondagens (e onde chega o
//     grosso dos comentarios, e queremos resposta rapida);
//   - as publicacoes que tem regra propria entram a vez (rotacao), para todas
//     serem cobertas sem estourar o orcamento de chamadas.
const IG_POLL_MEDIA = Number(process.env.IG_POLL_MEDIA) || 3; // recentes, sempre
// Com o consumo real medido em ~1% dos limites, ha folga de sobra: vemos
// TODAS as publicacoes que tem regra em cada sondagem (0 = sem rotacao).
const IG_POLL_ROTATE = Number(process.env.IG_POLL_ROTATE) || 0; // 0 = todas
const IG_POLL_COMMENTS = Number(process.env.IG_POLL_COMMENTS) || 25; // comentarios por publicacao
// Maximo de respostas por sondagem. Depois de uma paragem longa acumulam-se
// muitos comentarios; sem este travao sairiam todos numa rajada e a Meta
// voltava a bloquear. Assim, o atraso escoa aos poucos (12 a cada 3 min).
const IG_POLL_MAX = Number(process.env.IG_POLL_MAX) || 40;

// Quando a Meta bloqueia, insistir so piora. Ficamos quietos um bocado.
const PAUSA_APOS_BLOQUEIO_MS = 30 * 60 * 1000;
let pausadoAte = 0;
function estaBloqueado(msg = "") {
  return /api access blocked|application request limit|rate limit/i.test(String(msg));
}

// -----------------------------------------------------------------------------
//  CONSUMO REAL dos limites da Meta. Ela devolve em cada resposta a
//  percentagem ja gasta (0-100). Guardamos o ultimo valor para o /api/diag —
//  assim decide-se o ritmo com dados, em vez de suposicoes.
// -----------------------------------------------------------------------------
let ultimoUso = { at: null, app: null, buc: null };
function anotarUso(res) {
  try {
    const app = res.headers.get("x-app-usage");
    const buc = res.headers.get("x-business-use-case-usage");
    if (!app && !buc) return;
    ultimoUso = {
      at: new Date().toISOString(),
      app: app ? JSON.parse(app) : ultimoUso.app,
      buc: buc ? JSON.parse(buc) : ultimoUso.buc,
    };
  } catch {
    /* cabecalho estranho: ignora */
  }
}
/** Percentagem mais alta de qualquer limite (o que interessa vigiar). */
export function usoMeta() {
  const nums = [];
  if (ultimoUso.app) nums.push(Number(ultimoUso.app.call_count) || 0);
  for (const arr of Object.values(ultimoUso.buc || {})) {
    for (const x of arr || []) nums.push(Number(x.call_count) || 0);
  }
  return { ...ultimoUso, pico: nums.length ? Math.max(...nums) : null };
}

async function graphGet(pathSegment, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: PAGE_ACCESS_TOKEN });
  const res = await fetch(`${GRAPH}/${pathSegment}?${qs}`);
  anotarUso(res);
  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error(data.error.message || "erro Graph");
  return data;
}

/**
 * Lista as publicacoes recentes (com miniatura) para o dashboard deixar
 * escolher a que a automacao se aplica.
 */
export async function listMedia(platform = "ig", limit = 24) {
  if (!fbConfigured()) return { ok: false, error: "nao configurado" };
  try {
    if (platform === "ig") {
      const igId = await getIgUserId();
      if (!igId) return { ok: false, error: "conta IG nao encontrada na Pagina" };
      const d = await graphGet(`${igId}/media`, {
        fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count",
        limit: String(limit),
      });
      return {
        ok: true,
        media: (d.data || []).map((m) => ({
          id: m.id,
          caption: (m.caption || "").slice(0, 120),
          thumb: m.thumbnail_url || m.media_url || "",
          permalink: m.permalink || "",
          timestamp: m.timestamp || "",
          comments: m.comments_count ?? null,
          type: m.media_type || "",
        })),
      };
    }
    const d = await graphGet(`${PAGE_ID}/posts`, {
      fields: "id,message,full_picture,permalink_url,created_time,comments.summary(true).limit(0)",
      limit: String(limit),
    });
    return {
      ok: true,
      media: (d.data || []).map((p) => ({
        id: p.id,
        caption: (p.message || "").slice(0, 120),
        thumb: p.full_picture || "",
        permalink: p.permalink_url || "",
        timestamp: p.created_time || "",
        comments: p.comments?.summary?.total_count ?? null,
        type: "POST",
      })),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Vai buscar os comentarios recentes e responde aos que fazem match.
 * Na PRIMEIRA vez nao responde a nada — apenas marca o momento de arranque,
 * para nao disparar centenas de respostas a comentarios antigos.
 */
export async function pollInstagramComments() {
  if (!igConfigured()) return { ok: false, error: "IG nao configurado" };
  // Em pausa por bloqueio da Meta: nem tentamos (insistir so agrava).
  if (Date.now() < pausadoAte) {
    return { ok: true, pausado: true, retomaEm: Math.round((pausadoAte - Date.now()) / 60000) + " min" };
  }
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
  let limiteAtingido = false; // travou no total desta sondagem
  let sobrou = false; // alguma publicacao ficou com atraso por escoar
  try {
    const media = await graphGet(`${igId}/media`, { fields: "id", limit: String(IG_POLL_MEDIA) });
    const recentes = (media.data || []).map((m) => m.id);

    // Publicacoes com regra propria que NAO estao entre as recentes: entram a
    // vez, algumas por sondagem, ate darem a volta toda.
    const comRegra = [
      ...new Set(
        listRules({ platform: "ig", activeOnly: true })
          .map((r) => r.media_id)
          .filter((id) => id && !recentes.includes(id))
      ),
    ];
    // IG_POLL_ROTATE = 0 -> todas de uma vez (temos folga nos limites).
    let rotativas = comRegra;
    if (IG_POLL_ROTATE > 0 && comRegra.length > IG_POLL_ROTATE) {
      rotativas = [];
      const inicio = Number(getSetting("ig_poll_idx")) || 0;
      for (let i = 0; i < IG_POLL_ROTATE; i++) {
        rotativas.push(comRegra[(inicio + i) % comRegra.length]);
      }
      setSetting("ig_poll_idx", String((inicio + rotativas.length) % comRegra.length));
    }

    const alvos = [...recentes, ...rotativas].map((id) => ({ id }));
    // Reparte o orcamento por publicacao. Sem isto, uma publicacao com muito
    // atraso acumulado gastava os 12 lugares todos e as outras nunca eram
    // respondidas (aconteceu: so o "mirtilo" saia, o resto ficava parado).
    const porPublicacao = Math.max(2, Math.floor(IG_POLL_MAX / Math.max(1, alvos.length)));

    for (const m of alvos) {
      if (limiteAtingido) break;
      let nesta = 0;
      let comments;
      try {
        comments = await graphGet(`${m.id}/comments`, {
          fields: "id,text,username,timestamp,from",
          limit: String(IG_POLL_COMMENTS),
        });
      } catch (err) {
        if (estaBloqueado(err.message)) throw err; // bloqueio: para tudo ja
        console.error("[ig-poll] comentarios de", m.id, "->", err.message);
        continue;
      }
      for (const c of comments.data || []) {
        seen++;
        const ts = Math.floor(new Date(c.timestamp || 0).getTime() / 1000);
        if (!ts || ts <= since) continue; // antigo: ja tratado (ou anterior ao arranque)
        if (handled >= IG_POLL_MAX) { limiteAtingido = true; break; }
        // Cota desta publicacao esgotada: passa a SEGUINTE (nao para tudo),
        // e marca que ficou atraso para a sondagem seguinte.
        if (nesta >= porPublicacao) { sobrou = true; break; }
        nesta++;
        handled++;
        await handleInstagramComment(
          {
            id: c.id,
            text: c.text,
            from: { id: c.from?.id, username: c.username || c.from?.username },
          },
          m.id
        );
      }
    }
  } catch (err) {
    if (estaBloqueado(err.message)) {
      pausadoAte = Date.now() + PAUSA_APOS_BLOQUEIO_MS;
      console.warn(`[ig-poll] Meta bloqueou — pausa de ${PAUSA_APOS_BLOQUEIO_MS / 60000} min antes de tentar outra vez.`);
    }
    return { ok: false, error: err.message, seen, handled };
  }
  // So avanca o marco se tratamos TUDO o que havia. Se batemos no limite,
  // fica onde esta para a sondagem seguinte continuar o atraso de onde ficou
  // (o dedup impede repetir os que ja foram).
  if (!limiteAtingido && !sobrou) {
    // Deixa 5 min de sobreposicao: se algum comentario chegar fora de ordem,
    // ainda o apanhamos na sondagem seguinte.
    setSetting("ig_poll_since", String(Math.floor(Date.now() / 1000) - 300));
  }
  return { ok: true, seen, handled, limiteAtingido, sobrou };
}

// -----------------------------------------------------------------------------
//  Recuperar comentarios ANTIGOS de uma publicacao (os que ficaram por
//  responder antes de a automacao existir).
//
//  Corre sempre em simulacao (dryRun) por defeito: primeiro diz-se quantos
//  seriam afetados, so depois se envia. Isto e importante porque um envio em
//  massa e exatamente o que faz a Meta travar (ou pior, marcar como spam).
//
//  Nota da Meta: a DM (private reply) so e possivel ate 7 DIAS depois do
//  comentario. Mais velhos que isso so levam resposta publica.
// -----------------------------------------------------------------------------
const JANELA_DM_SEG = 7 * 86400;

export async function backfillComments(platform, mediaId, { limit = 30, dryRun = true } = {}) {
  if (!mediaId) return { ok: false, error: "falta a publicacao" };
  if (!fbConfigured()) return { ok: false, error: "nao configurado" };

  // ATENCAO a dois detalhes que ja deram asneira:
  //  1) por defeito a Meta devolve os comentarios MAIS ANTIGOS primeiro; sem
  //     `reverse_chronological` apanhavamos os velhos (ja respondidos) e
  //     deixavamos os de hoje por tratar;
  //  2) `comment_count` diz se o comentario JA TEM resposta — inclusive uma
  //     dada a mao ou por outra ferramenta, que a nossa base de dados
  //     desconhece. Sem isto, responde-se duas vezes a mesma pessoa.
  const campos =
    platform === "ig"
      ? "id,text,username,timestamp,from,replies.limit(1){id}"
      : "id,message,created_time,from,comment_count";
  let comentarios = [];
  try {
    const d = await graphGet(`${mediaId}/comments`, {
      fields: campos,
      limit: "100",
      order: "reverse_chronological",
    });
    comentarios = d.data || [];
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const agora = Math.floor(Date.now() / 1000);
  const selfId = platform === "ig" ? await getIgUserId() : PAGE_ID;
  const candidatos = [];
  let semRegra = 0;
  let jaTratados = 0;
  let jaRespondidos = 0;
  let foraJanela = 0;

  for (const c of comentarios) {
    const texto = (platform === "ig" ? c.text : c.message) || "";
    const autor = c.from?.id || "";
    if (!texto || (autor && selfId && autor === selfId)) continue;

    const regra = matchRule(platform, texto, mediaId);
    if (!regra) { semRegra++; continue; }
    if (jaTratadoComentario(platform, c.id)) { jaTratados++; continue; }

    // Ja tem alguma resposta la (nossa, tua ou de outra ferramenta)? Nao mexe.
    const temResposta =
      platform === "ig" ? Boolean(c.replies?.data?.length) : Number(c.comment_count || 0) > 0;
    if (temResposta) { jaRespondidos++; continue; }

    const ts = Math.floor(new Date((platform === "ig" ? c.timestamp : c.created_time) || 0).getTime() / 1000);
    const idade = ts ? agora - ts : Infinity;
    const podeDm = idade <= JANELA_DM_SEG;
    if (!podeDm) foraJanela++;

    candidatos.push({ c, regra, texto, podeDm });
  }

  const aTratar = candidatos.slice(0, limit);
  const resumo = {
    ok: true,
    dryRun,
    vistos: comentarios.length,
    semRegra,
    jaTratados,
    jaRespondidos,
    elegiveis: candidatos.length,
    foraJanelaDm: foraJanela,
    aTratarAgora: aTratar.length,
    porRegra: {},
  };
  for (const x of candidatos) {
    const k = String(x.regra.keyword || "").split(",")[0].trim();
    resumo.porRegra[k] = (resumo.porRegra[k] || 0) + 1;
  }
  if (dryRun) return resumo;

  // Envio a serio — passa pelo mesmo caminho de sempre (limitador de ritmo,
  // dedup e registo incluidos), por isso e seguro e fica tudo na Atividade.
  let feitos = 0;
  for (const { c } of aTratar) {
    if (platform === "ig") {
      await handleInstagramComment(
        { id: c.id, text: c.text, from: { id: c.from?.id, username: c.username || c.from?.username } },
        mediaId
      );
    } else {
      await handleFacebookFeed({
        item: "comment",
        verb: "add",
        comment_id: c.id,
        message: c.message,
        from: c.from,
        post_id: mediaId,
      });
    }
    feitos++;
  }
  resumo.tratados = feitos;
  return resumo;
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

  const rule = matchRule("fb", text, value.post_id || "");
  if (!rule) return;

  // No Facebook vem o nome completo; para o {nome} usamos so o primeiro.
  const fullName = (value.from?.name || "").trim();
  const who = fullName.split(/\s+/)[0] || "";

  if (rule.once_per_user && jaAtendido(rule.id, fullName)) return;

  if (!claimAutomation("fb", commentId, rule.id, { username: fullName, strategy: rule.strategy })) return;

  const mencao = buildMention("fb", { id: fromId, name: fullName });
  let reply = aplicarVars(pickReply(rule), { nome: who, mencao });
  let dm = aplicarVars(rule.dm_text, { nome: who, mencao });
  let btnUrl = rule.dm_kind === "button" ? rule.dm_btn_url || "" : "";
  ({ reply, dm, btnUrl } = trackLinks({ reply, dm, btnUrl }, rule, "fb", commentId));
  const dmPayload = btnUrl ? { text: dm, button: { url: btnUrl, label: rule.dm_btn_label } } : dm;

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
  if (dm || btnUrl) {
    const r = await fbPrivateReply(commentId, dmPayload);
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
