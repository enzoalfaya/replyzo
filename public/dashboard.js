/* =========================================================================
   Replyzo — logica do cliente.
   - Porta de entrada por senha (guardada em sessionStorage).
   - Le /api/automation com o cabecalho x-dash-key.
   - Vistas: overview | automations | activity | connections.
   - Editor em modal com pre-visualizacao ao vivo (bolhas de chat).
   ========================================================================= */

const KEY_STORE = "social_key_v1";

const gate = document.getElementById("gate");
const app = document.getElementById("app");
const mainView = document.getElementById("main-view");

let data = null; // ultimo payload de /api/automation
let currentView = "overview";
let editingId = null; // id da regra em edicao (null = nova)
let armedDelete = null; // { id, timer } — apagar em dois passos
let funnelStrategy = null; // estratégia selecionada no funil (null = todas)
let periodo = 0; // dias que as métricas abrangem (0 = desde sempre)

const VIEW_TITLES = {
  overview: ["Visão geral", "Comentários → resposta + DM, em piloto automático"],
  automations: ["Automações", "Palavras-chave e o que acontece quando alguém as comenta"],
  activity: ["Atividade", "Todos os comentários tratados, do mais recente ao mais antigo"],
  connections: ["Ligações", "Estado das contas Instagram e Facebook"],
};
const MATCH_NAMES = { contains: "contém", exact: "exato", starts: "começa por" };

const IG_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2.5" y="2.5" width="19" height="19" rx="5.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="17.6" cy="6.4" r="1.3" fill="currentColor" stroke="none"/></svg>`;
const FB_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 8.5V6.8c0-.8.5-1 1.2-1H17V2.5h-2.6C11.7 2.5 10.5 4 10.5 6.4v2.1H8v3.4h2.5v9.6H14v-9.6h2.6l.4-3.4H14z"/></svg>`;
const pbadge = (p) => `<span class="pbadge ${p === "ig" ? "ig" : "fb"}">${p === "ig" ? IG_SVG : FB_SVG}</span>`;

// ---- Arranque ---------------------------------------------------------------
function boot() {
  bindChrome();
  const key = sessionStorage.getItem(KEY_STORE);
  if (key) {
    app.hidden = false;
    load();
  } else {
    showGate();
  }
}

function showGate(errMsg) {
  gate.hidden = false;
  app.hidden = true;
  document.getElementById("gate-err").textContent = errMsg || "";
  const form = document.getElementById("gate-form");
  form.onsubmit = (e) => {
    e.preventDefault();
    const pass = document.getElementById("gate-pass").value.trim();
    if (!pass) return;
    sessionStorage.setItem(KEY_STORE, pass);
    gate.hidden = true;
    app.hidden = false;
    load();
  };
  document.getElementById("gate-pass").focus();
}

// ---- Carregamento -----------------------------------------------------------
async function load() {
  if (!data) mainView.innerHTML = `<div class="card"><div class="empty">A carregar…</div></div>`;
  try {
    // `periodo` = quantos dias para trás as métricas contam (0 = desde sempre).
    const desde = periodo ? Math.floor(Date.now() / 1000) - periodo * 86400 : 0;
    const res = await fetch(`/api/automation${desde ? `?since=${desde}` : ""}`, {
      headers: { "x-dash-key": sessionStorage.getItem(KEY_STORE) || "" },
    });
    if (res.status === 401) { sessionStorage.removeItem(KEY_STORE); showGate("Senha incorreta. Tenta de novo."); return; }
    if (!res.ok) throw new Error();
    data = await res.json();
    renderSidebarDots();
    renderView();
  } catch {
    mainView.innerHTML = `<div class="card"><div class="empty"><h3>Não foi possível carregar</h3><p>Verifica a ligação e tenta de novo.</p><button class="btn btn-ghost" onclick="location.reload()">Recarregar</button></div></div>`;
  }
}

function renderSidebarDots() {
  document.getElementById("dot-ig").classList.toggle("on", !!data.igConfigured);
  document.getElementById("dot-fb").classList.toggle("on", !!data.fbConfigured);
}

// ---- Navegação ----------------------------------------------------------------
function bindChrome() {
  document.getElementById("nav").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (btn) switchView(btn.dataset.view);
  });
  document.getElementById("refresh").addEventListener("click", load);
  document.getElementById("new-rule").addEventListener("click", () => openEditor(null));
  bindEditor();

  // Delegação: switches, editar, apagar, CTAs de vistas vazias.
  mainView.addEventListener("click", onMainClick);
  mainView.addEventListener("change", async (e) => {
    const sw = e.target.closest("input[data-toggle]");
    if (!sw) return;
    await api("/api/automation/rules", { method: "POST", body: { id: Number(sw.dataset.toggle), active: sw.checked ? 1 : 0 } });
    load();
  });
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  const [t, c] = VIEW_TITLES[view];
  document.getElementById("page-title").textContent = t;
  document.getElementById("page-crumb").textContent = c;
  disarmDelete();
  renderView();
}

function renderView() {
  if (!data) return;
  if (currentView === "overview") renderOverview();
  else if (currentView === "automations") renderAutomations();
  else if (currentView === "activity") renderActivity();
  else renderConnections();
}

async function onMainClick(e) {
  const goAutomations = e.target.closest("[data-go-new]");
  if (goAutomations) { openEditor(null); return; }
  const goConn = e.target.closest("[data-go-connections]");
  if (goConn) { switchView("connections"); return; }

  const strat = e.target.closest("button[data-strat]");
  if (strat) { funnelStrategy = strat.dataset.strat || null; renderOverview(); return; }

  const edit = e.target.closest("button[data-edit]");
  if (edit) { openEditor(data.rules.find((r) => r.id === Number(edit.dataset.edit))); return; }

  // Duplicar: cria uma cópia DESLIGADA e abre-a logo para editares.
  const dup = e.target.closest("button[data-dup]");
  if (dup) {
    dup.disabled = true;
    const r = await api(`/api/automation/rules/${dup.dataset.dup}/duplicate`, { method: "POST" });
    await load();
    if (r && r.ok && r.rule) openEditor(r.rule);
    return;
  }

  // Período das métricas (hoje / 7 dias / 30 dias / sempre).
  const per = e.target.closest("button[data-period]");
  if (per) { periodo = Number(per.dataset.period); load(); return; }

  const del = e.target.closest("button[data-del]");
  if (del) {
    const id = Number(del.dataset.del);
    if (armedDelete?.id === id) {
      disarmDelete();
      await api(`/api/automation/rules/${id}`, { method: "DELETE" });
      load();
    } else {
      disarmDelete();
      del.classList.add("btn", "btn-danger-soft");
      del.style.width = "auto";
      del.textContent = "Apagar?";
      armedDelete = { id, timer: setTimeout(() => { disarmDelete(); renderView(); }, 3500) };
    }
  }
}

function disarmDelete() {
  if (armedDelete) { clearTimeout(armedDelete.timer); armedDelete = null; }
}

// ---- Vistas -------------------------------------------------------------------
const fmtInt = new Intl.NumberFormat("pt-PT");

const fmtEur = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" });

function kpisHtml() {
  const s = data.stats || {};
  const active = (data.rules || []).filter((r) => r.active).length;
  const errNote = s.errors ? ` · <span style="color:var(--danger)">${fmtInt.format(s.errors)} erros</span>` : "";
  return `<div class="kpis">
    <div class="kpi hero"><div class="k">Automações ativas</div><div class="v">${fmtInt.format(active)}</div><div class="d">de ${fmtInt.format((data.rules || []).length)} criadas</div></div>
    <div class="kpi"><div class="k">Comentários tratados</div><div class="v">${fmtInt.format(s.total || 0)}</div><div class="d">${fmtInt.format(s.today || 0)} hoje${errNote}</div></div>
    <div class="kpi"><div class="k">DMs enviadas</div><div class="v">${fmtInt.format(s.dms || 0)}</div><div class="d">${fmtInt.format(s.clicked || 0)} abriram o link</div></div>
    <div class="kpi"><div class="k">💰 Vendas</div><div class="v">${fmtInt.format(s.purchases || 0)}</div><div class="d">${s.purchases ? fmtEur.format((s.revenue || 0) / 100) + " atribuídos" : "dos comentários"}</div></div>
  </div>`;
}

// ---- Período das métricas ----------------------------------------------------
const PERIODOS = [
  { d: 1, nome: "Hoje" },
  { d: 7, nome: "7 dias" },
  { d: 30, nome: "30 dias" },
  { d: 0, nome: "Desde sempre" },
];

function periodoHtml() {
  return `<div class="periodo">
    ${PERIODOS.map(
      (p) =>
        `<button type="button" data-period="${p.d}" class="${p.d === periodo ? "is-on" : ""}">${p.nome}</button>`
    ).join("")}
  </div>`;
}

// ---- Desempenho por rede (Instagram vs Facebook) ----------------------------
const PLAT_INFO = {
  ig: { nome: "Instagram", cor: "var(--ig-solid)", icone: "◎" },
  fb: { nome: "Facebook", cor: "var(--fb)", icone: "f" },
};

function platformsHtml() {
  const por = (data.stats || {}).byPlatform || {};
  const redes = ["ig", "fb"];
  // Maior total das duas: serve de escala para as barrinhas comparativas.
  const teto = Math.max(1, ...redes.map((p) => (por[p] || {}).total || 0));
  const ativas = (r) => (data.rules || []).filter((x) => x.active && x.platform === r).length;

  const cartao = (p) => {
    const s = por[p] || {};
    const info = PLAT_INFO[p];
    const linha = (rot, val, extra = "") =>
      `<div class="pl-line"><span>${rot}</span><b>${val}</b>${extra}</div>`;
    const taxa = s.dms && s.clicked ? Math.round((s.clicked / s.dms) * 100) : null;
    return `<div class="card plat-card" style="--pc:${info.cor}">
      <div class="pl-head">
        <span class="pl-ico">${info.icone}</span>
        <h3>${info.nome}</h3>
        <div class="spacer"></div>
        <span class="pl-tag">${fmtInt.format(ativas(p))} ativa${ativas(p) === 1 ? "" : "s"}</span>
      </div>
      <div class="pl-big">
        <div><b>${fmtInt.format(s.total || 0)}</b><span>comentários tratados</span></div>
        <div class="pl-today">${fmtInt.format(s.today || 0)} hoje</div>
      </div>
      <div class="pl-bar"><i style="width:${Math.round(((s.total || 0) / teto) * 100)}%"></i></div>
      <div class="pl-lines">
        ${linha("Respostas públicas", fmtInt.format(s.publics || 0))}
        ${linha("DMs enviadas", fmtInt.format(s.dms || 0))}
        ${linha("Abriram o link", fmtInt.format(s.clicked || 0), taxa != null ? `<em>${taxa}%</em>` : "")}
        ${linha("Vendas", fmtInt.format(s.purchases || 0), s.revenue ? `<em>${fmtEur.format(s.revenue / 100)}</em>` : "")}
        ${s.errors ? `<div class="pl-line err"><span>Erros</span><b>${fmtInt.format(s.errors)}</b></div>` : ""}
      </div>
    </div>`;
  };

  return `<div class="plat-grid section-gap">${redes.map(cartao).join("")}</div>`;
}

// ---- Gráfico dos últimos 14 dias --------------------------------------------
function chartHtml() {
  const serie = (data.stats || {}).serie || [];
  if (!serie.length || !serie.some((d) => d.ig || d.fb)) return "";
  const teto = Math.max(1, ...serie.map((d) => Math.max(d.ig, d.fb)));
  const dias = serie
    .map((d) => {
      const dt = new Date(d.dia * 1000);
      const rot = `${dt.getDate()}/${dt.getMonth() + 1}`;
      const alt = (n) => Math.max(n ? 3 : 0, Math.round((n / teto) * 100));
      return `<div class="ch-day" title="${rot} · Instagram ${d.ig} · Facebook ${d.fb}">
        <div class="ch-bars">
          <i class="ig" style="height:${alt(d.ig)}%"></i>
          <i class="fb" style="height:${alt(d.fb)}%"></i>
        </div>
        <span>${rot}</span>
      </div>`;
    })
    .join("");
  return `<div class="card section-gap">
    <div class="card-head">
      <h2>Últimos 14 dias</h2>
      <div class="spacer"></div>
      <div class="ch-legend">
        <span><i class="ig"></i>Instagram</span><span><i class="fb"></i>Facebook</span>
      </div>
    </div>
    <div class="chart">${dias}</div>
  </div>`;
}

// Funil: do comentário à compra. Base = respostas com link enviado.
// Com várias estratégias (Receita, Quiz...), mostra um seletor e o funil da
// estratégia escolhida (ou "Todas" agregado).
function funnelHtml() {
  const s = data.stats || {};
  // Todas as estratégias (incl. etiquetadas sem dados ainda) — o seletor aparece
  // assim que houver mais do que uma.
  const strategies = s.byStrategy || [];

  if (!(s.withLink > 0)) {
    return `<div class="card section-gap">
      <div class="card-head"><h2>Funil de conversão</h2></div>
      <div class="empty" style="padding:30px 20px">
        <div class="big">🫗</div>
        <h3>Ainda sem dados no funil</h3>
        <p>Quando as tuas respostas levarem um link e alguém o abrir, o percurso até à compra aparece aqui.</p>
      </div>
    </div>`;
  }

  // Se a estratégia selecionada já não existe, volta a "Todas".
  if (funnelStrategy && !strategies.some((x) => x.strategy === funnelStrategy)) funnelStrategy = null;
  const multi = strategies.length > 1;

  // Dados da vista atual: uma estratégia específica ou o agregado.
  const view = funnelStrategy
    ? strategies.find((x) => x.strategy === funnelStrategy)
    : { ...s, stepLabel: "" };
  const midLabel = view.stepLabel || (funnelStrategy ? "Avançaram na página" : "Passo do meio (CTA / quiz)");

  const base = view.withLink || 0;
  const steps = [
    { label: "Responderam com link", n: base, hint: "comentários que receberam o link" },
    { label: "Abriram o link", n: view.clicked || 0, hint: "clicaram no link da resposta/DM" },
    { label: midLabel, n: view.cta || 0, hint: "ação na página de destino" },
    { label: "Foram à página de vendas", n: view.sales || 0, hint: "chegaram à página de vendas" },
    { label: "Compraram", n: view.purchases || 0, hint: "concluíram a compra", money: true },
  ];
  const pct = (n) => (base ? Math.round((n / base) * 100) : 0);
  const rows = steps.map((st, i) => {
    const p = pct(st.n);
    const prev = i > 0 ? steps[i - 1].n : st.n;
    const stepConv = i > 0 && prev > 0 ? Math.round((st.n / prev) * 100) : null;
    const extra = st.money && st.n ? ` · <b>${fmtEur.format((view.revenue || 0) / 100)}</b>` : "";
    return `<div class="funnel-row">
      <div class="funnel-top">
        <span class="funnel-label">${escapeHtml(st.label)}</span>
        <span class="funnel-num">${fmtInt.format(st.n)} <span class="funnel-pct">${p}%</span></span>
      </div>
      <div class="funnel-bar"><span style="width:${Math.max(p, 1.5)}%"></span></div>
      <div class="funnel-hint">${escapeHtml(st.hint)}${stepConv !== null ? ` · ${stepConv}% do passo anterior` : ""}${extra}</div>
    </div>`;
  }).join("");

  // Seletor de estratégias (só quando há mais do que uma).
  const tab = (label, key) =>
    `<button class="strat-tab ${(funnelStrategy || "") === (key || "") ? "active" : ""}" data-strat="${escapeHtml(key || "")}">${escapeHtml(label)}</button>`;
  const tabs = multi
    ? `<div class="strat-tabs">${tab("Todas", "")}${strategies.map((x) => tab(x.strategy, x.strategy)).join("")}</div>`
    : "";

  return `<div class="card section-gap">
    <div class="card-head"><h2>Funil de conversão</h2><div class="spacer"></div><div class="sub">% de quem recebeu o link</div></div>
    ${tabs}
    <div class="funnel">${rows}</div>
  </div>`;
}

function setupNoticeHtml() {
  if (data.igConfigured || data.fbConfigured) return "";
  return `<div class="card section-gap" style="border-color:#f3dfae;background:#fffbf0">
    <div class="act-row" style="border:none">
      <div class="act-ico err" style="background:var(--warn-soft);color:var(--warn)">!</div>
      <div class="act-mid">
        <div class="act-title">Nenhuma conta ligada ainda</div>
        <div class="act-sub" style="white-space:normal">As automações só disparam depois de ligares o Instagram ou o Facebook.</div>
      </div>
      <button class="btn btn-ghost" data-go-connections>Ligar contas</button>
    </div>
  </div>`;
}

function renderOverview() {
  const recent = (data.events || []).slice(0, 6);
  mainView.innerHTML = `
    ${setupNoticeHtml()}
    ${periodoHtml()}
    ${kpisHtml()}
    ${platformsHtml()}
    ${chartHtml()}
    ${funnelHtml()}
    <div class="card">
      <div class="card-head"><h2>Atividade recente</h2><div class="spacer"></div><div class="sub">últimos ${recent.length || 0} comentários</div></div>
      ${recent.length ? recent.map(actRowHtml).join("") : emptyActivityHtml()}
    </div>`;
}

function renderAutomations() {
  const rules = data.rules || [];
  mainView.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>As tuas automações</h2><div class="spacer"></div><div class="sub">${fmtInt.format(rules.length)} no total</div></div>
      ${rules.length ? rules.map(ruleRowHtml).join("") : `
        <div class="empty">
          <div class="big">⚡</div>
          <h3>Ainda não tens automações</h3>
          <p>Escolhe uma palavra-chave e o que responder quando alguém a comentar numa publicação tua.</p>
          <button class="btn btn-primary" data-go-new>Criar a primeira</button>
        </div>`}
    </div>`;
}

// Variações da palavra-chave ("QUERO, KERO" -> ["QUERO","KERO"]).
function kwVariants(keyword) {
  return String(keyword || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function ruleRowHtml(r) {
  const does = [r.reply_public ? "responde no comentário" : "", r.dm_text ? "envia DM" : ""].filter(Boolean).join(" + ") || "sem ação";
  const chips = kwVariants(r.keyword).map((k) => `<span class="kw-chip">${escapeHtml(k)}</span>`).join(" ");
  const strat = r.strategy ? `<span class="strat-chip">${escapeHtml(r.strategy)}</span>` : "";
  return `<div class="rule-row ${r.active ? "" : "off"}">
    ${pbadge(r.platform)}
    <div class="rule-mid">
      <div class="rule-kw">${chips}${strat}</div>
      <div class="rule-meta">${MATCH_NAMES[r.match_type] || r.match_type} · ${does}</div>
    </div>
    <div class="rule-acts">
      <label class="switch" title="${r.active ? "Desativar" : "Ativar"}">
        <input type="checkbox" data-toggle="${r.id}" ${r.active ? "checked" : ""} />
        <span class="track"></span>
      </label>
      <button class="icon-btn" data-edit="${r.id}" title="Editar" aria-label="Editar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
      </button>
      <button class="icon-btn" data-dup="${r.id}" title="Duplicar" aria-label="Duplicar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
      <button class="icon-btn" data-del="${r.id}" title="Apagar" aria-label="Apagar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>
  </div>`;
}

function renderActivity() {
  const events = data.events || [];
  mainView.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Comentários tratados</h2><div class="spacer"></div><div class="sub">${fmtInt.format(events.length)} mais recentes</div></div>
      ${events.length ? events.map(actRowHtml).join("") : emptyActivityHtml()}
    </div>`;
}

function emptyActivityHtml() {
  return `<div class="empty">
    <div class="big">💬</div>
    <h3>Ainda sem atividade</h3>
    <p>Assim que alguém comentar uma das tuas palavras-chave, o resultado aparece aqui.</p>
  </div>`;
}

function actRowHtml(ev) {
  const rule = (data.rules || []).find((r) => r.id === ev.rule_id);
  const kw = rule ? kwVariants(rule.keyword)[0] || rule.keyword : "regra apagada";
  const plat = ev.platform === "ig" ? "Instagram" : "Facebook";
  const bought = ev.purchased_at
    ? `<span class="mini-pill reply" style="background:#14311f;color:#3ecf7a">💰 comprou${ev.purchase_amount ? " · " + fmtEur.format(ev.purchase_amount / 100) : ""}</span>`
    : "";
  const pills = ev.ok
    ? [
        ev.did_public ? `<span class="mini-pill reply">respondeu</span>` : "",
        ev.did_dm ? `<span class="mini-pill dm">DM enviada</span>` : "",
        ev.clicks > 0 ? `<span class="mini-pill dm" title="${ev.clicks} abertura(s)">🔗 abriu o link</span>` : "",
        bought,
      ].filter(Boolean).join("")
    : `<span class="mini-pill err">falhou</span>` + bought;
  const who = ev.username ? "@" + ev.username : "comentário " + (ev.comment_id || "");
  const sub = ev.ok
    ? `${plat} · ${escapeHtml(who)}`
    : `${escapeHtml(who)} · ${escapeHtml(ev.error || "erro desconhecido")}`;
  return `<div class="act-row">
    <div class="act-ico ${ev.ok ? "ok" : "err"}">${ev.ok ? "✓" : "✕"}</div>
    <div class="act-mid">
      <div class="act-title"><span class="kw-chip">${escapeHtml(kw)}</span> ${pills}</div>
      <div class="act-sub" title="${escapeHtml(ev.error || "")}">${sub}</div>
    </div>
    <div class="act-time">${relTime(ev.created)}</div>
  </div>`;
}

function renderConnections() {
  const card = (p, name, on, helpOn, helpOff) => `
    <div class="card conn-card">
      <div class="conn-top">
        ${pbadge(p)}
        <div>
          <div class="conn-name">${name}</div>
          <div class="conn-state ${on ? "on" : "off"}">${on ? "● Ligado" : "● Por configurar"}</div>
        </div>
      </div>
      <div class="conn-help">${on ? helpOn : helpOff}</div>
    </div>`;
  mainView.innerHTML = `<div class="conn-grid">
    ${card("ig", "Instagram", data.igConfigured,
      "A responder a comentários e a enviar DMs. Se trocares o token na Meta, atualiza o <code>.env</code> e reinicia.",
      "Preenche <code>IG_USER_ID</code> e <code>IG_ACCESS_TOKEN</code> no <code>.env</code> e reinicia o servidor. Os passos completos estão no README (secção «Setup na Meta»).")}
    ${card("fb", "Facebook", data.fbConfigured,
      "A responder a comentários da Página.",
      "Preenche <code>PAGE_ID</code> e <code>PAGE_ACCESS_TOKEN</code> no <code>.env</code> e reinicia o servidor. Os passos completos estão no README (secção «Setup na Meta»).")}
  </div>
  <div class="card" style="margin-top:14px">
    <div class="card-head"><h2>Webhook</h2></div>
    <div class="conn-help" style="padding:16px 18px">
      Aponta o webhook da Meta para <code>/webhooks/meta</code> no teu domínio, com o <em>verify token</em> igual ao
      <code>META_VERIFY_TOKEN</code> do <code>.env</code>. Subscreve os campos <code>comments</code> (Instagram) e <code>feed</code> (Facebook).
    </div>
  </div>`;
}

// ---- Editor (modal) -------------------------------------------------------------
const editor = document.getElementById("editor");
const editorForm = document.getElementById("editor-form");

function bindEditor() {
  document.getElementById("editor-close").addEventListener("click", closeEditor);
  document.getElementById("editor-cancel").addEventListener("click", closeEditor);
  editor.addEventListener("click", (e) => { if (e.target === editor) closeEditor(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !editor.hidden) closeEditor(); });

  editorForm.addEventListener("input", syncPreview);
  editorForm.addEventListener("change", syncPreview);

  // Trocar de plataforma recarrega as publicações (as do IG não são as do FB).
  editorForm.querySelectorAll('input[name="platform"]').forEach((radio) => {
    radio.addEventListener("change", () => loadMedia(editorForm.platform.value, ""));
  });

  // Escolher a publicação (delegação: os cartões são criados dinamicamente).
  document.getElementById("media-picker").addEventListener("click", (e) => {
    const tile = e.target.closest(".media-tile");
    if (!tile) return;
    selectMedia(tile.dataset.media || "");
  });

  // Chips "＋ {nome}": inserem a variável na posição do cursor.
  editorForm.querySelectorAll(".var-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      // "__last-reply" = a última caixa de resposta que o utilizador tocou.
      const ta =
        chip.dataset.insert === "__last-reply"
          ? ultimaCaixaResposta()
          : document.getElementById(chip.dataset.insert);
      if (!ta) return;
      const marca = chip.dataset.var || "{nome}";
      const pos = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, pos) + marca + ta.value.slice(ta.selectionEnd ?? pos);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = pos + marca.length;
      syncPreview();
    });
  });

  // Navegação do assistente.
  document.getElementById("wiz-next").addEventListener("click", () => {
    if (!validaPasso(wizStep)) return;
    goStep(wizStep + 1);
  });
  document.getElementById("wiz-back").addEventListener("click", () => goStep(wizStep - 1));
  document.querySelectorAll(".wiz-step").forEach((b) => {
    b.addEventListener("click", () => goStep(Number(b.dataset.goto)));
  });

  // Botões "adicionar mais".
  document.getElementById("kw-add").addEventListener("click", () => {
    repAdd("kw-list", "", "ex.: RECEITA").focus();
  });
  document.getElementById("rep-add").addEventListener("click", () => {
    repAdd("rep-list", "", "ex.: Enviei-te mensagem privada! 💌").focus();
  });

  // Interruptores ligam/desligam os blocos respetivos.
  const liga = (chk, wrap) => {
    const on = document.getElementById(chk).checked;
    document.getElementById(wrap).classList.toggle("is-off", !on);
    syncPreview();
  };
  document.getElementById("t-reply").addEventListener("change", () => liga("t-reply", "reply-wrap"));
  document.getElementById("t-dm").addEventListener("change", () => liga("t-dm", "dm-wrap"));

  // Escolher o formato da DM: texto simples ou com botão clicável.
  document.getElementById("tpl-pick").addEventListener("click", (e) => {
    const b = e.target.closest(".tpl");
    if (!b) return;
    setDmKind(b.dataset.kind);
  });

  // Procurar publicação pela legenda.
  document.getElementById("media-search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll("#media-picker .media-tile:not(.all)").forEach((t) => {
      t.hidden = q ? !(t.getAttribute("title") || "").toLowerCase().includes(q) : false;
    });
  });

  editorForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("editor-msg");
    const palavras = repValues("kw-list");
    const respostas = document.getElementById("t-reply").checked ? repValues("rep-list") : [];
    const dm = document.getElementById("t-dm").checked ? document.getElementById("f-dm").value.trim() : "";

    const body = {
      ...(editingId ? { id: editingId } : {}),
      platform: editorForm.platform.value,
      // No servidor as variações continuam separadas por vírgula.
      keyword: palavras.join(", "),
      match_type: editorForm.match_type.value,
      // A 1ª resposta fica em reply_public (compatibilidade e listagens);
      // a lista completa vai em replies_json e é sorteada a cada comentário.
      reply_public: respostas[0] || "",
      replies_json: respostas.length > 1 ? JSON.stringify(respostas) : "",
      dm_text: dm,
      strategy: editorForm.strategy.value.trim(),
      step_label: editorForm.step_label.value.trim(),
      media_id: document.getElementById("f-media").value,
      once_per_user: document.getElementById("t-once").checked ? 1 : 0,
      dm_kind: document.getElementById("f-dm-kind").value,
      dm_btn_label: document.getElementById("f-btn-label").value.trim(),
      dm_btn_url: document.getElementById("f-btn-url").value.trim(),
    };
    // Sem DM ligada, o botão não faz sentido: limpa para não confundir depois.
    if (!dm && body.dm_kind === "button") body.dm_kind = "text";
    if (!body.keyword) { msg.textContent = "Falta a palavra que dispara (passo 3)."; goStep(3); return; }
    if (body.dm_kind === "button" && !body.dm_btn_url) {
      msg.textContent = "Escolheste o formato Botão — falta o link do botão.";
      return;
    }
    if (!body.reply_public && !body.dm_text && !body.dm_btn_url) { msg.textContent = "Escreve pelo menos uma resposta ou a mensagem privada."; return; }
    msg.textContent = "";
    const r = await api("/api/automation/rules", { method: "POST", body });
    if (r && r.ok) { closeEditor(); load(); }
    else msg.textContent = (r && r.error) || "Não foi possível guardar. Tenta de novo.";
  });
}

function openEditor(rule) {
  editingId = rule ? rule.id : null;
  document.getElementById("editor-title").textContent = rule ? "Editar automação" : "Nova automação";
  document.getElementById("editor-save").textContent = rule ? "Guardar alterações" : "Guardar automação";
  document.getElementById("editor-msg").textContent = "";
  editorForm.reset();
  editorForm.platform.value = rule?.platform || "ig";
  editorForm.match_type.value = rule?.match_type || "contains";
  editorForm.strategy.value = rule?.strategy || "";
  editorForm.step_label.value = rule?.step_label || "";
  document.getElementById("f-dm").value = rule?.dm_text || "";

  // Palavras: no servidor vêm separadas por vírgula, aqui são uma por linha.
  repSet("kw-list", kwVariants(rule?.keyword || ""), "ex.: RECEITA");

  // Respostas: se houver várias guardadas usa-as, senão a única de reply_public.
  let respostas = [];
  try {
    const j = JSON.parse(rule?.replies_json || "[]");
    if (Array.isArray(j)) respostas = j.filter(Boolean);
  } catch { /* json inválido: ignora */ }
  if (!respostas.length && rule?.reply_public) respostas = [rule.reply_public];
  repSet("rep-list", respostas, "ex.: Enviei-te mensagem privada! 💌");

  // Interruptores.
  document.getElementById("t-reply").checked = rule ? Boolean(respostas.length) : true;
  document.getElementById("t-dm").checked = rule ? Boolean(rule.dm_text) : true;
  document.getElementById("t-once").checked = Boolean(rule?.once_per_user);
  document.getElementById("reply-wrap").classList.toggle("is-off", !document.getElementById("t-reply").checked);
  document.getElementById("dm-wrap").classList.toggle("is-off", !document.getElementById("t-dm").checked);
  document.getElementById("f-btn-label").value = rule?.dm_btn_label || "";
  document.getElementById("f-btn-url").value = rule?.dm_btn_url || "";
  setDmKind(rule?.dm_kind === "button" ? "button" : "text");
  document.getElementById("media-search").value = "";
  goStep(1);
  // Sugestões de estratégias já usadas (autocomplete).
  const known = [...new Set((data?.rules || []).map((r) => r.strategy).filter(Boolean))];
  document.getElementById("strategy-list").innerHTML = known.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("");
  loadMedia(rule?.platform || "ig", rule?.media_id || "");
  syncPreview();
  editor.hidden = false;
}

/** A última caixa de resposta tocada (para o chip "＋ {nome}"). */
let ultimaResposta = null;
function ultimaCaixaResposta() {
  const caixas = [...document.querySelectorAll("#rep-list .rep-row textarea")];
  return caixas.includes(ultimaResposta) ? ultimaResposta : caixas[caixas.length - 1] || null;
}
document.addEventListener("focusin", (e) => {
  if (e.target.matches("#rep-list .rep-row textarea")) ultimaResposta = e.target;
});

/** Escolhe o formato da DM ('text' ou 'button') e mostra os campos certos. */
function setDmKind(kind) {
  const k = kind === "button" ? "button" : "text";
  document.getElementById("f-dm-kind").value = k;
  document.querySelectorAll("#tpl-pick .tpl").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.kind === k));
  });
  document.getElementById("btn-fields").hidden = k !== "button";
  syncPreview();
}

/** Valida o passo antes de deixar avançar. */
function validaPasso(n) {
  const msg = document.getElementById("editor-msg");
  msg.textContent = "";
  if (n === 3 && !repValues("kw-list").length) {
    msg.textContent = "Escreve pelo menos uma palavra.";
    return false;
  }
  return true;
}

function closeEditor() {
  editor.hidden = true;
  editingId = null;
}

// ----- Escolher a publicação --------------------------------------------------
// Guarda as publicações já carregadas por plataforma, para não ir buscá-las à
// Meta de cada vez que se abre o editor.
const mediaCache = {};
// Contador de pedidos: se o utilizador trocar de rede enquanto o pedido
// anterior ainda vem a caminho, a resposta atrasada é descartada (senão as
// publicações do Instagram apareciam por cima das do Facebook).
let mediaReq = 0;

/** Marca visualmente a publicação escolhida e guarda-a no campo escondido. */
function selectMedia(id) {
  document.getElementById("f-media").value = id;
  document.querySelectorAll("#media-picker .media-tile").forEach((t) => {
    t.setAttribute("aria-pressed", String((t.dataset.media || "") === id));
  });
}

async function loadMedia(platform, selected) {
  const box = document.getElementById("media-picker");
  const req = ++mediaReq; // só a resposta mais recente pode desenhar
  const todas = `<button type="button" class="media-tile all" data-media="" aria-pressed="true">
      <span class="mt-ico">🌐</span><span>Todas as publicações</span></button>`;

  const render = (media) => {
    box.innerHTML =
      todas +
      media
        .map((m) => {
          const n = m.comments != null ? `<span class="mt-n">${m.comments}</span>` : "";
          const img = m.thumb
            ? `<img src="${escapeHtml(m.thumb)}" alt="" loading="lazy" />`
            : `<div style="height:88px"></div>`;
          return `<button type="button" class="media-tile" data-media="${escapeHtml(m.id)}" aria-pressed="false" title="${escapeHtml(m.caption)}">
              ${img}${n}<span class="mt-cap">${escapeHtml(m.caption || "sem legenda")}</span></button>`;
        })
        .join("");
    selectMedia(selected || "");
  };

  if (mediaCache[platform]) { render(mediaCache[platform]); return; }
  box.innerHTML = todas + `<div class="media-empty">a carregar publicações…</div>`;
  const r = await api(`/api/media?platform=${platform}`);
  if (req !== mediaReq) return; // já se trocou de rede: ignora esta resposta
  if (r && r.ok) { mediaCache[platform] = r.media; render(r.media); }
  else {
    box.innerHTML = todas;
    selectMedia(selected || "");
    const warn = document.createElement("div");
    warn.className = "media-empty";
    warn.textContent = "Não deu para carregar as publicações — a regra vale para todas.";
    box.appendChild(warn);
  }
}

// Substitui {nome}/{name} — igual ao servidor, para a pré-visualização bater certo.
function applyTemplate(text, name) {
  return (text || "").replace(/\{\s*(?:nome|name)\s*\}/gi, name);
}

// Pré-visualização ao vivo: comentário → resposta → DM, como no Instagram.
function syncPreview() {
  const isFb = editorForm.platform.value === "fb";
  document.getElementById("pv-account").textContent = isFb ? "a tua Página" : "a tua conta";
  document.getElementById("pv-who").textContent = isFb ? "a tua Página" : "a tua conta";
  document.getElementById("pv-avatar").style.background = isFb
    ? "#1877f2"
    : "linear-gradient(135deg,#f9ce34,#ee2a7b,#6228d7)";

  // O comentário de exemplo usa a primeira palavra escrita.
  const kw = repValues("kw-list")[0] || "";
  // O comentador de exemplo chama-se "cliente" — é isso que o {nome} vira aqui.
  const respostas = repValues("rep-list");
  // Na pré-visualização a menção aparece como o utilizador a verá.
  const mencao = isFb ? "@Ana Silva" : "@ana.silva";
  const vars = (t) => applyTemplate(String(t || "").replace(/\{\s*(?:men[cç][aã]o|mention)\s*\}/gi, mencao), "cliente");
  const reply = document.getElementById("t-reply").checked ? vars(respostas[0] || "") : "";
  const dm = document.getElementById("t-dm").checked ? vars(document.getElementById("f-dm").value.trim()) : "";

  document.getElementById("pv-comment").textContent = kw || "palavra-chave";
  setBubble("pv-reply", reply, "sem resposta pública");
  setBubble("pv-dm", dm, "sem mensagem privada");
  document.getElementById("pv-reply-wrap").hidden = false;

  // Botão da DM (só quando o formato "Botão" está escolhido).
  const btn = document.getElementById("pv-btn");
  const comBotao =
    document.getElementById("t-dm").checked && document.getElementById("f-dm-kind").value === "button";
  btn.hidden = !comBotao;
  if (comBotao) btn.textContent = document.getElementById("f-btn-label").value.trim() || "Abrir";

  // Quantas respostas diferentes existem (mostra que vão sair à vez).
  const extra = document.getElementById("pv-extra");
  if (extra) extra.textContent = respostas.length > 1 ? `+${respostas.length - 1} variações` : "";
}

function setBubble(id, text, placeholder) {
  const el = document.getElementById(id);
  el.textContent = text || placeholder;
  el.classList.toggle("ph-empty", !text);
}

// ---- Assistente por passos ---------------------------------------------------
let wizStep = 1;
const WIZ_TOTAL = 5;

function goStep(n) {
  wizStep = Math.min(WIZ_TOTAL, Math.max(1, n));
  document.querySelectorAll(".wiz-pane").forEach((p) => {
    p.hidden = Number(p.dataset.step) !== wizStep;
  });
  document.querySelectorAll(".wiz-step").forEach((b) => {
    const i = Number(b.dataset.goto);
    b.classList.toggle("is-on", i === wizStep);
    b.classList.toggle("done", i < wizStep);
  });
  document.getElementById("wiz-count").textContent = `passo ${wizStep} de ${WIZ_TOTAL}`;
  document.getElementById("wiz-back").hidden = wizStep === 1;
  document.getElementById("wiz-next").hidden = wizStep === WIZ_TOTAL;
  document.getElementById("editor-save").hidden = wizStep !== WIZ_TOTAL;
  document.getElementById("editor-msg").textContent = "";
}

// ---- Campos repetíveis (palavras e respostas) --------------------------------
/** Textos preenchidos de uma lista repetível, pela ordem em que aparecem. */
function repValues(listId) {
  return [...document.querySelectorAll(`#${listId} .rep-row textarea`)]
    .map((t) => t.value.trim())
    .filter(Boolean);
}

/** Cria uma linha nova na lista (com botão de apagar). */
function repAdd(listId, value = "", placeholder = "") {
  const list = document.getElementById(listId);
  const row = document.createElement("div");
  row.className = "rep-row";
  const ta = document.createElement("textarea");
  ta.rows = listId === "kw-list" ? 1 : 2;
  ta.value = value;
  ta.placeholder = placeholder;
  const del = document.createElement("button");
  del.type = "button";
  del.className = "rep-del";
  del.title = "Remover";
  del.textContent = "🗑";
  del.addEventListener("click", () => {
    row.remove();
    if (!document.querySelectorAll(`#${listId} .rep-row`).length) repAdd(listId, "", placeholder);
    syncPreview();
  });
  row.append(ta, del);
  list.appendChild(row);
  return ta;
}

/** Reconstrói uma lista repetível a partir de um array de textos. */
function repSet(listId, values, placeholder) {
  document.getElementById(listId).innerHTML = "";
  const vals = values && values.length ? values : [""];
  vals.forEach((v) => repAdd(listId, v, placeholder));
}

// ---- Utilitários ------------------------------------------------------------
async function api(url, { method = "GET", body } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "x-dash-key": sessionStorage.getItem(KEY_STORE) || "",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

function relTime(sec) {
  if (!sec) return "";
  const diff = Math.floor(Date.now() / 1000) - sec;
  if (diff < 60) return "agora";
  if (diff < 3600) return `há ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `há ${Math.floor(diff / 3600)} h`;
  if (diff < 7 * 86400) return `há ${Math.floor(diff / 86400)} d`;
  return new Date(sec * 1000).toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

boot();
