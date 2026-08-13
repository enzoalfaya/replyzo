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
  recordLinkClick,
  recordFunnelStep,
  getEventByToken,
  resetClicks,
  markConversion,
  backfillEventStrategies,
} from "./lib/db.js";
import {
  metaVerifyChallenge,
  verifyMetaSignature,
  processMetaWebhook,
  igConfigured,
  fbConfigured,
  igSubscribeApp,
  refreshIgToken,
  pollInstagramComments,
  listMedia,
  diagnostics,
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

// Registo em memoria dos ultimos webhooks recebidos. Serve para diagnosticar
// "a Meta esta mesmo a entregar isto?" — visivel em GET /api/webhooks/recent.
const RECENT_HOOKS = [];
// Contadores CUMULATIVOS (nunca apagados) — o buffer de 80 é enchido pelo FB e
// podia esconder um webhook IG por evicção. Isto conta a verdade desde o arranque.
const HOOK_TOTALS = { since: new Date().toISOString(), byObject: {}, lastIgAt: null };
function noteHook(info) {
  RECENT_HOOKS.unshift({ at: new Date().toISOString(), ...info });
  if (RECENT_HOOKS.length > 80) RECENT_HOOKS.length = 80;
  const obj = info.object || "desconhecido";
  HOOK_TOTALS.byObject[obj] = (HOOK_TOTALS.byObject[obj] || 0) + 1;
  if (obj === "instagram") HOOK_TOTALS.lastIgAt = new Date().toISOString();
}

app.post("/webhooks/meta", express.raw({ type: "application/json" }), (req, res) => {
  const sigOk = verifyMetaSignature(req.body, req.get("x-hub-signature-256"));
  let peek = null;
  try {
    peek = JSON.parse(req.body.toString("utf8"));
  } catch {
    /* corpo nao-JSON: fica registado na mesma, abaixo */
  }
  noteHook({
    sigOk,
    sig: req.get("x-hub-signature-256") || null,
    object: peek?.object || null,
    fields: (peek?.entry || []).flatMap((e) => (e.changes || []).map((c) => c.field)),
    raw: req.body.toString("utf8").slice(0, 4000),
  });

  if (!sigOk) {
    console.warn("[meta] assinatura invalida — evento ignorado.");
    return res.sendStatus(401);
  }
  const body = peek;
  if (!body) return res.sendStatus(400);
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

// Link rastreado enviado nas respostas/DMs: regista a abertura e redireciona
// para o destino (que ja leva o utm_source para a atribuicao no checkout).
// BOTS (a Meta abre todos os links para gerar a pre-visualizacao!) recebem o
// redirect na mesma, mas NAO contam como clique — senao todo o link aparecia
// "aberto" segundos depois de enviado.
const BOT_UA_RE =
  /bot|crawl|spider|preview|scan|fetch|facebookexternalhit|facebot|meta-externalagent|whatsapp|telegram|skype|slack|discord|curl|wget|python|axios|headless/i;
const isBot = (ua) => !ua || BOT_UA_RE.test(ua);

app.get("/r/:token", (req, res) => {
  const ua = String(req.get("user-agent") || "");
  const ev = isBot(ua) ? getEventByToken(req.params.token) : recordLinkClick(req.params.token);
  if (!ev || !ev.link_url) return res.status(404).send("Este link já não está disponível.");
  res.redirect(302, ev.link_url);
});

// Beacon do funil: /px.js (no teu site) chama isto quando alguém clica em
// "ver as 500 receitas" (step=cta) ou chega à página de vendas (step=sales).
// Responde sempre com um GIF 1x1 transparente. Ignora bots (não executam JS,
// mas filtramos na mesma por segurança).
const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
// GET (Image) e POST (navigator.sendBeacon) — os dados vão nos query params.
app.all("/t", (req, res) => {
  if (!isBot(String(req.get("user-agent") || ""))) {
    const token = String(req.query.token || "").replace(/^rzo_/, "").trim();
    const step = String(req.query.step || "");
    if (token && (step === "cta" || step === "sales")) recordFunnelStep(token, step);
  }
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store");
  res.end(PIXEL_GIF);
});

// Limpa TODAS as contagens de cliques (para zerar falsos positivos antigos).
app.post("/api/clicks/reset", requireDash, (_req, res) => {
  res.json({ ok: resetClicks() });
});

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
  // O Facebook TAMBEM manda DM agora (Messenger) — e alias a unica forma de o
  // link ficar clicavel em comentarios de anuncios.
  const dm_text = b.dm_text || "";
  if (b.id) {
    const ok = updateRule(b.id, {
      ...(b.platform ? { platform } : {}),
      ...(b.keyword != null ? { keyword: b.keyword } : {}),
      ...(b.match_type != null ? { match_type: b.match_type } : {}),
      ...(b.reply_public != null ? { reply_public: b.reply_public } : {}),
      ...(b.dm_text != null ? { dm_text } : {}),
      ...(b.active != null ? { active: b.active } : {}),
      ...(b.strategy != null ? { strategy: b.strategy } : {}),
      ...(b.step_label != null ? { step_label: b.step_label } : {}),
      ...(b.media_id != null ? { media_id: b.media_id } : {}),
    });
    // Etiquetar uma regra reclassifica logo os eventos antigos que ela gerou.
    backfillEventStrategies();
    return res.json({ ok, rule: getRule(b.id) });
  }
  const id = createRule({
    platform,
    keyword: b.keyword,
    match_type: b.match_type || "contains",
    reply_public: b.reply_public || "",
    dm_text,
    active: b.active != null ? b.active : 1,
    strategy: b.strategy || "",
    step_label: b.step_label || "",
    media_id: b.media_id || "",
  });
  if (!id) return res.status(500).json({ ok: false, error: "Não foi possível criar a regra." });
  backfillEventStrategies();
  res.json({ ok: true, rule: getRule(id) });
});

// Diagnóstico da saúde dos tokens (IG/FB ainda válidos junto da Meta?).
app.get("/api/diag", requireDash, async (_req, res) => {
  res.json(await diagnostics());
});

// Últimos webhooks que a Meta nos entregou (memória, desde o último arranque).
// Responde à pergunta "a Meta está mesmo a mandar os comentários do Instagram?".
app.get("/api/webhooks/recent", requireDash, (_req, res) => {
  const counts = {};
  for (const h of RECENT_HOOKS) {
    const k = `${h.object || "?"}:${h.fields?.join(",") || "?"}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  res.json({ totals: HOOK_TOTALS, total: RECENT_HOOKS.length, counts, hooks: RECENT_HOOKS });
});

// Apagar uma regra.
app.delete("/api/automation/rules/:id", requireDash, (req, res) => {
  const ok = deleteRule(req.params.id);
  res.json({ ok });
});

// (Re)subscreve a conta de Instagram aos webhooks de comentarios. Idempotente;
// util depois de trocar o token do Instagram.
app.post("/api/ig/subscribe", requireDash, async (_req, res) => {
  const r = await igSubscribeApp();
  res.status(r.ok ? 200 : 400).json(r);
});

// Forca uma sondagem imediata dos comentarios do Instagram (para testar sem
// esperar pelo intervalo). Devolve quantos comentarios viu e quantos tratou.
app.post("/api/ig/poll", requireDash, async (_req, res) => {
  const r = await pollInstagramComments();
  res.status(r.ok ? 200 : 400).json(r);
});

// Publicacoes recentes (com miniatura) para escolher a que a regra se aplica.
app.get("/api/media", requireDash, async (req, res) => {
  const platform = req.query.platform === "fb" ? "fb" : "ig";
  const r = await listMedia(platform, 24);
  res.status(r.ok ? 200 : 400).json(r);
});

// -----------------------------------------------------------------------------
//  Ping de conversao vindo do checkout: "o clique rzo_{token} comprou".
//  Autenticado com o segredo partilhado CONVERSION_SECRET (cabecalho
//  x-conversion-key). Idempotente — repeticoes nao duplicam a venda.
// -----------------------------------------------------------------------------
const CONVERSION_SECRET = process.env.CONVERSION_SECRET || "";

app.post("/api/conversion", (req, res) => {
  if (!CONVERSION_SECRET) return res.status(503).json({ ok: false, error: "CONVERSION_SECRET não definido." });
  const provided = Buffer.from(String(req.get("x-conversion-key") || ""));
  const expected = Buffer.from(CONVERSION_SECRET);
  const authOk = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  if (!authOk) return res.status(401).json({ ok: false, error: "Não autorizado." });

  const token = String(req.body?.token || "").replace(/^rzo_/, "").trim();
  if (!token) return res.status(400).json({ ok: false, error: "Falta o token." });
  const ev = markConversion(token, req.body?.amount);
  if (!ev) return res.status(404).json({ ok: false, error: "Token desconhecido." });
  console.log(`[conversion] 💰 venda atribuída a @${ev.username || "?"} (${ev.platform}, ${ev.comment_id})`);
  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
//  Paginas exigidas pela Meta para por a app em Live Mode.
// -----------------------------------------------------------------------------
const legalPage = (title, body) => `<!DOCTYPE html><html lang="pt-PT"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:680px;margin:0 auto;padding:40px 20px;line-height:1.65;color:#16182d}h1{font-size:24px}h2{font-size:17px;margin-top:26px}p{margin:10px 0}</style>
</head><body><h1>${title}</h1>${body}
<p style="margin-top:30px;color:#6b6e85;font-size:13px">Última atualização: julho de 2026.</p></body></html>`;

app.get("/privacy", (_req, res) => {
  res.send(legalPage("Política de Privacidade", `
<p>Esta aplicação («Replyzo») é uma ferramenta privada de gestão de comentários, utilizada exclusivamente pelo proprietário das contas de redes sociais a que está ligada.</p>
<h2>Dados tratados</h2>
<p>A aplicação recebe da Meta notificações de comentários públicos feitos nas publicações das contas ligadas (texto do comentário, nome de utilizador de quem comentou e identificadores técnicos). Estes dados são usados apenas para responder automaticamente ao comentário e/ou enviar uma mensagem direta a quem o escreveu.</p>
<h2>Conservação</h2>
<p>Guardamos apenas registos técnicos mínimos (identificador do comentário e resultado da resposta) para evitar respostas duplicadas. Não vendemos, partilhamos nem cedemos dados a terceiros.</p>
<h2>Contacto</h2>
<p>Para questões sobre privacidade ou para pedir a eliminação de dados, contacta o proprietário através da conta de Instagram ou Página de Facebook ligada a esta aplicação, ou consulta a página de <a href="/data-deletion">eliminação de dados</a>.</p>`));
});

app.get("/data-deletion", (_req, res) => {
  res.send(legalPage("Eliminação de Dados", `
<p>Esta aplicação guarda apenas registos técnicos mínimos sobre comentários públicos (identificador do comentário e resultado da resposta automática). Não guarda mensagens privadas nem dados de perfil.</p>
<h2>Como pedir a eliminação</h2>
<p>Envia uma mensagem direta à conta de Instagram ou Página de Facebook ligada a esta aplicação a pedir a eliminação dos teus registos, indicando o teu nome de utilizador. Os registos associados serão eliminados no prazo de 30 dias.</p>`));
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
  if (!igConfigured()) console.log("  [aviso] Instagram por configurar (PAGE_ID / PAGE_ACCESS_TOKEN).");
  if (!fbConfigured()) console.log("  [aviso] Facebook por configurar (PAGE_ACCESS_TOKEN).");

  // Reclassifica eventos antigos com a estratégia atual das regras.
  const n = backfillEventStrategies();
  if (n) console.log(`  [funil] ${n} eventos reclassificados por estratégia`);

  // -------------------------------------------------------------------------
  //  Instagram por SONDAGEM. A Meta so entrega webhooks de comentarios do
  //  Instagram a apps com Advanced Access (App Review), por isso vamos nos
  //  buscar os comentarios de X em X segundos. O Facebook continua por webhook.
  // -------------------------------------------------------------------------
  if (igConfigured()) {
    const cada = Math.max(20, Number(process.env.IG_POLL_SECONDS) || 60);
    const sondar = () =>
      pollInstagramComments()
        .then((r) => {
          if (!r.ok) console.warn(`  [ig-poll] falhou: ${r.error}`);
          else if (r.handled) console.log(`  [ig-poll] ${r.handled} comentario(s) novo(s) tratados`);
        })
        .catch((e) => console.error("  [ig-poll]", e.message));
    console.log(`  [ig] sondagem de comentarios a cada ${cada}s`);
    sondar();
    setInterval(sondar, cada * 1000);
  }
});
