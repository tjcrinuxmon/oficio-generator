// =====================================================
// app.js — SiCoDEAJ — Sistema de Control Documental DEAJ
// =====================================================

// ── Fecha local en zona horaria CDMX ───────────────
function cdmxToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
}

// ── Tipo activo de documento ───────────────────────
let currentTipo = 'oficio';
let currentModalAcuse = null;
let currentModalOriginalEstatus = null;
let historialPage = 1;
let historialPageSize = 10;

// ── Catálogos compartidos ───────────────────────────
const AREAS = [
    'Dirección Ejecutiva de Asuntos Jurídicos',
    'Dirección de Asuntos HASL',
    'Dirección de Asuntos Laborales',
    'Dirección de Contratos y Convenios',
    'Dirección de Instrucción Recursal',
    'Dirección de Normatividad y Consulta',
    'Dirección de Servicios Legales',
    'Coordinación Administrativa',
    'Coordinacion de Análisis de Información y Control Documental',
];

const URS = [
    'Dirección Ejecutiva del Registro Federal de Electores (DERFE)',
    'Dirección Ejecutiva de Prerrogativas y Partidos Políticos (DEPPP)',
    'Dirección Ejecutiva de Organización Electoral (DEOE)',
    'Dirección Ejecutiva del Servicio Profesional Electoral Nacional (DESPEN)',
    'Dirección Ejecutiva de Capacitación Electoral y Educación Cívica (DECEyEC)',
    'Dirección Ejecutiva de Administración (DEA)',
    'Dirección Ejecutiva de Asuntos Jurídicos (DEAJ)',
    'Presidencia del Consejo General',
    'Secretaría Ejecutiva',
    'Coordinación Nacional de Comunicación Social (CNCS)',
    'Coordinación de Asuntos Internacionales (CAI)',
    'Unidad Técnica de Servicios de Informática (UTSI)',
    'Dirección del Secretariado',
    'Unidad Técnica de Igualdad de Género y No Discriminación (UTIGyND)',
    'Unidad Técnica de lo Contencioso Electoral (UTCE)',
    'Unidad Técnica de Vinculación con los Organismos Públicos Locales (UTVOPL)',
    'Unidad Técnica de Fiscalización (UTF)',
    'Unidad Técnica de Transparencia y Protección de Datos Personales (UTTyPDP)',
];

// ── Estado global ──────────────────────────────────
const state = {
    token: localStorage.getItem('ine_token'),
    user: null,
    view: 'dashboard',
    oficios: [],
    firmantes: [],
    anios: [],
    usuarios: [],
};

// ── API helper ─────────────────────────────────────
async function api(method, path, body = null, isFormData = false) {
    const opts = { method, headers: { Authorization: `Bearer ${state.token}` } };
    if (body && !isFormData) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    } else if (body) {
        opts.body = body; // FormData
    }
    const res = await fetch(`/api/of${path}`, opts);
    if (res.status === 401) { logout(); return null; }
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Error desconocido');
    }
    const ct = res.headers.get('Content-Type') || '';
    if (ct.includes('application/json')) return res.json();
    return res; // para descargas
}

// ── Toast ───────────────────────────────────────────
function toast(msg, type = 'info') {
    const icons = { success: '✓', error: '✕', info: 'ℹ' };
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type] ?? 'ℹ'}</span><span>${msg}</span>`;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 4500);
}

// ── Utilidades ──────────────────────────────────────
function formatFecha(f) {
    if (!f) return '—';
    const d = new Date(f.includes('T') ? f : f + 'T12:00:00');
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function setupCharCounter(inputId, max) {
    const el = document.getElementById(inputId);
    if (!el) return;
    const counterId = inputId + '-counter';
    let counter = document.getElementById(counterId);
    if (!counter) {
        counter = document.createElement('div');
        counter.id = counterId;
        counter.className = 'char-counter';
        el.insertAdjacentElement('afterend', counter);
    }
    const update = () => {
        const len = el.value.length;
        counter.textContent = `${len} / ${max} caracteres`;
        counter.className = 'char-counter';
        if (len >= max)              counter.classList.add('error');
        else if (len >= max * 0.85) counter.classList.add('warn');
    };
    el.addEventListener('input', update);
    update();
}

function labelEstatus(e) {
    return { borrador: 'Borrador', enviado: 'Enviado', recibido: 'Recibido', archivado: 'Archivado', cancelado: 'Cancelado' }[e] || e;
}

async function fetchDownload(url, filename) {
    try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${state.token}` } });
        if (!res.ok) { toast('Error al exportar', 'error'); return; }
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (e) {
        toast(e.message, 'error');
    }
}

// ── Auth ────────────────────────────────────────────
function logout() {
    state.token = null;
    state.user = null;
    localStorage.removeItem('ine_token');
    window.location.replace('/');
}

// ── Navegación ──────────────────────────────────────
function showView(view) {
    state.view = view;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById(`view-${view}`)?.classList.add('active');
    const navId = view === 'nuevo' ? 'nav-selector' : `nav-${view}`;
    document.getElementById(navId)?.classList.add('active');

    if (view === 'dashboard') loadDashboard();
    if (view === 'nuevo') loadNuevo();
    if (view === 'historial') loadHistorial(getHistorialFiltros());
    if (view === 'firmantes') loadFirmantes();
    if (view === 'anios') loadAnios();
    if (view === 'usuarios') loadUsuarios();
}

// ── Dashboard helpers ────────────────────────────────
function renderRecientes(containerId, items, emptyMsg) {
    const container = document.getElementById(containerId);
    if (!items.length) {
        container.innerHTML = `<p class="recientes-empty">${emptyMsg}</p>`;
        return;
    }
    container.innerHTML = `
      <div class="table-wrapper" style="margin:0">
        <table class="data-table">
          <thead><tr>
            <th>Número</th>
            <th>Fecha</th>
            <th>Asunto</th>
            <th>Estatus</th>
          </tr></thead>
          <tbody>
            ${items.map(o => `
              <tr class="reciente-row" data-id="${o.id}">
                <td><span class="oficio-num">${o.numero_oficio}</span></td>
                <td style="white-space:nowrap">${formatFecha(o.fecha)}</td>
                <td class="td-asunto" title="${o.asunto}">${o.asunto}</td>
                <td><span class="status-badge status-${o.estatus}">${labelEstatus(o.estatus)}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>`;
    container.querySelectorAll('.reciente-row').forEach(el =>
        el.addEventListener('click', () => openOficioModal(el.dataset.id, true))
    );
}

// ── Dashboard ───────────────────────────────────────
async function loadDashboard() {
    try {
        const [oficios, anioActivo] = await Promise.all([
            api('GET', '/oficios'),
            api('GET', '/anios/activo').catch(() => null),
        ]);

        const badge = document.getElementById('anio-activo-badge');
        badge.textContent = anioActivo ? `Año ${anioActivo.anio}` : '';

        const nameEl = document.getElementById('dash-user-name');
        if (nameEl && state.user) nameEl.textContent = state.user.nombre;

        const ofs = oficios.filter(o => (o.tipo || 'oficio') === 'oficio');
        const ots = oficios.filter(o => o.tipo === 'opinion');
        const dts  = oficios.filter(o => o.tipo === 'dictamen');
        const cts  = oficios.filter(o => o.tipo === 'certificacion');

        // Stats oficios
        document.getElementById('of-total').textContent = ofs.length;
        document.getElementById('of-borrador').textContent = ofs.filter(o => o.estatus === 'borrador').length;
        document.getElementById('of-archivado').textContent = ofs.filter(o => o.estatus === 'archivado').length;

        // Stats opiniones
        document.getElementById('ot-total').textContent = ots.length;
        document.getElementById('ot-borrador').textContent = ots.filter(o => o.estatus === 'borrador').length;
        document.getElementById('ot-archivado').textContent = ots.filter(o => o.estatus === 'archivado').length;

        // Stats dictámenes
        document.getElementById('dt-total').textContent = dts.length;
        document.getElementById('dt-borrador').textContent = dts.filter(o => o.estatus === 'borrador').length;
        document.getElementById('dt-archivado').textContent = dts.filter(o => o.estatus === 'archivado').length;

        // Stats certificaciones
        document.getElementById('ct-total').textContent = cts.length;
        document.getElementById('ct-borrador').textContent = cts.filter(o => o.estatus === 'borrador').length;
        document.getElementById('ct-archivado').textContent = cts.filter(o => o.estatus === 'archivado').length;

        renderRecientes('dash-recientes-oficio', ofs.slice(0, 5), 'No hay oficios registrados aún.');
        renderRecientes('dash-recientes-opinion', ots.slice(0, 5), 'No hay opiniones técnicas registradas aún.');
        renderRecientes('dash-recientes-dictamen', dts.slice(0, 5), 'No hay dictámenes registrados aún.');
        renderRecientes('dash-recientes-certificacion', cts.slice(0, 5), 'No hay certificaciones registradas aún.');
    } catch (e) {
        toast(e.message, 'error');
    }
}

// ── Historial ───────────────────────────────────────
async function loadHistorial(params = {}) {
    // limpiar entradas vacías
    Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
    const qs = new URLSearchParams(params).toString();
    try {
        const oficios = await api('GET', `/oficios${qs ? '?' + qs : ''}`);
        state.oficios = oficios;
        renderHistorialTable(oficios);
    } catch (e) {
        toast(e.message, 'error');
    }
}

function renderHistorialTable(oficios) {
    const tipo  = document.getElementById('filter-tipo').value;
    const tbody = document.getElementById('historial-tbody');
    const thead = document.querySelector('#historial-table thead tr');
    const empty = document.getElementById('historial-empty');

    if (!oficios.length) {
        tbody.innerHTML = '';
        empty.classList.remove('hidden');
        renderPagination(0);
        return;
    }
    empty.classList.add('hidden');

    const isOficio        = tipo === 'oficio';
    const isOpinion       = tipo === 'opinion';
    const isDictamen      = tipo === 'dictamen';
    const isCertificacion = tipo === 'certificacion';

    const colHeader = isOficio        ? '<th>Destinatario</th>'
                    : isOpinion       ? '<th>Requirente</th>'
                    : isDictamen      ? '<th>Requirente</th>'
                    : isCertificacion ? '<th>Destinatario</th>'
                    :                   '<th>Tipo</th>';

    thead.innerHTML = `
        <th>Número / Folio</th>
        <th>Fecha</th>
        ${colHeader}
        <th>Asunto</th>
        <th>Firmante</th>
        <th>Área</th>
        <th>Estatus</th>
        <th>Acuse</th>
        <th>Acciones</th>`;

    // Paginación
    const total   = oficios.length;
    const start   = (historialPage - 1) * historialPageSize;
    const pagData = oficios.slice(start, start + historialPageSize);

    const editIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

    tbody.innerHTML = pagData.map(o => {
        const TIPO_BADGES = {
            oficio:        '<span class="tipo-badge tipo-oficio">Oficio</span>',
            opinion:       '<span class="tipo-badge tipo-opinion">Opinión</span>',
            dictamen:      '<span class="tipo-badge tipo-dictamen">Dictamen</span>',
            certificacion: '<span class="tipo-badge tipo-certificacion">Certificación</span>',
        };
        const colCell = isOficio        ? `<td class="td-truncate" title="${o.destinatario || ''}">${o.destinatario || '—'}</td>`
                      : isOpinion       ? `<td class="td-truncate" title="${o.url_solicitante || ''}">${o.url_solicitante || '—'}</td>`
                      : isDictamen      ? `<td class="td-truncate" title="${o.url_solicitante || ''}">${o.url_solicitante || '—'}</td>`
                      : isCertificacion ? `<td class="td-truncate" title="${o.destinatario || ''}">${o.destinatario || '—'}</td>`
                      : `<td>${TIPO_BADGES[o.tipo] || TIPO_BADGES.oficio}</td>`;
        return `
    <tr>
      <td><span class="oficio-num">${o.numero_oficio}</span></td>
      <td>${formatFecha(o.fecha)}</td>
      ${colCell}
      <td class="td-asunto" title="${o.asunto}">${o.asunto}</td>
      <td class="td-truncate" title="${o.firmante_nombre || ''}">${o.firmante_nombre || '—'}</td>
      <td class="td-truncate" title="${o.area}">${o.area}</td>
      <td><span class="status-badge status-${o.estatus}">${labelEstatus(o.estatus)}</span></td>
      <td>
        ${o.acuse_path
            ? `<button class="btn-acuse-si" data-id="${o.id}" title="Descargar acuse"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg></button>`
            : '<span class="acuse-no">—</span>'}
      </td>
      <td>
        <button class="btn-table-action" title="Ver / editar" onclick="openOficioModal(${o.id})">${editIcon}</button>
      </td>
    </tr>`;
    }).join('');

    tbody.querySelectorAll('.btn-acuse-si').forEach(el =>
        el.addEventListener('click', () => downloadAcuse(el.dataset.id))
    );

    renderPagination(total);
}

function renderPagination(total) {
    const container = document.getElementById('historial-pagination');
    if (!container) return;
    const totalPages = Math.ceil(total / historialPageSize);
    if (totalPages <= 1) { container.innerHTML = ''; return; }

    const pages = [];
    // Siempre mostrar primera, última y páginas cercanas a la actual
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= historialPage - 1 && i <= historialPage + 1)) {
            pages.push(i);
        }
    }
    // Insertar elipsis
    const withEllipsis = [];
    let prev = null;
    for (const p of pages) {
        if (prev && p - prev > 1) withEllipsis.push('…');
        withEllipsis.push(p);
        prev = p;
    }

    const btn = (label, page, disabled = false, active = false) =>
        `<button class="pagination-btn${active ? ' active' : ''}" data-page="${page}" ${disabled ? 'disabled' : ''}>${label}</button>`;

    container.innerHTML =
        btn('‹', historialPage - 1, historialPage === 1) +
        withEllipsis.map(p => p === '…'
            ? `<span class="pagination-ellipsis">…</span>`
            : btn(p, p, false, p === historialPage)
        ).join('') +
        btn('›', historialPage + 1, historialPage === totalPages);

    container.querySelectorAll('.pagination-btn:not([disabled])').forEach(b =>
        b.addEventListener('click', () => {
            historialPage = parseInt(b.dataset.page);
            renderHistorialTable(state.oficios);
        })
    );
}

// ── Selector de tipo ─────────────────────────────────
function selectTipo(tipo) {
    currentTipo = tipo;
    const titles    = { oficio: 'Nuevo Oficio', opinion: 'Nueva Opinión Técnica', dictamen: 'Nuevo Dictamen', certificacion: 'Nueva Certificación' };
    const badges    = { oficio: 'Oficio', opinion: 'Opinión Técnica', dictamen: 'Dictamen', certificacion: 'Certificación' };
    const btnLabels = { oficio: '✉️ Generar Oficio', opinion: '✉️ Generar Opinión Técnica', dictamen: '📋 Generar Dictamen', certificacion: '🏅 Generar Certificación' };
    document.getElementById('form-title').textContent = titles[tipo] || 'Nuevo Oficio';
    const badge = document.getElementById('form-tipo-badge');
    badge.className = `tipo-badge tipo-${tipo}`;
    badge.textContent = badges[tipo] || 'Oficio';
    document.querySelector('#btn-generar .btn-text').textContent = btnLabels[tipo] || '✉️ Generar Oficio';
    applyTipoToggle(tipo);
    document.getElementById('numero-preview').classList.add('hidden');
    document.getElementById('numero-generado').textContent = '';
    showView('nuevo');
}

// ── Nuevo Oficio ─────────────────────────────────────
async function loadNuevo() {
    document.getElementById('numero-preview').classList.add('hidden');
    document.getElementById('numero-generado').textContent = '';
    try {
        const firmantes = await api('GET', '/firmantes');
        state.firmantes = firmantes;
        const sel = document.getElementById('of-firmante');
        sel.innerHTML = '<option value="">— Seleccionar firmante —</option>' +
            firmantes.map(f =>
                `<option value="${f.id}">${f.nombre}${f.es_titular ? ' (Titular)' : ''}</option>`
            ).join('');
        // fecha por defecto — siempre hoy, no editable
        const todayVal = cdmxToday();
        document.getElementById('of-fecha').value = todayVal;
        document.getElementById('of-fecha-display').textContent = formatFecha(todayVal);
    } catch (e) {
        toast(e.message, 'error');
    }
}

// ── Modal Oficio Detalle ──────────────────────────────
async function openOficioModal(id, readOnly = false) {
    try {
        const [o, firmantes] = await Promise.all([
            api('GET', `/oficios/${id}`),
            state.firmantes.length ? Promise.resolve(state.firmantes) : api('GET', '/firmantes'),
        ]);
        state.firmantes = firmantes;
        const currentFirmante = firmantes.find(f => f.id == o.firmante_id);
        const currentIsNoTitular = currentFirmante && !currentFirmante.es_titular;

        const estatusDisponibles = o.acuse_path
            ? ['archivado', 'cancelado']
            : ['borrador', 'archivado', 'cancelado'];
        const estatusOpts = estatusDisponibles
            .map(e => `<option value="${e}" ${o.estatus === e ? 'selected' : ''}>${labelEstatus(e)}</option>`)
            .join('');

        const firmanteOpts = firmantes
            .map(f => `<option value="${f.id}" ${o.firmante_id == f.id ? 'selected' : ''}>${f.nombre}${f.es_titular ? ' (Titular)' : ''}</option>`)
            .join('');

        currentModalAcuse = o.acuse_path || null;
        currentModalOriginalEstatus = o.estatus;
        const isAdmin         = state.user.rol === 'admin';
        const isOpinion       = o.tipo === 'opinion';
        const isDictamen      = o.tipo === 'dictamen';
        const isCertificacion = o.tipo === 'certificacion';
        const needsUR         = isOpinion || isDictamen;
        const q = s => (s || '').replace(/"/g, '&quot;');
        const areaOpts = AREAS.map(a => `<option value="${a}" ${o.area === a ? 'selected' : ''}>${a}</option>`).join('');
        const urOpts = URS.map(u => `<option value="${u}" ${o.url_solicitante === u ? 'selected' : ''}>${u}</option>`).join('');

        document.getElementById('modal-oficio-titulo').textContent = o.numero_oficio;
        document.getElementById('modal-oficio-body').innerHTML = `
      <div class="detail-grid">
        <div class="detail-item full">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
            <span class="detail-label">${isDictamen ? 'Número de Dictamen' : isCertificacion ? 'Número de Certificación' : isOpinion ? 'Número de Opinión Técnica' : 'Número de Oficio'}</span>
            ${isDictamen ? '<span class="tipo-badge tipo-dictamen">Dictamen</span>' : isCertificacion ? '<span class="tipo-badge tipo-certificacion">Certificación</span>' : isOpinion ? '<span class="tipo-badge tipo-opinion">Opinión Técnica</span>' : '<span class="tipo-badge tipo-oficio">Oficio</span>'}
          </div>
          <span class="detail-numero">${o.numero_oficio}</span>
        </div>
        <div class="detail-separator"></div>

        <div class="detail-item">
          <span class="detail-label">Fecha</span>
          ${isAdmin
            ? `<input type="date" id="det-fecha" class="filter-select" style="width:100%" value="${o.fecha || ''}">`
            : `<span class="detail-value">${formatFecha(o.fecha)}</span>`}
        </div>
        <div class="detail-item">
          <span class="detail-label">Estatus</span>
          ${readOnly
            ? `<span class="status-badge status-${o.estatus}">${labelEstatus(o.estatus)}</span>`
            : `<select id="det-estatus" class="filter-select" style="width:100%">${estatusOpts}</select>`
          }
        </div>

        ${!needsUR ? `
        <div class="detail-item">
          <span class="detail-label">Destinatario</span>
          ${isAdmin
            ? `<input type="text" id="det-destinatario" class="filter-select" style="width:100%" maxlength="255" value="${q(o.destinatario)}">`
            : `<span class="detail-value">${o.destinatario || '—'}</span>`}
        </div>
        <div class="detail-item">
          <span class="detail-label">Cargo del Destinatario</span>
          ${isAdmin
            ? `<input type="text" id="det-cargo" class="filter-select" style="width:100%" maxlength="255" value="${q(o.cargo_destinatario)}">`
            : `<span class="detail-value">${o.cargo_destinatario || '—'}</span>`}
        </div>
        <div class="detail-item">
          <span class="detail-label">Institución</span>
          ${isAdmin
            ? `<input type="text" id="det-institucion" class="filter-select" style="width:100%" maxlength="255" placeholder="(opcional)" value="${q(o.institucion || '')}">`
            : `<span class="detail-value">${o.institucion || '—'}</span>`}
        </div>` : `
        <div class="detail-item full">
          <span class="detail-label">Requirente</span>
          ${isAdmin
            ? `<select id="det-url-solicitante" class="filter-select" style="width:100%"><option value="">— Selecciona la UR —</option>${urOpts}</select>`
            : `<span class="detail-value">${o.url_solicitante || '—'}</span>`}
        </div>`}

        <div class="detail-item" style="grid-column:1/-1;border-top:1px solid var(--border,#e5e7eb);margin-top:4px;padding-top:8px;">
          <span class="detail-label" style="font-size:11px;color:var(--text-muted);">Revisó / Elaboró (opcional — si vacío usa firmante/solicita)</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Nombre — Revisó</span>
          ${isAdmin
            ? `<input type="text" id="det-reviso-nombre" class="filter-select" style="width:100%" maxlength="255" placeholder="(usa firmante si vacío)" value="${q(o.reviso_nombre || '')}">`
            : `<span class="detail-value">${o.reviso_nombre || o.firmante_nombre || '—'}</span>`}
        </div>
        <div class="detail-item">
          <span class="detail-label">Puesto — Revisó</span>
          ${isAdmin
            ? `<input type="text" id="det-reviso-puesto" class="filter-select" style="width:100%" maxlength="255" placeholder="(usa cargo firmante si vacío)" value="${q(o.reviso_puesto || '')}">`
            : `<span class="detail-value">${o.reviso_puesto || o.firmante_cargo || '—'}</span>`}
        </div>
        <div class="detail-item">
          <span class="detail-label">Nombre — Elaboró</span>
          ${isAdmin
            ? `<input type="text" id="det-elaboro-nombre" class="filter-select" style="width:100%" maxlength="255" placeholder="(usa solicita si vacío)" value="${q(o.elaboro_nombre || '')}">`
            : `<span class="detail-value">${o.elaboro_nombre || o.solicita || '—'}</span>`}
        </div>
        <div class="detail-item">
          <span class="detail-label">Puesto — Elaboró</span>
          ${isAdmin
            ? `<input type="text" id="det-elaboro-puesto" class="filter-select" style="width:100%" maxlength="255" placeholder="(usa área si vacío)" value="${q(o.elaboro_puesto || '')}">`
            : `<span class="detail-value">${o.elaboro_puesto || o.area || '—'}</span>`}
        </div>

        <div class="detail-item full">
          <span class="detail-label">Asunto</span>
          ${isAdmin
            ? `<textarea id="det-asunto" class="filter-select" style="width:100%;min-height:72px;resize:vertical" maxlength="500">${o.asunto || ''}</textarea><div class="char-counter" id="det-asunto-counter"></div>`
            : `<span class="detail-value">${o.asunto}</span>`}
        </div>

        <div class="detail-item full">
          <span class="detail-label">Síntesis</span>
          ${isAdmin
            ? `<textarea id="det-sintesis" class="filter-select" style="width:100%;min-height:60px;resize:vertical" placeholder="Síntesis o resumen..." maxlength="1000">${o.sintesis || ''}</textarea>`
            : `<span class="detail-value" style="white-space:pre-wrap">${o.sintesis || '—'}</span>`}
        </div>

        <div class="detail-item full">
          <span class="detail-label">Cuerpo del documento</span>
          ${isAdmin
            ? `<textarea id="det-cuerpo" class="filter-select" style="width:100%;min-height:120px;resize:vertical" placeholder="Redacta el contenido del oficio...">${o.cuerpo || ''}</textarea>`
            : `<span class="detail-value" style="white-space:pre-wrap">${o.cuerpo || '—'}</span>`}
        </div>

        <div class="detail-item">
          <span class="detail-label">ID SAI</span>
          ${isAdmin
            ? `<input type="text" id="det-id-sai" class="filter-select" style="width:100%" maxlength="100" value="${q(o.id_sai || '')}">`
            : `<span class="detail-value">${o.id_sai || '—'}</span>`}
        </div>

        <div class="detail-item">
          <span class="detail-label">Firmante</span>
          <select id="det-firmante" class="filter-select" style="width:100%">
            <option value="">—</option>${firmanteOpts}
          </select>
        </div>
        <div class="detail-item">
          <span class="detail-label">Solicita</span>
          ${isAdmin
            ? `<input type="text" id="det-solicita" class="filter-select" style="width:100%" maxlength="255" value="${q(o.solicita)}">`
            : `<span class="detail-value">${o.solicita}</span>`}
        </div>

        <div class="detail-item">
          <span class="detail-label">Área</span>
          ${isAdmin
            ? `<select id="det-area" class="filter-select" style="width:100%">${areaOpts}</select>`
            : `<span class="detail-value">${o.area}</span>`}
        </div>
        <div class="detail-item">
          <span class="detail-label">Registrado por</span>
          <span class="detail-value">${o.creado_por_nombre || '—'}</span>
        </div>

        ${readOnly
          ? (o.justificacion_firmante ? `
        <div class="detail-item full">
          <span class="detail-label">Justificación de firmante</span>
          <div class="justif-box">${o.justificacion_firmante}</div>
        </div>` : '')
          : `
        <div id="justif-firmante-wrapper" class="detail-item full" style="${currentIsNoTitular ? '' : 'display:none'}">
          <span class="detail-label">Justificación de firmante <span class="required">*</span></span>
          <textarea id="det-justificacion" class="filter-select" style="width:100%;min-height:60px;resize:vertical" maxlength="255">${o.justificacion_firmante || ''}</textarea>
        </div>`}

        ${o.estatus === 'cancelado' ? `
        <div id="reactivacion-wrapper" class="detail-item full" style="display:none">
          <span class="detail-label">Justificación de reactivación <span class="required">*</span></span>
          <textarea id="det-razon-reactivacion" class="filter-select" style="width:100%;min-height:72px;resize:vertical" maxlength="500" placeholder="Explica el motivo por el que se reactiva este documento"></textarea>
        </div>` : (o.razon_reactivacion ? `
        <div class="detail-item full">
          <span class="detail-label">Justificación de reactivación</span>
          <div class="justif-box">${o.razon_reactivacion}</div>
        </div>` : '')}

        <div id="acuse-wrapper" style="${o.estatus === 'borrador' ? 'display:none' : ''}">
        <div class="detail-separator"></div>

        <div class="detail-item full acuse-section">
          <div class="acuse-section-header">
            <span class="detail-label">Acuse de recibo</span>
            ${o.acuse_path ? '<span class="acuse-badge">PDF adjunto</span>' : ''}
          </div>

          ${o.acuse_path ? `
          <div class="acuse-attached-row">
            <div class="acuse-attached-info">
              <svg class="acuse-pdf-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>
              <div style="min-width:0;overflow:hidden;">
                <div class="acuse-file-name">Acuse — ${o.numero_oficio}</div>
                <div class="acuse-file-hint">Vinculado a este documento</div>
              </div>
            </div>
            <div class="acuse-attached-btns">
              <button class="btn btn-secondary btn-sm" onclick="viewAcuse(${o.id})">Ver</button>
              <button class="btn btn-secondary btn-sm" onclick="downloadAcuse(${o.id})">Descargar</button>
              ${!readOnly ? `<button class="btn btn-danger btn-sm" onclick="deleteAcuse(${o.id})">Eliminar</button>` : ''}
            </div>
          </div>
          <div class="acuse-replace-label">Reemplazar archivo:</div>
          ` : ''}

          <div class="acuse-dropzone" id="acuse-dropzone" style="${readOnly ? 'display:none' : ''}" onclick="document.getElementById('det-acuse-file').click()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <div>
              <div class="acuse-dropzone-main">${o.acuse_path ? 'Seleccionar nuevo PDF' : 'Seleccionar PDF'}</div>
              <div class="acuse-dropzone-hint">${o.acuse_path
                ? 'El nuevo archivo <strong>reemplazará</strong> el acuse actual'
                : `El archivo quedará vinculado al documento <strong>${o.numero_oficio}</strong>`}
              </div>
            </div>
          </div>
          <input type="file" id="det-acuse-file" accept=".pdf" style="display:none" onchange="onAcuseFileSelected(this,${o.id})" />

          <div id="acuse-selected-row" class="acuse-selected-row hidden">
            <svg class="acuse-pdf-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>
            <span id="acuse-selected-name" class="acuse-file-name"></span>
            <button class="btn btn-primary btn-sm acuse-btn-icon" id="acuse-upload-btn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Subir acuse
            </button>
          </div>
        </div>
        </div>
      </div>

      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
        <button class="btn btn-secondary" onclick="closeModal('modal-oficio')">Cerrar</button>
        <button class="btn btn-secondary" onclick="downloadDocx(${o.id})" title="Descargar documento Word">
          <svg style="width:15px;height:15px;margin-right:5px;vertical-align:-2px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>Generar Word
        </button>
        ${readOnly
          ? `<button class="btn btn-primary" onclick="closeModal('modal-oficio');openOficioModal(${o.id},false)">Editar</button>`
          : `<button class="btn btn-primary" onclick="saveOficioChanges(${o.id})">Guardar cambios</button>`
        }
      </div>
    `;
        openModal('modal-oficio');
        setupCharCounter('det-asunto', 500);

        if (!readOnly) document.getElementById('det-estatus').addEventListener('change', function () {
            document.getElementById('acuse-wrapper').style.display =
                this.value === 'borrador' ? 'none' : '';
            if (currentModalOriginalEstatus === 'cancelado') {
                const w = document.getElementById('reactivacion-wrapper');
                if (w) w.style.display = this.value !== 'cancelado' ? '' : 'none';
            }
        });

        if (!readOnly) document.getElementById('det-firmante')?.addEventListener('change', function () {
            const f = state.firmantes.find(f => f.id == this.value);
            const wrapper = document.getElementById('justif-firmante-wrapper');
            if (!wrapper) return;
            if (f && !f.es_titular) {
                wrapper.style.display = '';
            } else {
                wrapper.style.display = 'none';
                const ta = document.getElementById('det-justificacion');
                if (ta) ta.value = '';
            }
        });
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function saveOficioChanges(id) {
    const body = {};

    const estatus    = document.getElementById('det-estatus')?.value;
    const firmante_id = document.getElementById('det-firmante')?.value;

    if (estatus === 'archivado' && !currentModalAcuse) {
        toast('Debes subir el acuse antes de cambiar a Archivado', 'error');
        return;
    }

    if (estatus === 'cancelado' && currentModalAcuse && currentModalOriginalEstatus !== 'cancelado') {
        const numero = document.getElementById('modal-oficio-titulo')?.textContent || 'este documento';
        const ok = confirm(
            `¿Cancelar el documento ${numero}?\n\n` +
            `Esta acción:\n` +
            `  • Marcará el número de oficio como CANCELADO\n` +
            `  • Eliminará permanentemente el acuse adjunto\n\n` +
            `Esta operación no se puede deshacer.`
        );
        if (!ok) {
            document.getElementById('det-estatus').value = currentModalOriginalEstatus;
            return;
        }
    }

    if (currentModalOriginalEstatus === 'cancelado' && estatus && estatus !== 'cancelado') {
        const razonEl = document.getElementById('det-razon-reactivacion');
        const razon = razonEl?.value?.trim() || '';
        if (!razon) {
            toast('Debes justificar el motivo de reactivación antes de guardar', 'error');
            if (razonEl) {
                razonEl.style.borderColor = '#ef4444';
                razonEl.focus();
                razonEl.addEventListener('input', () => { razonEl.style.borderColor = ''; }, { once: true });
            }
            return;
        }
        body.razon_reactivacion = razon;
    }

    if (estatus)     body.estatus     = estatus;
    if (firmante_id) body.firmante_id = firmante_id;

    const justifWrapper = document.getElementById('justif-firmante-wrapper');
    const justif = document.getElementById('det-justificacion')?.value?.trim() ?? null;
    if (justifWrapper && justifWrapper.style.display !== 'none') {
        if (!justif) {
            toast('Debes justificar por qué no firma la ejecutiva titular', 'error');
            return;
        }
        body.justificacion_firmante = justif;
    } else if (firmante_id && state.firmantes.find(f => f.id == firmante_id)?.es_titular) {
        body.justificacion_firmante = '';
    }

    if (state.user.rol === 'admin') {
        const fecha       = document.getElementById('det-fecha')?.value;
        const asunto      = document.getElementById('det-asunto')?.value;
        const solicita    = document.getElementById('det-solicita')?.value;
        const area        = document.getElementById('det-area')?.value;
        const destinatario = document.getElementById('det-destinatario')?.value;
        const cargo        = document.getElementById('det-cargo')?.value;
        const institucion  = document.getElementById('det-institucion')?.value ?? null;
        const ur           = document.getElementById('det-url-solicitante')?.value;

        const sintesis = document.getElementById('det-sintesis')?.value ?? null;
        const cuerpo   = document.getElementById('det-cuerpo')?.value ?? null;
        const id_sai   = document.getElementById('det-id-sai')?.value ?? null;

        if (fecha)       body.fecha               = fecha;
        if (asunto)      body.asunto              = asunto;
        if (sintesis !== null) body.sintesis        = sintesis;
        if (cuerpo   !== null) body.cuerpo         = cuerpo;
        if (id_sai   !== null) body.id_sai         = id_sai;
        if (solicita)    body.solicita            = solicita;
        if (area)        body.area                = area;
        if (destinatario !== undefined && destinatario !== null) body.destinatario       = destinatario;
        if (cargo        !== undefined && cargo        !== null) body.cargo_destinatario = cargo;
        if (institucion    !== null) body.institucion    = institucion;
        const reviso_nombre  = document.getElementById('det-reviso-nombre')?.value  ?? null;
        const reviso_puesto  = document.getElementById('det-reviso-puesto')?.value  ?? null;
        const elaboro_nombre = document.getElementById('det-elaboro-nombre')?.value ?? null;
        const elaboro_puesto = document.getElementById('det-elaboro-puesto')?.value ?? null;
        if (reviso_nombre  !== null) body.reviso_nombre  = reviso_nombre;
        if (reviso_puesto  !== null) body.reviso_puesto  = reviso_puesto;
        if (elaboro_nombre !== null) body.elaboro_nombre = elaboro_nombre;
        if (elaboro_puesto !== null) body.elaboro_puesto = elaboro_puesto;
        if (ur           !== undefined && ur           !== null) body.url_solicitante    = ur;
    }

    try {
        await api('PUT', `/oficios/${id}`, body);
        toast('Documento actualizado', 'success');
        closeModal('modal-oficio');
        if (state.view === 'historial') loadHistorial();
        if (state.view === 'dashboard') loadDashboard();
    } catch (e) {
        toast(e.message, 'error');
    }
}

function onAcuseFileSelected(input, id) {
    const row = document.getElementById('acuse-selected-row');
    const nameEl = document.getElementById('acuse-selected-name');
    if (input.files[0]) {
        nameEl.textContent = input.files[0].name;
        row.classList.remove('hidden');
        document.getElementById('acuse-upload-btn').onclick = () => uploadAcuse(id);
    } else {
        row.classList.add('hidden');
    }
}

async function uploadAcuse(id) {
    const file = document.getElementById('det-acuse-file')?.files[0];
    if (!file) { toast('Selecciona un archivo PDF', 'error'); return; }
    const fd = new FormData();
    fd.append('acuse', file);
    try {
        await api('POST', `/oficios/${id}/acuse`, fd, true);
        const sel = document.getElementById('det-estatus');
        if (sel) {
            sel.value = 'archivado';
            document.getElementById('acuse-wrapper').style.display = '';
        }
        toast('Acuse subido — estatus cambiado a Archivado', 'success');
        if (state.view === 'historial') loadHistorial();
        if (state.view === 'dashboard') loadDashboard();
        openOficioModal(id);
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function viewAcuse(id) {
    try {
        const res = await fetch(`/api/oficios/${id}/acuse`, {
            headers: { Authorization: `Bearer ${state.token}` },
        });
        if (!res.ok) { toast('Acuse no disponible', 'error'); return; }
        const blob = await res.blob();
        const url = URL.createObjectURL(new Blob([await blob.arrayBuffer()], { type: 'application/pdf' }));
        window.open(url, '_blank');
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function downloadAcuse(id) {
    try {
        const res = await fetch(`/api/oficios/${id}/acuse`, {
            headers: { Authorization: `Bearer ${state.token}` },
        });
        if (!res.ok) { toast('Acuse no disponible', 'error'); return; }
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `Acuse_${id}.pdf`;
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function deleteAcuse(id) {
    if (!confirm('¿Eliminar el acuse adjunto? El estatus regresará a Borrador.')) return;
    try {
        await api('DELETE', `/oficios/${id}/acuse`);
        toast('Acuse eliminado — estatus regresado a Borrador', 'success');
        if (state.view === 'historial') loadHistorial();
        if (state.view === 'dashboard') loadDashboard();
        openOficioModal(id);
    } catch (e) {
        toast(e.message, 'error');
    }
}

// ── Firmantes ────────────────────────────────────────
async function loadFirmantes() {
    try {
        const firmantes = await api('GET', '/firmantes');
        state.firmantes = firmantes;
        document.getElementById('firmantes-tbody').innerHTML = firmantes.map(f => `
      <tr>
        <td>${f.nombre}</td>
        <td>${f.cargo}</td>
        <td>${f.es_titular ? '<span class="titular-badge">Titular</span>' : '—'}</td>
        <td><span class="status-badge ${f.activo ? 'status-recibido' : 'status-archivado'}">${f.activo ? 'Activo' : 'Inactivo'}</span></td>
        <td>
          <div class="table-actions">
            <button class="btn btn-secondary btn-sm" onclick="openFirmanteModal(${f.id})">Editar</button>
            ${!f.es_titular ? `<button class="btn btn-danger btn-sm" onclick="deleteFirmante(${f.id})">Eliminar</button>` : ''}
          </div>
        </td>
      </tr>
    `).join('');
    } catch (e) {
        toast(e.message, 'error');
    }
}

function openFirmanteModal(id = null) {
    const f = id ? state.firmantes.find(x => x.id === id) : null;
    document.getElementById('modal-title').textContent = f ? 'Editar Firmante' : 'Nuevo Firmante';
    document.getElementById('modal-body').innerHTML = `
    <div class="form-group" style="margin-bottom:16px">
      <label>Nombre *</label>
      <input type="text" id="fm-nombre" value="${f?.nombre || ''}" placeholder="Nombre completo" />
    </div>
    <div class="form-group" style="margin-bottom:16px">
      <label>Cargo *</label>
      <input type="text" id="fm-cargo" value="${f?.cargo || ''}" placeholder="Cargo o puesto" />
    </div>
    <div class="form-group" style="margin-bottom:10px">
      <label style="flex-direction:row;align-items:center;gap:8px;text-transform:none;letter-spacing:0;font-size:13px;font-weight:500">
        <input type="checkbox" id="fm-titular" ${f?.es_titular ? 'checked' : ''} />
        Es titular
      </label>
    </div>
    ${f ? `
    <div class="form-group">
      <label style="flex-direction:row;align-items:center;gap:8px;text-transform:none;letter-spacing:0;font-size:13px;font-weight:500">
        <input type="checkbox" id="fm-activo" ${f.activo ? 'checked' : ''} />
        Activo
      </label>
    </div>` : ''}
  `;
    document.getElementById('modal-footer').innerHTML = `
    <button class="btn btn-secondary" onclick="closeModal('modal-generic')">Cancelar</button>
    <button class="btn btn-primary" onclick="saveFirmante(${id ?? 'null'})">Guardar</button>
  `;
    openModal('modal-generic');
}

async function saveFirmante(id) {
    const nombre = document.getElementById('fm-nombre').value.trim();
    const cargo = document.getElementById('fm-cargo').value.trim();
    const es_titular = document.getElementById('fm-titular').checked;
    const activoEl = document.getElementById('fm-activo');
    if (!nombre || !cargo) { toast('Nombre y cargo son requeridos', 'error'); return; }
    try {
        if (id) {
            await api('PUT', `/firmantes/${id}`, { nombre, cargo, es_titular, activo: activoEl ? activoEl.checked : undefined });
        } else {
            await api('POST', '/firmantes', { nombre, cargo, es_titular });
        }
        toast('Firmante guardado', 'success');
        closeModal('modal-generic');
        loadFirmantes();
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function deleteFirmante(id) {
    if (!confirm('¿Eliminar este firmante?')) return;
    try {
        await api('DELETE', `/firmantes/${id}`);
        toast('Firmante eliminado', 'success');
        loadFirmantes();
    } catch (e) {
        toast(e.message, 'error');
    }
}

// ── Años ─────────────────────────────────────────────
async function loadAnios() {
    try {
        const anios = await api('GET', '/anios');
        state.anios = anios;
        const corrCell = (inicio, actual, prefix) => {
            const last = actual > 0 ? `<span style="font-family:monospace;font-size:11px;color:var(--ine-purple)">${prefix}${String(actual).padStart(3,'0')}</span>` : '—';
            return `<td style="text-align:center"><span style="font-size:11px;color:#9ca3af">${inicio} →</span> ${actual} ${last}</td>`;
        };
        document.getElementById('anios-tbody').innerHTML = anios.map(a => `
      <tr>
        <td><strong>${a.anio}</strong></td>
        ${corrCell(a.correlativo_inicio, a.correlativo_actual, `INE/DEAJ/`)}
        ${corrCell(a.correlativo_opinion_inicio ?? 1, a.correlativo_opinion_actual ?? 0, `OTJ/`)}
        ${corrCell(a.correlativo_dictamen_inicio ?? 1, a.correlativo_dictamen_actual ?? 0, `DTJ/`)}
        ${corrCell(a.correlativo_certificacion_inicio ?? 1, a.correlativo_certificacion_actual ?? 0, `DEAJ-`)}
        <td><span class="status-badge ${a.activo ? 'status-recibido' : 'status-archivado'}">${a.activo ? 'Activo' : 'Inactivo'}</span></td>
        <td>
          <div class="table-actions">
            ${!a.activo ? `<button class="btn btn-primary btn-sm" onclick="activarAnio(${a.id})">Activar</button>` : ''}
            <button class="btn btn-secondary btn-sm" onclick="openAnioModal(${a.id})">Editar</button>
            ${!a.activo ? `<button class="btn btn-danger btn-sm" onclick="deleteAnio(${a.id})">Eliminar</button>` : ''}
          </div>
        </td>
      </tr>
    `).join('');
    } catch (e) {
        toast(e.message, 'error');
    }
}

function openAnioModal(id = null) {
    const a = id ? state.anios.find(x => x.id === id) : null;
    document.getElementById('modal-title').textContent = a ? 'Editar Correlativos' : 'Nuevo Año';
    document.getElementById('modal-body').innerHTML = `
    ${!a ? `<div class="form-group" style="margin-bottom:16px">
      <label>Año *</label>
      <input type="number" id="an-anio" value="${new Date().getFullYear()}" min="2020" max="2099" />
    </div>` : ''}
    <p style="font-size:12px;color:#6b7280;margin-bottom:12px">Correlativo inicial por tipo de instrumento</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="form-group">
        <label>Oficios *</label>
        <input type="number" id="an-correlativo" value="${a?.correlativo_inicio ?? 1}" min="1" />
      </div>
      <div class="form-group">
        <label>Opiniones Técnicas</label>
        <input type="number" id="an-correlativo-opinion" value="${a?.correlativo_opinion_inicio ?? 1}" min="1" />
      </div>
      <div class="form-group">
        <label>Dictámenes</label>
        <input type="number" id="an-correlativo-dictamen" value="${a?.correlativo_dictamen_inicio ?? 1}" min="1" />
      </div>
      <div class="form-group">
        <label>Certificaciones</label>
        <input type="number" id="an-correlativo-certificacion" value="${a?.correlativo_certificacion_inicio ?? 1}" min="1" />
      </div>
    </div>
  `;
    document.getElementById('modal-footer').innerHTML = `
    <button class="btn btn-secondary" onclick="closeModal('modal-generic')">Cancelar</button>
    <button class="btn btn-primary" onclick="saveAnio(${id ?? 'null'})">Guardar</button>
  `;
    openModal('modal-generic');
}

async function saveAnio(id) {
    const correlativo_inicio              = parseInt(document.getElementById('an-correlativo').value) || 1;
    const correlativo_opinion_inicio      = parseInt(document.getElementById('an-correlativo-opinion').value) || 1;
    const correlativo_dictamen_inicio     = parseInt(document.getElementById('an-correlativo-dictamen').value) || 1;
    const correlativo_certificacion_inicio = parseInt(document.getElementById('an-correlativo-certificacion').value) || 1;
    if (!correlativo_inicio) { toast('Correlativo de oficios requerido', 'error'); return; }
    const body = { correlativo_inicio, correlativo_opinion_inicio, correlativo_dictamen_inicio, correlativo_certificacion_inicio };
    try {
        if (id) {
            await api('PUT', `/anios/${id}`, body);
        } else {
            const anio = parseInt(document.getElementById('an-anio').value);
            if (!anio) { toast('Año requerido', 'error'); return; }
            await api('POST', '/anios', { anio, ...body });
        }
        toast('Año guardado', 'success');
        closeModal('modal-generic');
        loadAnios();
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function activarAnio(id) {
    if (!confirm('¿Activar este año? El año activo actual será desactivado.')) return;
    try {
        await api('PUT', `/anios/${id}/activar`);
        toast('Año activado', 'success');
        loadAnios();
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function deleteAnio(id) {
    if (!confirm('¿Eliminar este año?')) return;
    try {
        await api('DELETE', `/anios/${id}`);
        toast('Año eliminado', 'success');
        loadAnios();
    } catch (e) {
        toast(e.message, 'error');
    }
}

// ── Usuarios ──────────────────────────────────────────
async function loadUsuarios() {
    try {
        const usuarios = await api('GET', '/usuarios');
        state.usuarios = usuarios;
        document.getElementById('usuarios-tbody').innerHTML = usuarios.map(u => `
      <tr>
        <td>${u.nombre}</td>
        <td>${u.email}</td>
        <td><span class="status-badge ${u.rol === 'admin' ? 'status-enviado' : 'status-borrador'}">${u.rol}</span></td>
        <td><span class="status-badge ${u.activo ? 'status-recibido' : 'status-archivado'}">${u.activo ? 'Activo' : 'Inactivo'}</span></td>
        <td>${formatFecha(u.creado_en)}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn-secondary btn-sm" onclick="openUsuarioModal(${u.id})">Editar</button>
            ${u.activo
                ? `<button class="btn btn-danger btn-sm" onclick="toggleUsuario(${u.id}, false)">Desactivar</button>`
                : `<button class="btn btn-secondary btn-sm" onclick="toggleUsuario(${u.id}, true)">Activar</button>`}
          </div>
        </td>
      </tr>
    `).join('');
    } catch (e) {
        toast(e.message, 'error');
    }
}

function openUsuarioModal(id = null) {
    const u = id ? state.usuarios.find(x => x.id === id) : null;
    document.getElementById('modal-title').textContent = u ? 'Editar Usuario' : 'Nuevo Usuario';
    document.getElementById('modal-body').innerHTML = `
    <div class="form-group" style="margin-bottom:16px">
      <label>Nombre *</label>
      <input type="text" id="us-nombre" value="${u?.nombre || ''}" placeholder="Nombre completo" />
    </div>
    <div class="form-group" style="margin-bottom:16px">
      <label>Email *</label>
      <input type="email" id="us-email" value="${u?.email || ''}" placeholder="correo@ine.mx" />
    </div>
    <div class="form-group" style="margin-bottom:16px">
      <label>${u ? 'Nueva contraseña (dejar vacío para no cambiar)' : 'Contraseña *'}</label>
      <input type="password" id="us-password" placeholder="••••••••" />
    </div>
    <div class="form-group">
      <label>Rol</label>
      <select id="us-rol">
        <option value="usuario" ${u?.rol !== 'admin' ? 'selected' : ''}>Usuario</option>
        <option value="admin"   ${u?.rol === 'admin' ? 'selected' : ''}>Administrador</option>
      </select>
    </div>
  `;
    document.getElementById('modal-footer').innerHTML = `
    <button class="btn btn-secondary" onclick="closeModal('modal-generic')">Cancelar</button>
    <button class="btn btn-primary" onclick="saveUsuario(${id ?? 'null'})">Guardar</button>
  `;
    openModal('modal-generic');
}

async function saveUsuario(id) {
    const nombre = document.getElementById('us-nombre').value.trim();
    const email = document.getElementById('us-email').value.trim();
    const password = document.getElementById('us-password').value;
    const rol = document.getElementById('us-rol').value;
    if (!nombre || !email) { toast('Nombre y email son requeridos', 'error'); return; }
    if (!id && !password) { toast('La contraseña es requerida', 'error'); return; }
    const body = { nombre, email, rol };
    if (password) body.password = password;
    try {
        if (id) {
            await api('PUT', `/usuarios/${id}`, body);
        } else {
            await api('POST', '/usuarios', body);
        }
        toast('Usuario guardado', 'success');
        closeModal('modal-generic');
        loadUsuarios();
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function toggleUsuario(id, activo) {
    try {
        await api('PUT', `/usuarios/${id}`, { activo });
        toast(`Usuario ${activo ? 'activado' : 'desactivado'}`, 'success');
        loadUsuarios();
    } catch (e) {
        toast(e.message, 'error');
    }
}

// ── Modal helpers ─────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// =====================================================
// Listeners estáticos
// =====================================================

// Navegación
document.querySelectorAll('.nav-item[data-view]').forEach(item =>
    item.addEventListener('click', e => { e.preventDefault(); showView(item.dataset.view); })
);

// Contador de caracteres — formulario de nuevo documento
setupCharCounter('of-asunto', 500);


// Logout
document.getElementById('logout-btn').addEventListener('click', () => {
    logout();
});

// Hamburger (mobile)
const hamburger = document.getElementById('nav-hamburger');
const topnavNav = document.getElementById('topnav-nav');
hamburger.addEventListener('click', e => {
    e.stopPropagation();
    topnavNav.classList.toggle('mobile-open');
});
topnavNav.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => topnavNav.classList.remove('mobile-open'));
});
document.addEventListener('click', e => {
    if (!topnavNav.contains(e.target) && !hamburger.contains(e.target)) {
        topnavNav.classList.remove('mobile-open');
    }
});

// Nuevo oficio – submit
document.getElementById('nuevo-oficio-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('btn-generar');
    const errEl = document.getElementById('nuevo-error');
    const spinner = btn.querySelector('.btn-spinner');
    const text = btn.querySelector('.btn-text');

    errEl.classList.add('hidden');
    text.classList.add('hidden');
    spinner.classList.remove('hidden');
    btn.disabled = true;

    try {
        const tipo            = currentTipo;
        const isOpinion       = tipo === 'opinion';
        const isDictamen      = tipo === 'dictamen';
        const isCertificacion = tipo === 'certificacion';
        const needsUR         = isOpinion || isDictamen;
        const body = {
            tipo,
            fecha: document.getElementById('of-fecha').value,
            asunto: document.getElementById('of-asunto').value,
            sintesis: document.getElementById('of-sintesis').value || undefined,
            cuerpo: document.getElementById('of-cuerpo').value || undefined,
            id_sai: document.getElementById('of-id-sai').value || undefined,
            firmante_id: document.getElementById('of-firmante').value,
            solicita: document.getElementById('of-solicita').value,
            area: document.getElementById('of-area').value,
            justificacion_firmante: document.getElementById('of-justificacion').value || undefined,
            institucion:    document.getElementById('of-institucion').value    || undefined,
            reviso_nombre:  document.getElementById('of-reviso-nombre').value  || undefined,
            reviso_puesto:  document.getElementById('of-reviso-puesto').value  || undefined,
            elaboro_nombre: document.getElementById('of-elaboro-nombre').value || undefined,
            elaboro_puesto: document.getElementById('of-elaboro-puesto').value || undefined,
            ...(needsUR
                ? { url_solicitante: document.getElementById('of-url-solicitante').value }
                : { destinatario: document.getElementById('of-destinatario').value,
                    cargo_destinatario: document.getElementById('of-cargo').value }),
        };
        const oficio = await api('POST', '/oficios/generar', body);
        document.getElementById('numero-generado').textContent = oficio.numero_oficio;
        document.getElementById('numero-preview').classList.remove('hidden');
        const label = isDictamen ? 'Dictamen' : isCertificacion ? 'Certificación' : isOpinion ? 'Opinión Técnica' : 'Oficio';
        toast(`${label} ${oficio.numero_oficio} generado`, 'success');
        document.getElementById('nuevo-oficio-form').reset();
        document.getElementById('justificacion-group').style.display = 'none';
        applyTipoToggle(currentTipo);
        const todayAfter = cdmxToday();
        document.getElementById('of-fecha').value = todayAfter;
        document.getElementById('of-fecha-display').textContent = formatFecha(todayAfter);
    } catch (ex) {
        errEl.textContent = ex.message;
        errEl.classList.remove('hidden');
    } finally {
        text.classList.remove('hidden');
        spinner.classList.add('hidden');
        btn.disabled = false;
    }
});

// Toggle campos según tipo de documento
function applyTipoToggle(tipo) {
    const needsUR = tipo === 'opinion' || tipo === 'dictamen';
    document.getElementById('destinatario-group').style.display = needsUR ? 'none' : '';
    document.getElementById('cargo-group').style.display = needsUR ? 'none' : '';
    document.getElementById('url-solicitante-group').style.display = needsUR ? '' : 'none';
    document.getElementById('of-destinatario').required = !needsUR;
    document.getElementById('of-cargo').required = !needsUR;
    document.getElementById('of-url-solicitante').required = needsUR;
}
// Justificación condicional
document.getElementById('of-firmante').addEventListener('change', function () {
    const firmante = state.firmantes.find(f => f.id == this.value);
    const group = document.getElementById('justificacion-group');
    const textarea = document.getElementById('of-justificacion');
    if (firmante && !firmante.es_titular) {
        group.style.display = '';
        textarea.required = true;
    } else {
        group.style.display = 'none';
        textarea.required = false;
        textarea.value = '';
    }
});

// Limpiar form nuevo oficio
document.getElementById('btn-limpiar').addEventListener('click', () => {
    document.getElementById('nuevo-oficio-form').reset();
    document.getElementById('of-cuerpo').value = '';
    document.getElementById('justificacion-group').style.display = 'none';
    applyTipoToggle(currentTipo);
    document.getElementById('numero-preview').classList.add('hidden');
    document.getElementById('nuevo-error').classList.add('hidden');
    const todayClean = cdmxToday();
    document.getElementById('of-fecha').value = todayClean;
    document.getElementById('of-fecha-display').textContent = formatFecha(todayClean);
});

// Copiar número
document.getElementById('btn-copy-numero').addEventListener('click', () => {
    const num = document.getElementById('numero-generado').textContent;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(num).then(() => toast('Número copiado', 'success'));
    } else {
        const ta = document.createElement('textarea');
        ta.value = num;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast('Número copiado', 'success');
    }
});

// Historial – filtrar
function getHistorialFiltros() {
    return {
        q: document.getElementById('filter-q').value,
        fecha_inicio: document.getElementById('filter-fecha-inicio').value,
        fecha_fin: document.getElementById('filter-fecha-fin').value,
        tipo: document.getElementById('filter-tipo').value,
        estatus: document.getElementById('filter-estatus').value,
    };
}

// Pestañas de tipo en historial
document.querySelectorAll('.tipo-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tipo-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('filter-tipo').value = tab.dataset.tipo;
        historialPage = 1;
        loadHistorial(getHistorialFiltros());
    });
});

document.getElementById('btn-filtrar').addEventListener('click', () => {
    historialPage = 1;
    loadHistorial(getHistorialFiltros());
});

document.getElementById('historial-page-size').addEventListener('change', e => {
    historialPageSize = parseInt(e.target.value);
    historialPage = 1;
    renderHistorialTable(state.oficios);
});
document.getElementById('filter-q').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-filtrar').click();
});
document.getElementById('btn-limpiar-filtros').addEventListener('click', () => {
    ['filter-q', 'filter-fecha-inicio', 'filter-fecha-fin', 'filter-tipo', 'filter-estatus'].forEach(id => {
        document.getElementById(id).value = '';
    });
    document.querySelectorAll('.tipo-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.tipo-tab[data-tipo=""]').classList.add('active');
    loadHistorial();
});

// Exportar Excel
document.getElementById('btn-export-excel').addEventListener('click', () => {
    fetchDownload(`/api/exportar/excel?${new URLSearchParams(getHistorialFiltros())}`, 'Documentos_DEAJ.xlsx');
});

// ── Carga masiva ────────────────────────────────────
document.getElementById('btn-carga-masiva').addEventListener('click', () => {
    document.getElementById('carga-masiva-file').value = '';
    document.getElementById('carga-masiva-errores').classList.add('hidden');
    document.getElementById('carga-masiva-resultado').classList.add('hidden');
    document.getElementById('modal-carga-masiva').classList.remove('hidden');
});

document.getElementById('modal-carga-masiva-close').addEventListener('click', () => {
    document.getElementById('modal-carga-masiva').classList.add('hidden');
});
document.getElementById('btn-carga-masiva-cancelar').addEventListener('click', () => {
    document.getElementById('modal-carga-masiva').classList.add('hidden');
});

document.getElementById('btn-descargar-plantilla').addEventListener('click', async (e) => {
    e.preventDefault();
    fetchDownload('/api/of/oficios/carga-masiva/plantilla', 'plantilla_carga_masiva.xlsx');
});

document.getElementById('btn-carga-masiva-subir').addEventListener('click', async () => {
    const fileInput = document.getElementById('carga-masiva-file');
    const erroresEl = document.getElementById('carga-masiva-errores');
    const resultadoEl = document.getElementById('carga-masiva-resultado');
    erroresEl.classList.add('hidden');
    resultadoEl.classList.add('hidden');

    if (!fileInput.files.length) { toast('Selecciona un archivo primero', 'error'); return; }

    const btn = document.getElementById('btn-carga-masiva-subir');
    btn.disabled = true;
    btn.textContent = 'Procesando...';

    try {
        const fd = new FormData();
        fd.append('archivo', fileInput.files[0]);
        const opts = { method: 'POST', headers: { Authorization: `Bearer ${state.token}` }, body: fd };
        const res = await fetch('/api/of/oficios/carga-masiva', opts);
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            if (data.errores?.length) {
                let html = `<strong style="color:#dc2626">⚠ ${data.error}</strong><ul style="margin:8px 0 0 16px;list-style:disc">`;
                data.errores.forEach(({ fila, errores }) => {
                    html += `<li><strong>Fila ${fila}:</strong> ${errores.join(', ')}</li>`;
                });
                html += '</ul>';
                erroresEl.innerHTML = html;
                erroresEl.classList.remove('hidden');
            } else {
                toast(data.error || 'Error al procesar', 'error');
            }
            return;
        }

        resultadoEl.innerHTML = `<strong style="color:#16a34a">✓ ${data.creados} oficios creados exitosamente</strong>
            <ul style="margin:8px 0 0 16px;list-style:disc;max-height:140px;overflow-y:auto">
              ${data.numeros.map(n => `<li style="font-size:12px">${n}</li>`).join('')}
            </ul>`;
        resultadoEl.classList.remove('hidden');
        fileInput.value = '';
        toast(`${data.creados} oficios creados`, 'success');
        loadHistorial(getHistorialFiltros());
    } catch (e) {
        toast(e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '⬆ Procesar archivo';
    }
});

// Exportar Word (oficio individual)
async function downloadDocx(id) {
    try {
        const res = await fetch(`/api/exportar/docx/${id}`, {
            headers: { Authorization: `Bearer ${state.token}` },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            toast(err.error || 'Error al generar Word', 'error');
            return;
        }
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="([^"]+)"/);
        const filename = match ? match[1] : `oficio_${id}.docx`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast('Documento Word generado', 'success');
    } catch (e) {
        toast(e.message, 'error');
    }
}

// Botones "Nuevo" de catálogos
document.getElementById('btn-nuevo-firmante').addEventListener('click', () => openFirmanteModal());
document.getElementById('btn-nuevo-anio').addEventListener('click', () => openAnioModal());
document.getElementById('btn-nuevo-usuario').addEventListener('click', () => openUsuarioModal());

// Cerrar modales
document.getElementById('modal-close').addEventListener('click', () => closeModal('modal-generic'));
document.getElementById('modal-oficio-close').addEventListener('click', () => closeModal('modal-oficio'));
document.getElementById('modal-generic').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal('modal-generic');
});
document.getElementById('modal-oficio').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal('modal-oficio');
});

// =====================================================
// Inicialización
// =====================================================
async function initApp() {
    // SSO desde el portal
    const ssoToken = new URLSearchParams(location.search).get('sso_token')
    if (ssoToken) { window.location.href = `/api/of/auth/sso?sso_token=${ssoToken}`; return }

    if (!state.token) { window.location.replace('/'); return; }

    try {
        const res = await fetch('/api/of/auth/me', { headers: { Authorization: `Bearer ${state.token}` } });
        if (!res.ok) { logout(); return; }
        const json = await res.json();
        state.user = json.user;
    } catch {
        logout();
        return;
    }

    // Secciones solo para admin
    const isAdmin = state.user.rol === 'admin';
    document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = isAdmin ? '' : 'none';
    });

    // Info de usuario en topnav
    document.getElementById('user-avatar').textContent = state.user.nombre[0].toUpperCase();
    document.getElementById('user-name').textContent = state.user.nombre;
    document.getElementById('user-role').textContent = isAdmin ? 'Administrador' : 'Usuario';

    document.getElementById('auth-loading').style.display = 'none';
    document.getElementById('app').classList.remove('hidden');

    showView('dashboard');
}

initApp();
