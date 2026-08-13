// =============================================================================
//  Base de dados (SQLite, ficheiro data/social.db).
// -----------------------------------------------------------------------------
//  Usa o modulo nativo do Node (node:sqlite) — sem dependencias externas.
//  automation_rules  -> regras palavra-chave -> resposta (por plataforma).
//  automation_events -> registo por COMENTARIO, com dedup: a chave primaria
//                       '{plataforma}:{comment_id}' garante que respondemos SO
//                       1x por comentario (a Meta tambem so deixa 1 DM por
//                       comentario, para sempre).
// =============================================================================

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR configuravel (ex.: disco persistente do Render em producao).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "social.db"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS automation_rules (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    platform     TEXT NOT NULL,             -- 'ig' | 'fb'
    keyword      TEXT NOT NULL,             -- palavra/expressão a detetar
    match_type   TEXT DEFAULT 'contains',   -- 'contains' | 'exact' | 'starts'
    reply_public TEXT,                       -- resposta pública ao comentário
    dm_text      TEXT,                       -- DM/private reply (só Instagram)
    active       INTEGER DEFAULT 1,
    created      INTEGER NOT NULL,
    updated      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rules_platform ON automation_rules(platform, active);

  CREATE TABLE IF NOT EXISTS automation_events (
    id         TEXT PRIMARY KEY,   -- '{platform}:{comment_id}' (dedup)
    platform   TEXT,
    comment_id TEXT,
    rule_id    INTEGER,
    did_public INTEGER DEFAULT 0,
    did_dm     INTEGER DEFAULT 0,
    ok         INTEGER DEFAULT 1,
    error      TEXT,
    created    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_autoevents_created ON automation_events(created);
`);

// Migracoes: adiciona colunas a bases de dados antigas (ignora se ja existem).
// username    -> quem comentou (para mostrar no dashboard e saber quem clicou)
// link_token  -> token do link rastreado enviado na resposta/DM (/r/{token})
// link_url    -> destino original do link (para onde redirecionamos)
// clicks      -> quantas vezes o link foi aberto
// first_click -> epoch (segundos) da primeira abertura
for (const col of [
  "username TEXT",
  "link_token TEXT",
  "link_url TEXT",
  "clicks INTEGER DEFAULT 0",
  "first_click INTEGER",
  // Conversão (venda) atribuída a este clique, via ping do checkout:
  "purchased_at INTEGER",
  "purchase_amount INTEGER", // cêntimos
  // Etapas do funil na página da receita (via /px.js no site):
  "cta_clicks INTEGER DEFAULT 0",  // clicou "ver as 500 receitas"
  "sales_views INTEGER DEFAULT 0", // chegou à página de vendas
  // Estratégia/campanha (copiada da regra) — para separar funis (Receita/Quiz):
  "strategy TEXT",
]) {
  try {
    db.exec(`ALTER TABLE automation_events ADD COLUMN ${col}`);
  } catch {
    /* coluna ja existe */
  }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_autoevents_token ON automation_events(link_token)");

// Definições chave/valor (ex.: token IG renovado, para sobreviver a reinícios).
db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");

/** Lê uma definição (ou null). */
export function getSetting(key) {
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return r ? r.value : null;
  } catch {
    return null;
  }
}
/** Grava uma definição. */
export function setSetting(key, value) {
  try {
    db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, String(value));
  } catch (err) {
    console.error("[db] setSetting:", err.message);
  }
}

// Regras: estratégia (etiqueta que agrupa o funil) e nome do passo intermédio
// (ex.: "Clicaram ver as 500 receitas" vs "Concluíram o quiz").
// media_id: publicacao a que a regra se aplica ('' = todas as publicacoes).
// replies_json: várias respostas públicas (JSON). O servidor escolhe uma ao
// acaso — variar o texto reduz muito o risco de a Meta marcar como spam.
// once_per_user: responder só uma vez a cada pessoa (por regra).
for (const col of [
  "strategy TEXT DEFAULT ''",
  "step_label TEXT DEFAULT ''",
  "media_id TEXT DEFAULT ''",
  "replies_json TEXT DEFAULT ''",
  "once_per_user INTEGER DEFAULT 0",
]) {
  try {
    db.exec(`ALTER TABLE automation_rules ADD COLUMN ${col}`);
  } catch {
    /* coluna ja existe */
  }
}

// ----- Regras ----------------------------------------------------------------

/** Lista regras (opcionalmente por plataforma e/ou só ativas). */
export function listRules({ platform = "", activeOnly = false } = {}) {
  try {
    const where = [];
    const params = [];
    if (platform) { where.push("platform = ?"); params.push(platform); }
    if (activeOnly) where.push("active = 1");
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    return db.prepare(`SELECT * FROM automation_rules ${w} ORDER BY created DESC`).all(...params);
  } catch (err) {
    console.error("[db] listRules:", err.message);
    return [];
  }
}

/** Uma regra pelo id. */
export function getRule(id) {
  try {
    return db.prepare("SELECT * FROM automation_rules WHERE id = ?").get(Number(id)) || null;
  } catch {
    return null;
  }
}

/** Cria uma regra nova. Devolve o id criado (ou null). */
export function createRule({ platform, keyword, match_type = "contains", reply_public = "", dm_text = "", active = 1, strategy = "", step_label = "", media_id = "", replies_json = "", once_per_user = 0 } = {}) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const info = db
      .prepare(
        `INSERT INTO automation_rules(platform, keyword, match_type, reply_public, dm_text, active, strategy, step_label, media_id, replies_json, once_per_user, created, updated)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(platform, keyword, match_type, reply_public || "", dm_text || "", active ? 1 : 0, String(strategy || "").slice(0, 40), String(step_label || "").slice(0, 60), String(media_id || ""), String(replies_json || ""), once_per_user ? 1 : 0, now, now);
    return Number(info.lastInsertRowid);
  } catch (err) {
    console.error("[db] createRule:", err.message);
    return null;
  }
}

/** Atualiza campos de uma regra (só os fornecidos). Devolve true se mudou algo. */
export function updateRule(id, fields = {}) {
  const allowed = ["platform", "keyword", "match_type", "reply_public", "dm_text", "active", "strategy", "step_label", "media_id", "replies_json", "once_per_user"];
  const bool = new Set(["active", "once_per_user"]);
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k} = ?`);
      params.push(bool.has(k) ? (fields[k] ? 1 : 0) : fields[k]);
    }
  }
  if (!sets.length) return false;
  sets.push("updated = ?");
  params.push(Math.floor(Date.now() / 1000), Number(id));
  try {
    const info = db.prepare(`UPDATE automation_rules SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return info.changes > 0;
  } catch (err) {
    console.error("[db] updateRule:", err.message);
    return false;
  }
}

/** Apaga uma regra. */
export function deleteRule(id) {
  try {
    return db.prepare("DELETE FROM automation_rules WHERE id = ?").run(Number(id)).changes > 0;
  } catch (err) {
    console.error("[db] deleteRule:", err.message);
    return false;
  }
}

/** Normaliza para comparação: minúsculas, sem acentos, sem espaços à volta.
 *  Assim "Açúcar" casa com "ACUCAR" e "quero" com "QUERO". */
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/**
 * Encontra a PRIMEIRA regra ativa da plataforma cuja palavra-chave casa com o
 * texto do comentário. `match_type`: contains (defeito) | exact | starts.
 * A palavra-chave pode ter VARIAÇÕES separadas por vírgula ("QUERO, KERO") —
 * basta uma delas bater. Ignora maiúsculas e acentos.
 *
 * `mediaId` é a publicação onde o comentário foi feito. As regras presas a uma
 * publicação (media_id preenchido) só disparam nessa; as que têm media_id vazio
 * valem para todas. As específicas ganham sempre às gerais — assim podes ter
 * "receita" a apontar para links diferentes em publicações diferentes.
 */
export function matchRule(platform, text, mediaId = "") {
  const t = norm(text);
  if (!t) return null;
  let rules;
  try {
    rules = db
      .prepare("SELECT * FROM automation_rules WHERE platform = ? AND active = 1 ORDER BY created ASC")
      .all(platform);
  } catch (err) {
    console.error("[db] matchRule:", err.message);
    return null;
  }
  const casa = (r) => {
    const variants = String(r.keyword || "").split(",").map(norm).filter(Boolean);
    return variants.some((kw) =>
      r.match_type === "exact" ? t === kw :
      r.match_type === "starts" ? t.startsWith(kw) :
      t.includes(kw)
    );
  };
  // 1ª volta: regras desta publicacao. 2ª volta: regras gerais.
  if (mediaId) {
    for (const r of rules) if (r.media_id && r.media_id === mediaId && casa(r)) return r;
  }
  for (const r of rules) if (!r.media_id && casa(r)) return r;
  return null;
}

// ----- Eventos (dedup + registo) ----------------------------------------------

/**
 * Reivindica o tratamento de um comentário. Insere o evento (chave
 * '{platform}:{comment_id}') e devolve TRUE só na PRIMEIRA vez. Se o comentário
 * já foi tratado (ou a Meta reenviou o webhook), devolve FALSE. Atómico.
 */
export function claimAutomation(platform, commentId, ruleId, { username = "", strategy = "" } = {}) {
  try {
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO automation_events(id, platform, comment_id, rule_id, username, strategy, created)
         VALUES(?,?,?,?,?,?,?)`
      )
      .run(
        `${platform}:${commentId}`,
        platform,
        commentId,
        Number(ruleId) || null,
        String(username || "").slice(0, 80),
        String(strategy || "").slice(0, 40),
        Math.floor(Date.now() / 1000)
      );
    return info.changes > 0;
  } catch (err) {
    console.error("[db] claimAutomation:", err.message);
    return false;
  }
}

/**
 * Esta pessoa ja foi atendida por esta regra? Usado pela opcao "responder a
 * cada pessoa so uma vez" — evita encher de respostas quem comenta varias vezes.
 */
export function jaAtendido(ruleId, username) {
  if (!ruleId || !username) return false;
  try {
    return Boolean(
      db
        .prepare("SELECT 1 FROM automation_events WHERE rule_id = ? AND username = ? LIMIT 1")
        .get(Number(ruleId), String(username))
    );
  } catch {
    return false;
  }
}

// ----- Links rastreados (/r/{token}) ------------------------------------------

/** Associa um link rastreado ao evento (token único + destino original). */
export function setEventLink(platform, commentId, token, url) {
  try {
    db.prepare("UPDATE automation_events SET link_token = ?, link_url = ? WHERE id = ?")
      .run(token, String(url).slice(0, 500), `${platform}:${commentId}`);
  } catch (err) {
    console.error("[db] setEventLink:", err.message);
  }
}

/** Evento pelo token do link (para o redirecionamento). */
export function getEventByToken(token) {
  try {
    return db.prepare("SELECT * FROM automation_events WHERE link_token = ?").get(String(token)) || null;
  } catch {
    return null;
  }
}

/**
 * Marca a conversão (venda) do clique com este token. Idempotente: só a
 * PRIMEIRA chamada conta — repetições do webhook não duplicam a venda.
 * Devolve o evento atualizado, ou null se o token não existir.
 */
export function markConversion(token, amountCents) {
  try {
    const ev = getEventByToken(token);
    if (!ev) return null;
    db.prepare(
      `UPDATE automation_events
          SET purchased_at = COALESCE(purchased_at, ?),
              purchase_amount = COALESCE(purchase_amount, ?)
        WHERE id = ?`
    ).run(Math.floor(Date.now() / 1000), Math.max(0, Number(amountCents) || 0), ev.id);
    return getEventByToken(token);
  } catch (err) {
    console.error("[db] markConversion:", err.message);
    return null;
  }
}

/**
 * Reclassifica eventos antigos sem estratégia com a estratégia ATUAL da regra
 * que os gerou (via rule_id). Idempotente — só toca em eventos sem estratégia
 * cujo rule tem uma definida. Devolve quantos foram reclassificados.
 */
export function backfillEventStrategies() {
  try {
    const info = db
      .prepare(
        `UPDATE automation_events
            SET strategy = (SELECT r.strategy FROM automation_rules r WHERE r.id = automation_events.rule_id)
          WHERE (strategy IS NULL OR strategy = '')
            AND rule_id IN (SELECT id FROM automation_rules WHERE strategy IS NOT NULL AND strategy <> '')`
      )
      .run();
    return info.changes || 0;
  } catch (err) {
    console.error("[db] backfillEventStrategies:", err.message);
    return 0;
  }
}

/** Zera todas as contagens de cliques (limpeza de falsos positivos de bots). */
export function resetClicks() {
  try {
    db.exec("UPDATE automation_events SET clicks = 0, first_click = NULL");
    return true;
  } catch (err) {
    console.error("[db] resetClicks:", err.message);
    return false;
  }
}

/** Regista uma abertura do link. Devolve o evento (ou null se token inválido). */
export function recordLinkClick(token) {
  try {
    const ev = getEventByToken(token);
    if (!ev) return null;
    db.prepare(
      "UPDATE automation_events SET clicks = COALESCE(clicks,0) + 1, first_click = COALESCE(first_click, ?) WHERE id = ?"
    ).run(Math.floor(Date.now() / 1000), ev.id);
    return ev;
  } catch (err) {
    console.error("[db] recordLinkClick:", err.message);
    return null;
  }
}

/**
 * Regista uma etapa do funil na página da receita/vendas (via /px.js).
 *  step "cta"   -> clicou "ver as 500 receitas"
 *  step "sales" -> chegou à página de vendas
 * Devolve o evento, ou null se o token não existir.
 */
export function recordFunnelStep(token, step) {
  const col = step === "cta" ? "cta_clicks" : step === "sales" ? "sales_views" : null;
  if (!col) return null;
  try {
    const ev = getEventByToken(token);
    if (!ev) return null;
    db.prepare(`UPDATE automation_events SET ${col} = COALESCE(${col},0) + 1 WHERE id = ?`).run(ev.id);
    return ev;
  } catch (err) {
    console.error("[db] recordFunnelStep:", err.message);
    return null;
  }
}

/** Regista o resultado do tratamento de um comentário (após responder). */
export function finishAutomation(platform, commentId, { did_public = 0, did_dm = 0, ok = 1, error = null } = {}) {
  try {
    db.prepare(
      `UPDATE automation_events SET did_public = ?, did_dm = ?, ok = ?, error = ? WHERE id = ?`
    ).run(did_public ? 1 : 0, did_dm ? 1 : 0, ok ? 1 : 0, error, `${platform}:${commentId}`);
  } catch (err) {
    console.error("[db] finishAutomation:", err.message);
  }
}

/** Contagens agregadas para os KPIs do dashboard. */
export function automationStats() {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todaySec = Math.floor(startOfDay.getTime() / 1000);
    const r = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(did_dm), 0)     AS dms,
                COALESCE(SUM(did_public), 0) AS publics,
                SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END)         AS errors,
                SUM(CASE WHEN created >= ? THEN 1 ELSE 0 END)   AS today,
                SUM(CASE WHEN link_token IS NOT NULL THEN 1 ELSE 0 END) AS with_link,
                SUM(CASE WHEN COALESCE(clicks,0) > 0 THEN 1 ELSE 0 END) AS clicked,
                SUM(CASE WHEN COALESCE(cta_clicks,0) > 0 THEN 1 ELSE 0 END) AS cta,
                SUM(CASE WHEN COALESCE(sales_views,0) > 0 THEN 1 ELSE 0 END) AS sales,
                SUM(CASE WHEN purchased_at IS NOT NULL THEN 1 ELSE 0 END) AS purchases,
                COALESCE(SUM(purchase_amount), 0) AS revenue
           FROM automation_events`
      )
      .get(todaySec);
    // Repartição do funil por estratégia (Receita, Quiz, ...). Eventos sem
    // estratégia entram como "Geral".
    const perStrat = db
      .prepare(
        `SELECT COALESCE(NULLIF(strategy,''),'Geral') AS strategy,
                SUM(CASE WHEN link_token IS NOT NULL THEN 1 ELSE 0 END) AS with_link,
                SUM(CASE WHEN COALESCE(clicks,0) > 0 THEN 1 ELSE 0 END) AS clicked,
                SUM(CASE WHEN COALESCE(cta_clicks,0) > 0 THEN 1 ELSE 0 END) AS cta,
                SUM(CASE WHEN COALESCE(sales_views,0) > 0 THEN 1 ELSE 0 END) AS sales,
                SUM(CASE WHEN purchased_at IS NOT NULL THEN 1 ELSE 0 END) AS purchases,
                COALESCE(SUM(purchase_amount), 0) AS revenue
           FROM automation_events
          WHERE link_token IS NOT NULL
          GROUP BY 1 ORDER BY with_link DESC`
      )
      .all();
    // Nome do passo intermédio por estratégia (o mais recente definido numa regra).
    const labelRows = db
      .prepare(
        `SELECT COALESCE(NULLIF(strategy,''),'Geral') AS strategy, step_label
           FROM automation_rules WHERE step_label <> '' ORDER BY updated DESC`
      )
      .all();
    const labelMap = {};
    for (const row of labelRows) if (!(row.strategy in labelMap)) labelMap[row.strategy] = row.step_label;

    const byStrategy = perStrat.map((p) => ({
      strategy: p.strategy,
      stepLabel: labelMap[p.strategy] || "",
      withLink: p.with_link || 0,
      clicked: p.clicked || 0,
      cta: p.cta || 0,
      sales: p.sales || 0,
      purchases: p.purchases || 0,
      revenue: p.revenue || 0,
    }));

    // Junta estratégias definidas em regras que ainda não têm eventos, para o
    // seletor aparecer assim que etiquetas uma automação (mesmo sem dados).
    const present = new Set(byStrategy.map((x) => x.strategy));
    const ruleStrats = db
      .prepare("SELECT DISTINCT strategy FROM automation_rules WHERE strategy IS NOT NULL AND strategy <> ''")
      .all();
    for (const { strategy } of ruleStrats) {
      if (!present.has(strategy)) {
        byStrategy.push({ strategy, stepLabel: labelMap[strategy] || "", withLink: 0, clicked: 0, cta: 0, sales: 0, purchases: 0, revenue: 0 });
      }
    }

    return {
      total: r.total || 0,
      dms: r.dms || 0,
      publics: r.publics || 0,
      errors: r.errors || 0,
      today: r.today || 0,
      withLink: r.with_link || 0,
      clicked: r.clicked || 0,
      cta: r.cta || 0,
      sales: r.sales || 0,
      purchases: r.purchases || 0,
      revenue: r.revenue || 0,
      byStrategy,
    };
  } catch (err) {
    console.error("[db] automationStats:", err.message);
    return { total: 0, dms: 0, publics: 0, errors: 0, today: 0, withLink: 0, clicked: 0, cta: 0, sales: 0, purchases: 0, revenue: 0, byStrategy: [] };
  }
}

/** Últimos eventos de automação (para o dashboard). */
export function listAutomationEvents({ limit = 60 } = {}) {
  try {
    return db
      .prepare("SELECT * FROM automation_events ORDER BY created DESC LIMIT ?")
      .all(Number(limit) || 60);
  } catch (err) {
    console.error("[db] listAutomationEvents:", err.message);
    return [];
  }
}
