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
    const res = await fetch("/api/automation", {
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
    ${kpisHtml()}
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
      const ta = document.getElementById(chip.dataset.insert);
      const pos = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, pos) + "{nome}" + ta.value.slice(ta.selectionEnd ?? pos);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = pos + 6;
      syncPreview();
    });
  });

  editorForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("editor-msg");
    const body = {
      ...(editingId ? { id: editingId } : {}),
      platform: editorForm.platform.value,
      keyword: editorForm.keyword.value.trim(),
      match_type: editorForm.match_type.value,
      reply_public: editorForm.reply_public.value.trim(),
      dm_text: editorForm.dm_text.value.trim(),
      strategy: editorForm.strategy.value.trim(),
      step_label: editorForm.step_label.value.trim(),
      media_id: document.getElementById("f-media").value,
    };
    if (!body.keyword) { msg.textContent = "Falta a palavra que dispara."; return; }
    if (!body.reply_public && !body.dm_text) { msg.textContent = "Escreve pelo menos a resposta ou a DM."; return; }
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
  editorForm.keyword.value = rule?.keyword || "";
  editorForm.match_type.value = rule?.match_type || "contains";
  editorForm.reply_public.value = rule?.reply_public || "";
  editorForm.dm_text.value = rule?.dm_text || "";
  editorForm.strategy.value = rule?.strategy || "";
  editorForm.step_label.value = rule?.step_label || "";
  // Sugestões de estratégias já usadas (autocomplete).
  const known = [...new Set((data?.rules || []).map((r) => r.strategy).filter(Boolean))];
  document.getElementById("strategy-list").innerHTML = known.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("");
  loadMedia(rule?.platform || "ig", rule?.media_id || "");
  syncPreview();
  editor.hidden = false;
  document.getElementById("f-keyword").focus();
}

function closeEditor() {
  editor.hidden = true;
  editingId = null;
}

// ----- Escolher a publicação --------------------------------------------------
// Guarda as publicações já carregadas por plataforma, para não ir buscá-las à
// Meta de cada vez que se abre o editor.
const mediaCache = {};

/** Marca visualmente a publicação escolhida e guarda-a no campo escondido. */
function selectMedia(id) {
  document.getElementById("f-media").value = id;
  document.querySelectorAll("#media-picker .media-tile").forEach((t) => {
    t.setAttribute("aria-pressed", String((t.dataset.media || "") === id));
  });
}

async function loadMedia(platform, selected) {
  const box = document.getElementById("media-picker");
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
  document.getElementById("f-dm-field").hidden = isFb;
  document.getElementById("pv-dm-block").hidden = isFb;

  // Com variações ("QUERO, KERO"), o comentário de exemplo usa a primeira.
  const kw = kwVariants(editorForm.keyword.value)[0] || "";
  // O comentador de exemplo chama-se "cliente" — é isso que o {nome} vira aqui.
  const reply = applyTemplate(editorForm.reply_public.value.trim(), "cliente");
  const dm = applyTemplate(editorForm.dm_text.value.trim(), "cliente");

  document.getElementById("pv-comment").textContent = kw || "palavra-chave";
  setBubble("pv-reply", reply, "sem resposta pública");
  setBubble("pv-dm", dm, "sem mensagem privada");
  document.getElementById("pv-reply-wrap").hidden = false;
}

function setBubble(id, text, placeholder) {
  const el = document.getElementById(id);
  el.textContent = text || placeholder;
  el.classList.toggle("ph", !text);
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
