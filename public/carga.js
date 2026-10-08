// carga.js — Indicadores de carga compartidos por los módulos de SiCoDEAJ.
// Mismo archivo en oficios, tareas, notificaciones, relevantes y criterios: si se cambia
// aquí, copiarlo igual a los demás módulos.
//
//   Carga.inicio() / Carga.fin()   barra de progreso superior (la llama el helper de API)
//   Carga.dato(ancho)              marcador para un número o texto corto que aún no llega
//   Carga.lineas(n)                marcador para una lista o tabla que aún no llega
//   Carga.error(el, msg, reintentar)  aviso de error con botón "Reintentar"
(function () {
  const css = `
.carga-barra{position:fixed;top:0;left:0;right:0;height:3px;z-index:2147483000;pointer-events:none;overflow:hidden;opacity:0;transition:opacity .2s}
.carga-barra.activa{opacity:1}
.carga-barra::before{content:'';position:absolute;top:0;bottom:0;left:0;width:40%;background:#C5A989;animation:carga-desliza 1.1s ease-in-out infinite}
@keyframes carga-desliza{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
.carga-skel{display:inline-block;vertical-align:middle;height:1em;min-width:1.2em;border-radius:4px;background:linear-gradient(90deg,#EDEAE6 25%,#F7F5F3 50%,#EDEAE6 75%);background-size:200% 100%;animation:carga-brillo 1.4s ease-in-out infinite;color:transparent;user-select:none}
.carga-lineas{display:flex;flex-direction:column;gap:12px;padding:12px 0}
.carga-lineas .carga-skel{display:block;height:14px}
@keyframes carga-brillo{from{background-position:200% 0}to{background-position:-200% 0}}
.carga-error{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin:8px 0;padding:12px 14px;border:1.5px solid #E3DFDA;border-left:4px solid #C5A989;border-radius:8px;background:#fff;color:#454247;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.4}
.carga-error button{flex:none;padding:7px 14px;border:none;border-radius:6px;background:#454247;color:#fff;font:600 13px Arial,Helvetica,sans-serif;cursor:pointer}
.carga-error button:hover{background:#000}
.carga-error button:focus-visible{outline:2px solid #C5A989;outline-offset:2px}
@media (prefers-reduced-motion:reduce){
  .carga-barra::before{animation:none;width:100%;opacity:.7}
  .carga-skel{animation:none}
}`;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  let barra = null;
  let pendientes = 0;
  let espera = null;

  function asegurarBarra() {
    if (barra) return barra;
    barra = document.createElement('div');
    barra.className = 'carga-barra';
    barra.setAttribute('role', 'progressbar');
    barra.setAttribute('aria-label', 'Cargando');
    (document.body || document.documentElement).appendChild(barra);
    return barra;
  }

  // La barra solo aparece si la espera pasa de 300 ms, para que no parpadee en respuestas rápidas.
  function inicio() {
    pendientes++;
    if (pendientes === 1) {
      clearTimeout(espera);
      espera = setTimeout(() => asegurarBarra().classList.add('activa'), 300);
    }
  }

  function fin() {
    pendientes = Math.max(0, pendientes - 1);
    if (pendientes === 0) {
      clearTimeout(espera);
      if (barra) barra.classList.remove('activa');
    }
  }

  const dato = (ancho = '1.6em') =>
    `<span class="carga-skel" style="width:${ancho}" aria-hidden="true">&nbsp;</span>`;

  function lineas(n = 3) {
    const anchos = ['92%', '78%', '85%', '64%', '88%', '72%'];
    let html = '<div class="carga-lineas" role="status" aria-label="Cargando">';
    for (let i = 0; i < n; i++) html += `<span class="carga-skel" style="width:${anchos[i % anchos.length]}"></span>`;
    return html + '</div>';
  }

  function error(el, msg, reintentar) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return;
    const caja = document.createElement('div');
    caja.className = 'carga-error';
    caja.setAttribute('role', 'alert');
    const texto = document.createElement('span');
    texto.textContent = msg || 'No se pudieron cargar los datos. Revisa tu conexión.';
    caja.appendChild(texto);
    if (reintentar) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Reintentar';
      btn.addEventListener('click', () => reintentar());
      caja.appendChild(btn);
    }
    el.replaceChildren(caja);
  }

  window.Carga = { inicio, fin, dato, lineas, error };
})();
