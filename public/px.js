/* =========================================================================
   PIXEL DO FUNIL — Replyzo
   -------------------------------------------------------------------------
   Mede o percurso de quem chega pelos comentarios: pagina da receita ->
   clique em "ver as 500 receitas" -> pagina de vendas.

   Como usar (uma linha em cada pagina do TEU site):

     Na pagina da receita (receita.html):
       <script src="https://O-TEU-REPLYZO/px.js" data-step="cta" async></script>

     Na pagina de vendas (a principal):
       <script src="https://O-TEU-REPLYZO/px.js" data-step="sales" async></script>

   O token do clique chega no URL (?utm_content=rzo_XXXX) vindo do link da
   resposta/DM. Guardamo-lo no localStorage para sobreviver a navegacao interna
   (receita -> vendas). Sem token, o pixel nao faz nada — visitantes que nao
   vieram dos comentarios nao sao contados.
   ========================================================================= */
(function () {
  "use strict";

  function selfScript() {
    if (document.currentScript) return document.currentScript;
    var s = document.getElementsByTagName("script");
    for (var i = s.length - 1; i >= 0; i--) {
      if (s[i].src && s[i].src.indexOf("px.js") !== -1) return s[i];
    }
    return null;
  }

  var el = selfScript();
  if (!el) return;
  var STEP = el.getAttribute("data-step") || "sales"; // "cta" (receita) | "sales"
  var ORIGIN;
  try { ORIGIN = new URL(el.src).origin; } catch (e) { return; }

  // ---- Token do clique (?utm_content=rzo_XXX), persistente neste dominio -----
  var KEY = "rzo_token_v1";
  var token = "";
  try {
    var fromUrl = new URLSearchParams(location.search).get("utm_content") || "";
    if (fromUrl.indexOf("rzo_") === 0) {
      token = fromUrl.slice(4);
      localStorage.setItem(KEY, token);
    } else {
      token = localStorage.getItem(KEY) || "";
    }
  } catch (e) {}
  if (!token) return; // nao veio dos comentarios: nada a medir

  function beacon(step) {
    var url = ORIGIN + "/t?token=" + encodeURIComponent(token) +
      "&step=" + encodeURIComponent(step) + "&_=" + Date.now();
    // sendBeacon sobrevive à navegação (o clique no CTA leva logo a pessoa
    // embora); Image fica como alternativa para browsers antigos.
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url)) return;
    } catch (e) {}
    try { new Image(1, 1).src = url; } catch (e) {}
  }

  // ---- Pagina de vendas: conta a chegada logo no carregamento ---------------
  if (STEP === "sales") {
    beacon("sales");
    return;
  }

  // ---- Pagina da receita: conta o clique em "ver as 500 receitas" -----------
  // Dispara em cliques em links (<a>) OU em qualquer elemento marcado com
  // data-rzo-cta (util se o botao nao for um link). So conta 1x por pagina.
  var fired = false;
  document.addEventListener("click", function (e) {
    if (fired) return;
    var t = e.target;
    var hit = (t.closest && (t.closest("a[href]") || t.closest("[data-rzo-cta]")));
    if (!hit) return;
    // ignora ancoras "#" (nao levam a lado nenhum)
    var href = hit.getAttribute && hit.getAttribute("href");
    if (href === "#" || (href && href.charAt(0) === "#")) return;
    fired = true;
    beacon("cta");
  }, true);
})();
