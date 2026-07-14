// =============================================================================
//  Servidor — respostas automaticas a comentarios (o "ManyChat" caseiro).
// -----------------------------------------------------------------------------
//  - Recebe webhooks da Meta (Instagram + Facebook) em /webhooks/meta.
//  - Faz match de palavras-chave e responde: FB = comentario publico;
//    IG = comentario publico + DM (private reply).
//  - Dashboard em /dashboard (senha via DASHBOARD_PASS).
// =============================================================================

import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  listAutomationEvents,
  automationStats,
} from "./lib/db.js";
import {
  metaVerifyChallenge,
  verifyMetaSignature,
  processMetaWebhook,
  igConfigured,
  fbConfigured,
} from "./lib/social.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4300;

// -----------------------------------------------------------------------------
//  Senha do dashboard. Define DASHBOARD_PASS no .env. Se nao definires, geramos
//  uma aleatoria no arranque e mostramo-la aqui no terminal (visivel so a ti).
// -----------------------------------------------------------------------------
const DASHBOARD_PASS =
  process.env.DASHBOARD_PASS || crypto.randomBytes(6).toString("hex");
const DASHBOARD_PASS_GENERATED = !process.env.DASHBOARD_PASS;

// -----------------------------------------------------------------------------
//  Webhook da Meta (Instagram + Facebook).
//  GET  -> handshake de verificacao (devolve hub.challenge).
//  POST -> recebe eventos de comentario. Precisa do corpo CRU para validar a
//          assinatura, por isso fica aqui, antes do express.json().
// -----------------------------------------------------------------------------
app.get("/webhooks/meta", (req, res) => {
  const challenge = metaVerifyChallenge(req.query);
  if (challenge) return res.status(200).send(challenge);
  console.warn("[meta] verificacao falhou (verify_token nao bate).");
  return res.sendStatus(403);
});

app.post("/webhooks/meta", express.raw({ type: "application/json" }), (req, res) => {
  if (!verifyMetaSignature(req.body, req.get("x-hub-signature-256"))) {
    console.warn("[meta] assinatura invalida — evento ignorado.");
    return res.sendStatus(401);
  }
  let body;
  try {
    body = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.sendStatus(400);
  }
  // Responde JA (200) para a Meta nao repetir; processa a seguir sem bloquear.
  res.sendStatus(200);
  processMetaWebhook(body).catch((err) =>
    console.error("[meta] processMetaWebhook:", err.message)
  );
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Health check (usado pelo Render).
app.get("/health", (_req, res) => res.json({ ok: true }));

// -----------------------------------------------------------------------------
//  Autenticacao do dashboard (cabecalho x-dash-key, comparacao em tempo
//  constante para nao dar pistas por timing).
// -----------------------------------------------------------------------------
function requireDash(req, res, next) {
  const provided = String(req.get("x-dash-key") || "");
  const expected = DASHBOARD_PASS;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: "Nao autorizado." });
  next();
}

// -----------------------------------------------------------------------------
//  API de gestao das regras (todas exigem a senha do dashboard).
// -----------------------------------------------------------------------------

// Estado + lista de regras + últimos eventos + contagens (KPIs).
app.get("/api/automation", requireDash, (_req, res) => {
  res.json({
    igConfigured: igConfigured(),
    fbConfigured: fbConfigured(),
    rules: listRules(),
    events: listAutomationEvents({ limit: 100 }),
    stats: automationStats(),
  });
});

// Criar OU atualizar uma regra. Sem `id` -> cria; com `id` -> atualiza.
app.post("/api/automation/rules", requireDash, (req, res) => {
  const b = req.body || {};
  const platform = b.platform === "fb" ? "fb" : b.platform === "ig" ? "ig" : null;
  if (!b.id && (!platform || !String(b.keyword || "").trim())) {
    return res.status(400).json({ ok: false, error: "Faltam 'platform' (ig|fb) e 'keyword'." });
  }
  // Facebook só faz resposta pública (sem DM) — descarta dm_text por segurança.
  const dm_text = platform === "fb" ? "" : b.dm_text || "";
  if (b.id) {
    const ok = updateRule(b.id, {
      ...(b.platform ? { platform } : {}),
      ...(b.keyword != null ? { keyword: b.keyword } : {}),
      ...(b.match_type != null ? { match_type: b.match_type } : {}),
      ...(b.reply_public != null ? { reply_public: b.reply_public } : {}),
      ...(b.dm_text != null ? { dm_text } : {}),
      ...(b.active != null ? { active: b.active } : {}),
    });
    return res.json({ ok, rule: getRule(b.id) });
  }
  const id = createRule({
    platform,
    keyword: b.keyword,
    match_type: b.match_type || "contains",
    reply_public: b.reply_public || "",
    dm_text,
    active: b.active != null ? b.active : 1,
  });
  if (!id) return res.status(500).json({ ok: false, error: "Não foi possível criar a regra." });
  res.json({ ok: true, rule: getRule(id) });
});

// Apagar uma regra.
app.delete("/api/automation/rules/:id", requireDash, (req, res) => {
  const ok = deleteRule(req.params.id);
  res.json({ ok });
});

// Dashboard (o HTML/JS sao publicos; os DADOS exigem a senha acima).
app.get(["/", "/dashboard"], (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.listen(PORT, () => {
  console.log(`✔ ManyChat caseiro a correr em http://localhost:${PORT}`);
  console.log(`  Dashboard:  http://localhost:${PORT}/dashboard`);
  console.log(`  Webhook:    http://localhost:${PORT}/webhooks/meta`);
  if (DASHBOARD_PASS_GENERATED) {
    console.log(`  Senha do dashboard (gerada agora): ${DASHBOARD_PASS}`);
  } else {
    console.log("  Senha do dashboard: (definida no .env)");
  }
  if (!igConfigured()) console.log("  [aviso] Instagram por configurar (IG_USER_ID / IG_ACCESS_TOKEN).");
  if (!fbConfigured()) console.log("  [aviso] Facebook por configurar (PAGE_ACCESS_TOKEN).");
});
