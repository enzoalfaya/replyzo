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
} from "./db.js";

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
// -----------------------------------------------------------------------------
async function graphPost(pathSegment, params, token) {
  try {
    const body = new URLSearchParams({ ...params, access_token: token });
    const res = await fetch(`${GRAPH}/${pathSegment}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const msg = data.error?.message || `HTTP ${res.status}`;
      return { ok: false, error: msg };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Facebook: resposta publica a um comentario da Pagina. */
export function fbReplyToComment(commentId, message) {
  if (!fbConfigured()) return Promise.resolve({ ok: false, error: "FB nao configurado" });
  return graphPost(`${commentId}/comments`, { message }, PAGE_ACCESS_TOKEN);
}

/** Instagram: resposta publica a um comentario. */
export function igReplyToComment(commentId, message) {
  if (!igConfigured()) return Promise.resolve({ ok: false, error: "IG nao configurado" });
  return graphPost(`${commentId}/replies`, { message }, IG_ACCESS_TOKEN);
}

/**
 * Instagram: DM ao autor do comentario (private reply).
 * Janela de 7 dias e SO 1x por comentario (regra imposta pela Meta).
 */
export async function igPrivateReply(commentId, text) {
  if (!igConfigured()) return { ok: false, error: "IG nao configurado" };
  try {
    const res = await fetch(`${GRAPH}/${IG_USER_ID}/messages`, {
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

async function handleInstagramComment(value = {}) {
  const commentId = value.id;
  const text = value.text || "";
  const fromId = value.from?.id || "";
  if (!commentId || !text) return;
  // Ignora os nossos proprios comentarios/respostas (evita loop).
  if (fromId && IG_USER_ID && fromId === IG_USER_ID) return;

  const rule = matchRule("ig", text);
  if (!rule) return;

  // Dedup atomico: so o PRIMEIRO evento deste comentario avanca.
  if (!claimAutomation("ig", commentId, rule.id)) return;

  let didPublic = 0;
  let didDm = 0;
  let ok = 1;
  const errors = [];

  if (rule.reply_public) {
    const r = await igReplyToComment(commentId, rule.reply_public);
    if (r.ok) didPublic = 1;
    else { ok = 0; errors.push("public: " + r.error); }
  }
  if (rule.dm_text) {
    const r = await igPrivateReply(commentId, rule.dm_text);
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

  if (!claimAutomation("fb", commentId, rule.id)) return;

  let didPublic = 0;
  let ok = 1;
  let error = null;

  if (rule.reply_public) {
    const r = await fbReplyToComment(commentId, rule.reply_public);
    if (r.ok) didPublic = 1;
    else { ok = 0; error = r.error; }
  }

  finishAutomation("fb", commentId, { did_public: didPublic, did_dm: 0, ok, error });
}
