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
export function createRule({ platform, keyword, match_type = "contains", reply_public = "", dm_text = "", active = 1 } = {}) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const info = db
      .prepare(
        `INSERT INTO automation_rules(platform, keyword, match_type, reply_public, dm_text, active, created, updated)
         VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(platform, keyword, match_type, reply_public || "", dm_text || "", active ? 1 : 0, now, now);
    return Number(info.lastInsertRowid);
  } catch (err) {
    console.error("[db] createRule:", err.message);
    return null;
  }
}

/** Atualiza campos de uma regra (só os fornecidos). Devolve true se mudou algo. */
export function updateRule(id, fields = {}) {
  const allowed = ["platform", "keyword", "match_type", "reply_public", "dm_text", "active"];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k} = ?`);
      params.push(k === "active" ? (fields[k] ? 1 : 0) : fields[k]);
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
 */
export function matchRule(platform, text) {
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
  for (const r of rules) {
    const variants = String(r.keyword || "").split(",").map(norm).filter(Boolean);
    for (const kw of variants) {
      const hit =
        r.match_type === "exact" ? t === kw :
        r.match_type === "starts" ? t.startsWith(kw) :
        t.includes(kw);
      if (hit) return r;
    }
  }
  return null;
}

// ----- Eventos (dedup + registo) ----------------------------------------------

/**
 * Reivindica o tratamento de um comentário. Insere o evento (chave
 * '{platform}:{comment_id}') e devolve TRUE só na PRIMEIRA vez. Se o comentário
 * já foi tratado (ou a Meta reenviou o webhook), devolve FALSE. Atómico.
 */
export function claimAutomation(platform, commentId, ruleId) {
  try {
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO automation_events(id, platform, comment_id, rule_id, created)
         VALUES(?,?,?,?,?)`
      )
      .run(`${platform}:${commentId}`, platform, commentId, Number(ruleId) || null, Math.floor(Date.now() / 1000));
    return info.changes > 0;
  } catch (err) {
    console.error("[db] claimAutomation:", err.message);
    return false;
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
                SUM(CASE WHEN created >= ? THEN 1 ELSE 0 END)   AS today
           FROM automation_events`
      )
      .get(todaySec);
    return {
      total: r.total || 0,
      dms: r.dms || 0,
      publics: r.publics || 0,
      errors: r.errors || 0,
      today: r.today || 0,
    };
  } catch (err) {
    console.error("[db] automationStats:", err.message);
    return { total: 0, dms: 0, publics: 0, errors: 0, today: 0 };
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
