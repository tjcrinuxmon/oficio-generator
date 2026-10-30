// =====================================================
// routes/cargaMasiva.js — Generación masiva de documentos desde Excel
//   GET  /api/oficios/carga-masiva/plantilla  → plantilla con catálogos (listas desplegables)
//   POST /api/oficios/carga-masiva            → valida todas las filas y, si no hay errores,
//                                               genera los números en una sola transacción
// Usa las mismas reglas y numeración que la generación individual (lib/documentos.js).
// Se monta dentro del router de oficios, así que ya trae req.user.
// =====================================================
const express = require('express');
const multer = require('multer');
const { Readable } = require('stream');
const ExcelJS = require('exceljs');
const db = require('../database');
const { puedeCvic, URS, JUSTIFICACION_SAI_CVIC, validarDocumento, insertarDocumento } = require('../lib/documentos');

const router = express.Router();

const MAX_FILAS = 300;
const PRIMERA_FILA_DATOS = 5; // 1 encabezado · 2 notas · 3 leyenda · 4 ejemplo
const GRIS_OXFORD = 'FF454247', GRIS_MEDIO = 'FF828A91', GRIS_CLARO = 'FFF1F2F3', BEIGE = 'FFC5A989';

// ── Catálogos ─────────────────────────────────────────
// Tipo de documento tal como aparece en la lista de la plantilla.
const TIPOS = [
  { etiqueta: 'Oficio',                          tipo: 'oficio' },
  { etiqueta: 'Opinión Técnica',                 tipo: 'opinion' },
  { etiqueta: 'Dictamen',                        tipo: 'dictamen' },
  { etiqueta: 'Certificación',                   tipo: 'certificacion' },
  { etiqueta: 'Oficio CVIC - Presidencia',       tipo: 'cvic', modalidad: 'presidencia',        cvic: true },
  { etiqueta: 'Oficio CVIC - Secretaría Técnica', tipo: 'cvic', modalidad: 'secretaria_tecnica', cvic: true },
];
const NO_APLICA = 'No aplica';
const AMBITOS = ['Interno', 'Externo'];
const SI_NO = ['Sí', 'No'];

// Compara sin acentos, mayúsculas ni signos ("Opinión Técnica" = "opinion tecnica").
const clave = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const TIPO_POR_CLAVE = new Map();
TIPOS.forEach(t => TIPO_POR_CLAVE.set(clave(t.etiqueta), t));
// Códigos cortos de la plantilla anterior y variantes comunes.
[['oficio', 0], ['opinion', 1], ['opinion tecnica', 1], ['dictamen', 2], ['certificacion', 3],
 ['cvic', 4], ['cvic presidencia', 4], ['oficio cvic', 4], ['oficio cvic presidencia', 4],
 ['cvic st', 5], ['cvic secretaria tecnica', 5], ['oficio cvic st', 5], ['oficio cvic secretaria tecnica', 5]]
  .forEach(([k, i]) => TIPO_POR_CLAVE.set(k, TIPOS[i]));

// ── Columnas de la plantilla ──────────────────────────
// alias: encabezados equivalentes que se aceptan al leer (plantillas anteriores).
const COLUMNAS = [
  { key: 'tipo',                   header: 'tipo *',                 width: 30, nota: 'Elige de la lista' },
  { key: 'fecha',                  header: 'fecha',                  width: 14, nota: 'AAAA-MM-DD · vacía = hoy' },
  { key: 'destinatario',           header: 'destinatario',           width: 30, nota: 'Oficios, certificaciones y CVIC' },
  { key: 'cargo_destinatario',     header: 'cargo_destinatario',     width: 26, nota: 'Oficios y certificaciones' },
  { key: 'institucion',            header: 'institucion',            width: 24, nota: 'Opcional' },
  { key: 'requirente',             header: 'requirente',             width: 40, nota: 'Opiniones y dictámenes: elige la UR', alias: ['solicitante', 'url_solicitante'] },
  { key: 'asunto',                 header: 'asunto *',               width: 40, nota: 'Máx. 500 caracteres' },
  { key: 'sintesis',               header: 'sintesis *',             width: 32, nota: 'Síntesis o resumen' },
  { key: 'cuerpo',                 header: 'cuerpo',                 width: 30, nota: 'Texto del documento (opcional)' },
  { key: 'solicita',               header: 'solicita *',             width: 26, nota: 'Nombre de quien solicita' },
  { key: 'firmante',               header: 'firmante',               width: 34, nota: 'Vacío = titular, o Presidencia / Secretaría Técnica en CVIC' },
  { key: 'justificacion_firmante', header: 'justificacion_firmante', width: 30, nota: 'Solo si no firma la titular (no aplica en CVIC)' },
  { key: 'id_sai',                 header: 'id_sai',                 width: 14, nota: 'Número SAI o "No aplica" · CVIC vacío = No aplica' },
  { key: 'justificacion_sai',      header: 'justificacion_sai',      width: 30, nota: 'Obligatoria con "No aplica" (excepto CVIC)' },
  { key: 'ambito',                 header: 'ambito',                 width: 12, nota: 'Interno o Externo · vacío = Interno' },
  { key: 'incluir_vre',            header: 'incluir_vre',            width: 12, nota: 'Solo externos: tabla Validó/Revisó/Elaboró' },
  { key: 'reviso_nombre',          header: 'reviso_nombre',          width: 24, nota: 'Opcional' },
  { key: 'reviso_puesto',          header: 'reviso_puesto',          width: 24, nota: 'Opcional' },
  { key: 'elaboro_nombre',         header: 'elaboro_nombre',         width: 24, nota: 'Opcional' },
  { key: 'elaboro_puesto',         header: 'elaboro_puesto',         width: 24, nota: 'Opcional' },
];
const LETRA = (key) => String.fromCharCode(65 + COLUMNAS.findIndex(c => c.key === key)); // A..T
const COLUMNA_POR_ENCABEZADO = new Map();
COLUMNAS.forEach(c => [c.key, ...(c.alias || [])].forEach(h => COLUMNA_POR_ENCABEZADO.set(clave(h), c.key)));
COLUMNA_POR_ENCABEZADO.set('razon', 'razon');

// Filas de ayuda de la plantilla: se reconocen al leer y se saltan.
const LEYENDA = '* = obligatorio. Los datos van a partir de la fila 5; esta fila, las notas y el ejemplo se ignoran al procesar.';
const EJEMPLO = { destinatario: 'Lic. Ejemplo Apellido', asunto: 'Asunto del oficio de ejemplo' };

function firmantesDisponibles(user) {
  const deaj = db.prepare(`SELECT id, nombre, es_titular, cvic_rol, ambito FROM firmantes WHERE activo = 1 AND ambito IN ('deaj', 'ambos') ORDER BY es_titular DESC, nombre`).all();
  const cvic = puedeCvic(user)
    ? db.prepare(`SELECT id, nombre, es_titular, cvic_rol, ambito FROM firmantes WHERE activo = 1 AND cvic_rol IS NOT NULL ORDER BY nombre`).all()
    : [];
  const vistos = new Set();
  return [...deaj, ...cvic].filter(f => !vistos.has(f.id) && vistos.add(f.id));
}

const hoyCdmx = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());

// ── GET /plantilla ────────────────────────────────────
router.get('/plantilla', async (req, res) => {
  try {
    const tipos = TIPOS.filter(t => !t.cvic || puedeCvic(req.user));
    const firmantes = firmantesDisponibles(req.user).map(f => f.nombre);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Oficios', { views: [{ state: 'frozen', ySplit: 1 }] });

    // Hoja oculta de catálogos: cada lista en su columna.
    const cat = wb.addWorksheet('_Catalogos', { state: 'hidden' });
    const listas = { A: tipos.map(t => t.etiqueta), B: firmantes, C: URS, D: [NO_APLICA], E: AMBITOS, F: SI_NO };
    for (const [col, valores] of Object.entries(listas)) valores.forEach((v, i) => { cat.getCell(`${col}${i + 1}`).value = v; });
    const rango = (col) => `_Catalogos!$${col}$1:$${col}$${Math.max(listas[col].length, 1)}`;

    ws.columns = COLUMNAS.map(({ key, header, width }) => ({ key, header, width }));
    const obligatoria = (c) => c.header.endsWith('*');
    ws.getRow(1).height = 22;
    COLUMNAS.forEach((c, i) => {
      const cell = ws.getRow(1).getCell(i + 1);
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: obligatoria(c) ? GRIS_OXFORD : GRIS_MEDIO } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    const notas = ws.addRow(COLUMNAS.map(c => c.nota));
    notas.height = 32;
    notas.eachCell(cell => {
      cell.font = { italic: true, color: { argb: GRIS_OXFORD }, size: 9 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS_CLARO } };
      cell.alignment = { vertical: 'middle', wrapText: true };
    });

    ws.addRow([LEYENDA]);
    ws.mergeCells(`A3:${LETRA('elaboro_puesto')}3`);
    ws.getCell('A3').font = { bold: true, color: { argb: GRIS_OXFORD }, size: 9 };

    const ejemplo = ws.addRow({
      tipo: 'Oficio', fecha: hoyCdmx(), destinatario: EJEMPLO.destinatario, cargo_destinatario: 'Director General',
      asunto: EJEMPLO.asunto, sintesis: 'Resumen breve del oficio', solicita: 'Nombre Apellido',
      firmante: firmantes[0] || '', ambito: 'Interno',
    });
    ejemplo.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F0EA' } }; cell.font = { size: 10, color: { argb: GRIS_MEDIO } }; });
    ws.getCell('A4').note = 'Fila de ejemplo: se ignora al procesar.';
    ws.getRow(4).getCell(1).border = { left: { style: 'thick', color: { argb: BEIGE } } };

    // Listas desplegables desde la fila 5.
    const desde = PRIMERA_FILA_DATOS, hasta = PRIMERA_FILA_DATOS + MAX_FILAS - 1;
    const lista = (key, col, estricta, titulo, mensaje) => ws.dataValidations.add(`${LETRA(key)}${desde}:${LETRA(key)}${hasta}`, {
      type: 'list', allowBlank: true, formulae: [rango(col)],
      showErrorMessage: estricta, errorStyle: 'stop', errorTitle: titulo, error: mensaje,
    });
    lista('tipo', 'A', true, 'Tipo no válido', 'Elige el tipo de documento de la lista.');
    if (firmantes.length) lista('firmante', 'B', true, 'Firmante no válido', 'Elige un firmante de la lista o deja la celda vacía.');
    lista('requirente', 'C', true, 'Requirente no válido', 'Elige la unidad responsable de la lista.');
    // ID SAI: la lista ofrece "No aplica", pero también se puede escribir el número.
    lista('id_sai', 'D', false);
    lista('ambito', 'E', true, 'Ámbito no válido', 'Elige Interno o Externo.');
    lista('incluir_vre', 'F', true, 'Valor no válido', 'Elige Sí o No.');
    ws.getColumn(LETRA('fecha')).numFmt = 'yyyy-mm-dd';

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_generacion_masiva.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('[carga-masiva/plantilla]', e);
    res.status(500).json({ error: 'No se pudo generar la plantilla' });
  }
});

// ── Lectura del archivo ───────────────────────────────
const subir = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(xlsx|csv)$/i.test(file.originalname)) cb(null, true);
    else cb(Object.assign(new Error('Sube la plantilla en formato .xlsx (o .csv). Si tienes un .xls, ábrelo y guárdalo como .xlsx.'), { status: 400 }));
  },
}).single('archivo');

// Valor "plano" de una celda de exceljs (texto enriquecido, fórmula, hipervínculo, fecha…).
function valorCelda(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if ('result' in v) return valorCelda(v.result);
    if ('text' in v) return valorCelda(v.text);
    return '';
  }
  return v;
}

async function leerFilas(file) {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(file.originalname)) await wb.csv.read(Readable.from([file.buffer.toString('utf8')]));
  else await wb.xlsx.load(file.buffer);
  const ws = wb.getWorksheet('Oficios') || wb.worksheets.find(w => !w.name.startsWith('_')) || wb.worksheets[0];
  if (!ws) return [];

  const columnas = {}; // número de columna → key
  ws.getRow(1).eachCell((cell, n) => {
    const key = COLUMNA_POR_ENCABEZADO.get(clave(String(valorCelda(cell.value)).replace(/\*/g, '')));
    if (key) columnas[n] = key;
  });

  const filas = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const datos = {};
    for (const [col, key] of Object.entries(columnas)) {
      const v = valorCelda(row.getCell(Number(col)).value);
      datos[key] = v instanceof Date ? v : String(v).trim();
    }
    if (Object.values(datos).every(v => v === '')) return; // fila vacía
    const tipoTxt = String(datos.tipo || '');
    if (n <= 4 && (tipoTxt === '' || tipoTxt.startsWith('* =') || tipoTxt === 'Elige de la lista')) return; // notas / leyenda
    if (datos.destinatario === EJEMPLO.destinatario && datos.asunto === EJEMPLO.asunto) return;      // ejemplo
    filas.push({ fila: n, datos });
  });
  return filas;
}

// Fecha de la fila → 'AAAA-MM-DD' o null si no se entiende.
function fechaIso(v) {
  if (v instanceof Date) return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// Convierte una fila de la plantilla al cuerpo que entiende validarDocumento().
// Devuelve { errores: [] } o { body, etiqueta }.
function interpretarFila(d, ctx) {
  const errores = [];
  const t = TIPO_POR_CLAVE.get(clave(d.tipo || 'oficio'));
  if (!t) return { errores: [`tipo "${d.tipo}" no está en el catálogo`] };
  if (t.cvic && !ctx.puedeCvic) return { errores: ['los oficios CVIC solo los genera la Comisión o un administrador'] };

  // Fecha: vacía = hoy. Fuera de hoy solo un administrador, y siempre dentro del año activo.
  let fecha = d.fecha === '' || d.fecha === undefined ? ctx.hoy : fechaIso(d.fecha);
  if (!fecha) errores.push('fecha no válida (usa AAAA-MM-DD)');
  else if (fecha !== ctx.hoy && !ctx.esAdmin) errores.push('solo un administrador puede usar una fecha distinta de hoy');
  else if (Number(fecha.slice(0, 4)) !== ctx.anio) errores.push(`la fecha debe ser de ${ctx.anio} (año activo)`);
  else if (fecha > ctx.hoy) errores.push('la fecha no puede ser futura');

  // Firmante: por nombre del catálogo; vacío = el que corresponde al tipo.
  let firmante = null;
  if (d.firmante) {
    firmante = ctx.firmantes.find(f => clave(f.nombre) === clave(d.firmante));
    if (!firmante) errores.push(`firmante "${d.firmante}" no está en el catálogo`);
  } else {
    firmante = t.cvic ? ctx.firmantes.find(f => f.cvic_rol === t.modalidad)
                      : ctx.firmantes.find(f => f.es_titular && f.ambito !== 'cvic');
    if (!firmante) errores.push(t.cvic ? `no hay firmante de ${t.modalidad === 'presidencia' ? 'Presidencia' : 'Secretaría Técnica'} en el catálogo` : 'no hay titular activo en el catálogo');
  }

  // Requirente (opiniones y dictámenes): del catálogo de UR.
  let requirente = '';
  if (t.tipo === 'opinion' || t.tipo === 'dictamen') {
    requirente = URS.find(u => clave(u) === clave(d.requirente)) || '';
    if (!d.requirente) errores.push('falta el requirente (UR)');
    else if (!requirente) errores.push(`requirente "${d.requirente}" no está en el catálogo`);
  }

  // ID SAI: número, "No aplica" o vacío (queda pendiente). En CVIC, vacío = No aplica.
  let id_sai = '', justificacion_sai = String(d.justificacion_sai || '').trim();
  const sai = String(d.id_sai ?? '').trim();
  if (clave(sai) === clave(NO_APLICA) || (!sai && t.cvic)) {
    if (!justificacion_sai) {
      if (t.cvic) justificacion_sai = JUSTIFICACION_SAI_CVIC;
      else errores.push('con ID SAI "No aplica" se requiere justificacion_sai');
    }
  } else if (sai) {
    if (!/^\d{1,10}$/.test(sai)) errores.push('id_sai debe ser numérico (máx. 10 dígitos) o "No aplica"');
    id_sai = sai;
    justificacion_sai = '';
  }

  const ambito = clave(d.ambito) === 'externo' ? 'externo' : 'interno';
  if (d.ambito && !['interno', 'externo'].includes(clave(d.ambito))) errores.push('ámbito debe ser Interno o Externo');
  if (!d.asunto) errores.push('falta el asunto');
  else if (String(d.asunto).length > 500) errores.push('el asunto excede 500 caracteres');
  if (!d.sintesis) errores.push('falta la síntesis');
  if (!d.solicita) errores.push('falta quien solicita');
  if (t.tipo !== 'opinion' && t.tipo !== 'dictamen' && !d.destinatario) errores.push('falta el destinatario');
  if ((t.tipo === 'oficio' || t.tipo === 'certificacion') && !d.cargo_destinatario) errores.push('falta el cargo del destinatario');
  if (!t.cvic && firmante && !firmante.es_titular && !d.justificacion_firmante) errores.push(`falta justificacion_firmante (no firma la titular)`);
  if (errores.length) return { errores };

  return {
    etiqueta: t.etiqueta,
    body: {
      tipo: t.tipo, modalidad_cvic: t.modalidad, fecha, area: ctx.area,
      destinatario: d.destinatario, cargo_destinatario: d.cargo_destinatario, institucion: d.institucion,
      url_solicitante: requirente, asunto: d.asunto, sintesis: d.sintesis, cuerpo: d.cuerpo, solicita: d.solicita,
      firmante_id: firmante.id, justificacion_firmante: t.cvic ? '' : d.justificacion_firmante,
      id_sai, justificacion_sai, razon: d.razon,
      ambito, incluir_vre: clave(d.incluir_vre) === 'no' ? false : true,
      reviso_nombre: d.reviso_nombre, reviso_puesto: d.reviso_puesto,
      elaboro_nombre: d.elaboro_nombre, elaboro_puesto: d.elaboro_puesto,
    },
  };
}

async function excelResultado(creados) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Documentos generados');
  ws.columns = [
    { header: 'fila', key: 'fila', width: 6 },
    { header: 'número', key: 'numero', width: 24 },
    { header: 'tipo', key: 'tipo', width: 30 },
    { header: 'fecha', key: 'fecha', width: 12 },
    { header: 'destinatario / requirente', key: 'destinatario', width: 40 },
    { header: 'asunto', key: 'asunto', width: 48 },
    { header: 'firmante', key: 'firmante', width: 32 },
    { header: 'id_sai', key: 'id_sai', width: 16 },
  ];
  ws.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS_OXFORD } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  creados.forEach(c => { ws.addRow(c).getCell('numero').font = { bold: true }; });
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

// ── POST / ───────────────────────────────────────────
router.post('/', (req, res) => {
  subir(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo excede 5 MB' : (err.status ? err.message : 'No se pudo recibir el archivo') });
    if (!req.file) return res.status(400).json({ error: 'Selecciona el archivo de la plantilla' });
    if (!req.user.area) return res.status(400).json({ error: 'Tu usuario no tiene un área asignada. Pide a un administrador que te la asigne.' });
    const activo = db.prepare(`SELECT anio FROM anios_config WHERE activo = 1 LIMIT 1`).get();
    if (!activo) return res.status(500).json({ error: 'No hay año activo configurado' });

    let filas;
    try { filas = await leerFilas(req.file); }
    catch (e) { console.error('[carga-masiva] lectura', e.message); return res.status(400).json({ error: 'No se pudo leer el archivo. Usa la plantilla descargada desde el sistema.' }); }
    if (!filas.length) return res.status(400).json({ error: 'El archivo no tiene filas de datos. Captura a partir de la fila 5 de la plantilla.' });
    if (filas.length > MAX_FILAS) return res.status(400).json({ error: `Máximo ${MAX_FILAS} documentos por archivo (este tiene ${filas.length}).` });

    const ctx = {
      hoy: hoyCdmx(), anio: activo.anio, area: req.user.area, esAdmin: req.user.rol === 'admin',
      puedeCvic: puedeCvic(req.user), firmantes: firmantesDisponibles(req.user),
    };

    // 1) Validar todas las filas sin escribir nada.
    const errores = [], listos = [];
    for (const { fila, datos } of filas) {
      const r = interpretarFila(datos, ctx);
      if (r.errores) { errores.push({ fila, errores: r.errores }); continue; }
      const v = validarDocumento(r.body, req.user);
      if (v.error) { errores.push({ fila, errores: [v.error] }); continue; }
      listos.push({ fila, etiqueta: r.etiqueta, datos: v.datos });
    }
    if (errores.length) {
      return res.status(422).json({ error: `${errores.length} fila(s) con errores. No se generó ningún número; corrígelas y vuelve a subir el archivo.`, errores, total: filas.length });
    }

    // 2) Generar todo en una sola transacción, en el orden del archivo.
    let creados;
    try {
      creados = db.transaction(() => listos.map(({ fila, etiqueta, datos }) => {
        const { numero } = insertarDocumento(datos, req.user.id);
        const f = ctx.firmantes.find(x => x.id === datos.firmante_id);
        return {
          fila, numero, tipo: etiqueta, fecha: datos.fecha,
          destinatario: datos.destinatario || datos.url_solicitante, asunto: datos.asunto,
          firmante: f ? f.nombre : '', id_sai: datos.id_sai || (datos.justificacion_sai ? NO_APLICA : 'Pendiente'),
        };
      }))();
    } catch (e) {
      console.error('[carga-masiva] inserción', e);
      return res.status(500).json({ error: 'No se pudieron generar los documentos; no se asignó ningún número.' });
    }

    let resultado_b64 = null;
    try { resultado_b64 = await excelResultado(creados); }
    catch (e) { console.error('[carga-masiva] Excel de resultado', e.message); }
    res.status(201).json({ ok: true, creados: creados.length, documentos: creados.map(c => ({ fila: c.fila, numero: c.numero, tipo: c.tipo })), resultado_b64 });
  });
});

module.exports = router;
