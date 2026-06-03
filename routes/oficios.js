const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename: (req, file, cb) => cb(null, `acuse_${req.params.id}_${Date.now()}.pdf`),
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Solo se permiten archivos PDF'));
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

function buildOficioNumero(correlativo, anio, tipo) {
  const num = String(correlativo).padStart(3, '0');
  if (tipo === 'opinion')       return `INE/DEAJ/OTJ/${num}/${anio}`;
  if (tipo === 'dictamen')      return `INE/DEAJ/DTJ/${num}/${anio}`;
  if (tipo === 'certificacion') return `DEAJ-${num}-${anio}`;
  return `INE/DEAJ/${num}/${anio}`;
}

const JOIN = `
  FROM oficios o
  LEFT JOIN firmantes f ON o.firmante_id = f.id
  LEFT JOIN usuarios u ON o.creado_por = u.id
`;

function buildWhere(query, userId, rol) {
  const { estatus, area, firmante_id, fecha_inicio, fecha_fin, q, tipo } = query;
  const where = ['1=1'];
  const params = [];
  if (rol !== 'admin') { where.push('o.creado_por = ?'); params.push(userId); }
  if (estatus)      { where.push('o.estatus = ?'); params.push(estatus); }
  if (area)         { where.push('o.area LIKE ?'); params.push(`%${area}%`); }
  if (firmante_id)  { where.push('o.firmante_id = ?'); params.push(parseInt(firmante_id)); }
  if (fecha_inicio) { where.push('o.fecha >= ?'); params.push(fecha_inicio); }
  if (fecha_fin)    { where.push('o.fecha <= ?'); params.push(fecha_fin); }
  if (tipo === 'oficio')        where.push(`(o.tipo = 'oficio' OR o.tipo IS NULL)`);
  else if (tipo)                { where.push('o.tipo = ?'); params.push(tipo); }
  if (q) {
    where.push('(o.numero_oficio LIKE ? OR o.destinatario LIKE ? OR o.asunto LIKE ? OR o.solicita LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  return { clause: where.join(' AND '), params };
}

// GET /api/oficios
router.get('/', (req, res) => {
  const { clause, params } = buildWhere(req.query, req.user.id, req.user.rol);
  const sql = `SELECT o.*, f.nombre as firmante_nombre, f.cargo as firmante_cargo, f.es_titular, u.nombre as creado_por_nombre ${JOIN} WHERE ${clause} ORDER BY o.id DESC`;
  res.json(db.prepare(sql).all(...params));
});

// GET /api/oficios/:id
router.get('/:id', (req, res) => {
  const ownerClause = req.user.rol !== 'admin' ? 'AND o.creado_por = ?' : '';
  const params = req.user.rol !== 'admin' ? [req.params.id, req.user.id] : [req.params.id];
  const row = db.prepare(`SELECT o.*, f.nombre as firmante_nombre, f.cargo as firmante_cargo, f.es_titular, u.nombre as creado_por_nombre ${JOIN} WHERE o.id = ? ${ownerClause}`).get(...params);
  if (!row) return res.status(404).json({ error: 'Oficio no encontrado' });
  res.json(row);
});

// POST /api/oficios/generar — atomic
router.post('/generar', (req, res) => {
  const { fecha, destinatario, cargo_destinatario, institucion, asunto, cuerpo, id_sai, sintesis, firmante_id, justificacion_firmante, razon, solicita, area, url_solicitante, reviso_nombre, reviso_puesto, elaboro_nombre, elaboro_puesto } = req.body;
  const tipo            = ['oficio', 'opinion', 'dictamen', 'certificacion'].includes(req.body.tipo) ? req.body.tipo : 'oficio';
  const isOpinion       = tipo === 'opinion';
  const isDictamen      = tipo === 'dictamen';
  const isCertificacion = tipo === 'certificacion';

  if (!fecha || !asunto || !firmante_id || !solicita || !area) return res.status(400).json({ error: 'Todos los campos obligatorios son requeridos' });
  if (id_sai && (!/^\d+$/.test(String(id_sai).trim()) || String(id_sai).trim().length > 10)) return res.status(400).json({ error: 'El ID SAI debe ser numérico y tener máximo 10 dígitos' });
  if (!isOpinion && !isDictamen && (!destinatario || !cargo_destinatario)) return res.status(400).json({ error: 'Todos los campos obligatorios son requeridos' });
  if ((isOpinion || isDictamen) && !url_solicitante) return res.status(400).json({ error: 'Todos los campos obligatorios son requeridos' });

  const firmante = db.prepare(`SELECT es_titular FROM firmantes WHERE id = ? AND activo = 1`).get(parseInt(firmante_id));
  if (!firmante) return res.status(400).json({ error: 'Firmante no válido' });
  const requiereJustificacion = !firmante.es_titular;
  if (requiereJustificacion && !justificacion_firmante) return res.status(400).json({ error: 'La justificación es obligatoria cuando no firma el titular' });

  if (!db.prepare(`SELECT id FROM anios_config WHERE activo = 1 LIMIT 1`).get()) {
    return res.status(500).json({ error: 'No hay año activo configurado' });
  }

  const generar = db.transaction(() => {
    // Leer el contador dentro de la transacción para evitar race conditions
    const row = db.prepare(`SELECT id, anio, correlativo_actual, correlativo_opinion_actual, correlativo_dictamen_actual, correlativo_certificacion_actual FROM anios_config WHERE activo = 1 LIMIT 1`).get();

    // MAX real de la tabla como respaldo por si el contador quedó desfasado
    const maxReal = db.prepare(
      `SELECT COALESCE(MAX(correlativo), 0) as max FROM oficios WHERE anio = ? AND tipo = ?`
    ).get(row.anio, tipo).max;

    const baseContador = isDictamen      ? (row.correlativo_dictamen_actual      || 0)
                       : isOpinion       ? (row.correlativo_opinion_actual        || 0)
                       : isCertificacion ? (row.correlativo_certificacion_actual  || 0)
                       :                   row.correlativo_actual;

    const nuevoCorrelativo = Math.max(baseContador, maxReal) + 1;

    const numeroOficio = buildOficioNumero(nuevoCorrelativo, row.anio, tipo);

    if (isDictamen)           db.prepare(`UPDATE anios_config SET correlativo_dictamen_actual      = ? WHERE id = ?`).run(nuevoCorrelativo, row.id);
    else if (isOpinion)       db.prepare(`UPDATE anios_config SET correlativo_opinion_actual        = ? WHERE id = ?`).run(nuevoCorrelativo, row.id);
    else if (isCertificacion) db.prepare(`UPDATE anios_config SET correlativo_certificacion_actual  = ? WHERE id = ?`).run(nuevoCorrelativo, row.id);
    else                      db.prepare(`UPDATE anios_config SET correlativo_actual                = ? WHERE id = ?`).run(nuevoCorrelativo, row.id);

    db.prepare(`INSERT INTO oficios (numero_oficio, correlativo, anio, tipo, fecha, destinatario, cargo_destinatario, institucion, asunto, cuerpo, id_sai, sintesis, firmante_id, requiere_justificacion, justificacion_firmante, razon, solicita, area, url_solicitante, reviso_nombre, reviso_puesto, elaboro_nombre, elaboro_puesto, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(numeroOficio, nuevoCorrelativo, row.anio, tipo, fecha,
           destinatario || '', cargo_destinatario || '', institucion || null,
           asunto, cuerpo || null, id_sai || null, sintesis || null,
           parseInt(firmante_id), requiereJustificacion ? 1 : 0,
           justificacion_firmante || null, razon || null, solicita, area,
           url_solicitante || null,
           reviso_nombre || null, reviso_puesto || null,
           elaboro_nombre || null, elaboro_puesto || null,
           req.user.id);

    return db.prepare(`SELECT o.*, f.nombre as firmante_nombre, f.cargo as firmante_cargo, u.nombre as creado_por_nombre ${JOIN} WHERE o.numero_oficio = ?`).get(numeroOficio);
  });

  try {
    res.status(201).json(generar());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/oficios/carga-masiva
const uploadXlsx = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) cb(null, true);
    else cb(new Error('Solo se permiten archivos Excel (.xlsx, .xls) o CSV'));
  },
});

router.post('/carga-masiva', uploadXlsx.single('archivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });

  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'No se pudo leer el archivo: ' + e.message });
  }

  if (!rows.length) return res.status(400).json({ error: 'El archivo está vacío' });

  const TIPOS_VALIDOS = ['oficio', 'opinion', 'dictamen', 'certificacion'];
  const firmantes = db.prepare('SELECT id, nombre, es_titular FROM firmantes WHERE activo = 1').all();

  const errores = [];
  const validos = [];

  rows.forEach((row, i) => {
    const fila = i + 2; // Excel row number (1 = header)
    const tipo = (String(row.tipo || 'oficio')).trim().toLowerCase();
    const fecha = row.fecha ? String(row.fecha).trim() : '';
    const destinatario = String(row.destinatario || '').trim();
    const cargo_destinatario = String(row.cargo_destinatario || '').trim();
    const asunto = String(row.asunto || '').trim();
    const solicita = String(row.solicita || '').trim();
    const area = String(row.area || '').trim();
    const firmante_nombre = String(row.firmante || '').trim();
    const url_solicitante = String(row.solicitante || row.url_solicitante || '').trim();
    const cuerpo = String(row.cuerpo || '').trim();
    const id_sai = String(row.id_sai || '').trim();
    const sintesis = String(row.sintesis || '').trim();
    const justificacion_firmante = String(row.justificacion_firmante || '').trim();
    const razon = String(row.razon || '').trim();

    const filaErrores = [];
    if (!TIPOS_VALIDOS.includes(tipo)) filaErrores.push(`tipo inválido ("${tipo}")`);
    if (!asunto) filaErrores.push('asunto vacío');
    if (!solicita) filaErrores.push('solicita vacío');
    if (!area) filaErrores.push('área vacía');

    const isOpinion = tipo === 'opinion';
    const isDictamen = tipo === 'dictamen';
    if (!isOpinion && !isDictamen) {
      if (!destinatario) filaErrores.push('destinatario vacío');
      if (!cargo_destinatario) filaErrores.push('cargo_destinatario vacío');
    }
    if ((isOpinion || isDictamen) && !url_solicitante) filaErrores.push('columna solicitante vacía');

    // Fecha: aceptar YYYY-MM-DD o Date de Excel
    let fechaStr = fecha;
    if (row.fecha instanceof Date) {
      const d = row.fecha;
      fechaStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr)) {
      filaErrores.push('fecha inválida (use YYYY-MM-DD)');
    }

    // Firmante
    let firmante = null;
    if (firmante_nombre) {
      firmante = firmantes.find(f => f.nombre.toLowerCase() === firmante_nombre.toLowerCase());
      if (!firmante) filaErrores.push(`firmante "${firmante_nombre}" no encontrado`);
    } else {
      firmante = firmantes.find(f => f.es_titular === 1);
      if (!firmante) filaErrores.push('no hay firmante titular activo');
    }

    const requiereJustificacion = firmante && !firmante.es_titular;
    if (requiereJustificacion && !justificacion_firmante) {
      filaErrores.push('justificacion_firmante requerida para firmante no titular');
    }

    if (filaErrores.length) {
      errores.push({ fila, errores: filaErrores });
    } else {
      validos.push({
        tipo, fecha: fechaStr, destinatario, cargo_destinatario,
        asunto, cuerpo, id_sai, sintesis, solicita, area,
        url_solicitante, firmante_id: firmante.id,
        requiereJustificacion, justificacion_firmante, razon,
      });
    }
  });

  if (errores.length) {
    return res.status(422).json({
      error: `${errores.length} fila(s) con errores. Corrígelos antes de procesar.`,
      errores,
      total: rows.length,
    });
  }

  // Procesar todo en una sola transacción
  const anioRow = db.prepare(
    'SELECT id, anio, correlativo_actual, correlativo_opinion_actual, correlativo_dictamen_actual, correlativo_certificacion_actual FROM anios_config WHERE activo = 1 LIMIT 1'
  ).get();
  if (!anioRow) return res.status(500).json({ error: 'No hay año activo configurado' });

  const insertStmt = db.prepare(
    `INSERT INTO oficios (numero_oficio, correlativo, anio, tipo, fecha, destinatario, cargo_destinatario,
      asunto, cuerpo, id_sai, sintesis, firmante_id, requiere_justificacion, justificacion_firmante,
      razon, solicita, area, url_solicitante, creado_por)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  let creados;
  try {
    creados = db.transaction(() => {
      const counters = {
        correlativo_actual: anioRow.correlativo_actual,
        correlativo_opinion_actual: anioRow.correlativo_opinion_actual,
        correlativo_dictamen_actual: anioRow.correlativo_dictamen_actual,
        correlativo_certificacion_actual: anioRow.correlativo_certificacion_actual,
      };

      const resultado = [];
      for (const o of validos) {
        let correlativo;
        if (o.tipo === 'dictamen')      { counters.correlativo_dictamen_actual += 1; correlativo = counters.correlativo_dictamen_actual; }
        else if (o.tipo === 'opinion')  { counters.correlativo_opinion_actual += 1;  correlativo = counters.correlativo_opinion_actual; }
        else if (o.tipo === 'certificacion') { counters.correlativo_certificacion_actual += 1; correlativo = counters.correlativo_certificacion_actual; }
        else                            { counters.correlativo_actual += 1; correlativo = counters.correlativo_actual; }

        const numeroOficio = buildOficioNumero(correlativo, anioRow.anio, o.tipo);
        insertStmt.run(
          numeroOficio, correlativo, anioRow.anio, o.tipo, o.fecha,
          o.destinatario, o.cargo_destinatario, o.asunto,
          o.cuerpo || null, o.id_sai || null, o.sintesis || null,
          o.firmante_id, o.requiereJustificacion ? 1 : 0,
          o.justificacion_firmante || null, o.razon || null,
          o.solicita, o.area, o.url_solicitante || null, req.user.id
        );
        resultado.push(numeroOficio);
      }

      // Actualizar correlativos de una sola vez
      db.prepare(`UPDATE anios_config SET
        correlativo_actual = ?,
        correlativo_opinion_actual = ?,
        correlativo_dictamen_actual = ?,
        correlativo_certificacion_actual = ?
        WHERE id = ?`
      ).run(
        counters.correlativo_actual, counters.correlativo_opinion_actual,
        counters.correlativo_dictamen_actual, counters.correlativo_certificacion_actual,
        anioRow.id
      );

      return resultado;
    })();
  } catch (e) {
    return res.status(500).json({ error: 'Error al insertar: ' + e.message });
  }

  res.status(201).json({ ok: true, creados: creados.length, numeros: creados });
});

// GET /api/oficios/carga-masiva/plantilla — descarga plantilla Excel
router.get('/carga-masiva/plantilla', async (req, res) => {
  try {
    const firmantes = db.prepare('SELECT nombre FROM firmantes WHERE activo = 1 ORDER BY es_titular DESC, nombre').all();
    const firmanteNames = firmantes.map(f => f.nombre);
    const primerFirmante = firmanteNames[0] || '';

    const HEADERS = [
      { key: 'tipo',                   header: 'tipo',                   width: 14 },
      { key: 'fecha',                  header: 'fecha',                  width: 14 },
      { key: 'destinatario',           header: 'destinatario',           width: 32 },
      { key: 'cargo_destinatario',     header: 'cargo_destinatario',     width: 26 },
      { key: 'asunto',                 header: 'asunto',                 width: 42 },
      { key: 'sintesis',               header: 'sintesis',               width: 22 },
      { key: 'cuerpo',                 header: 'cuerpo',                 width: 30 },
      { key: 'id_sai',                 header: 'id_sai',                 width: 12 },
      { key: 'solicita',               header: 'solicita',               width: 26 },
      { key: 'area',                   header: 'area',                   width: 36 },
      { key: 'firmante',               header: 'firmante',               width: 28 },
      { key: 'justificacion_firmante', header: 'justificacion_firmante', width: 26 },
      { key: 'razon',                  header: 'razon',                  width: 20 },
      { key: 'url_solicitante',        header: 'solicitante',             width: 36 },
    ];

    const wb = new ExcelJS.Workbook();

    // Hoja oculta con los firmantes disponibles
    const catSheet = wb.addWorksheet('_Firmantes');
    catSheet.state = 'hidden';
    firmanteNames.forEach((n, i) => { catSheet.getCell(`A${i + 1}`).value = n; });

    // Hoja principal
    const ws = wb.addWorksheet('Oficios');
    ws.columns = HEADERS;

    // Estilo de encabezado
    const hRow = ws.getRow(1);
    hRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    hRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF582E73' } };
    hRow.alignment = { vertical: 'middle', horizontal: 'center' };
    hRow.height = 20;

    // Fila de ejemplo
    ws.addRow({
      tipo: 'oficio',
      fecha: new Date().toISOString().slice(0, 10),
      destinatario: 'Lic. Ejemplo Apellido',
      cargo_destinatario: 'Director General',
      asunto: 'Asunto del oficio de ejemplo',
      sintesis: '', cuerpo: '', id_sai: '',
      solicita: 'Nombre Apellido',
      area: 'Dirección de Servicios Legales',
      firmante: primerFirmante,
      justificacion_firmante: '', razon: '', url_solicitante: '',
    });

    // Validación: tipo (columna A)
    ws.dataValidations.add('A2:A1000', {
      type: 'list',
      allowBlank: false,
      showErrorMessage: true,
      errorTitle: 'Tipo inválido',
      error: 'Usa: oficio, opinion, dictamen o certificacion',
      formulae: ['"oficio,opinion,dictamen,certificacion"'],
    });

    // Validación: firmante (columna K) — referencia a la hoja oculta
    if (firmanteNames.length > 0) {
      ws.dataValidations.add('K2:K1000', {
        type: 'list',
        allowBlank: true,
        showErrorMessage: true,
        errorTitle: 'Firmante inválido',
        error: 'Selecciona un firmante de la lista',
        formulae: [`_Firmantes!$A$1:$A$${firmanteNames.length}`],
      });
    }

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_carga_masiva.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    console.error('Error generando plantilla:', e.message);
    res.status(500).json({ error: 'Error al generar la plantilla: ' + e.message });
  }
});

// PUT /api/oficios/:id
router.put('/:id', (req, res) => {
  const { estatus, fecha, destinatario, cargo_destinatario, institucion, asunto, cuerpo, id_sai, sintesis, firmante_id, justificacion_firmante, razon, solicita, area, url_solicitante, razon_reactivacion, reviso_nombre, reviso_puesto, elaboro_nombre, elaboro_puesto } = req.body;
  const ownerClause = req.user.rol !== 'admin' ? 'AND creado_por = ?' : '';
  const checkParams = req.user.rol !== 'admin' ? [req.params.id, req.user.id] : [req.params.id];
  if (!db.prepare(`SELECT id FROM oficios WHERE id = ? ${ownerClause}`).get(...checkParams)) {
    return res.status(404).json({ error: 'Oficio no encontrado' });
  }

  if (estatus === 'archivado') {
    const row = db.prepare(`SELECT acuse_path FROM oficios WHERE id = ?`).get(req.params.id);
    if (!row?.acuse_path) return res.status(400).json({ error: 'Se requiere un acuse para cambiar a Archivado' });
  }

  if (estatus && estatus !== 'cancelado') {
    const current = db.prepare(`SELECT estatus FROM oficios WHERE id = ?`).get(req.params.id);
    if (current?.estatus === 'cancelado') {
      const razon = (req.body.razon_reactivacion || '').trim();
      if (!razon) return res.status(400).json({ error: 'La justificación de reactivación es obligatoria' });
    }
  }

  const sets = [];
  const params = [];

  if (estatus === 'cancelado') {
    const row = db.prepare(`SELECT acuse_path FROM oficios WHERE id = ?`).get(req.params.id);
    if (row?.acuse_path) {
      if (fs.existsSync(row.acuse_path)) fs.unlinkSync(row.acuse_path);
      sets.push('acuse_path = NULL');
    }
  }
  if (estatus)                        { sets.push('estatus = ?'); params.push(estatus); }
  if (fecha)                          { sets.push('fecha = ?'); params.push(fecha); }
  if (destinatario)                   { sets.push('destinatario = ?'); params.push(destinatario); }
  if (cargo_destinatario)             { sets.push('cargo_destinatario = ?'); params.push(cargo_destinatario); }
  if (institucion    !== undefined) { sets.push('institucion = ?');    params.push(institucion    || null); }
  if (reviso_nombre  !== undefined) { sets.push('reviso_nombre = ?');  params.push(reviso_nombre  || null); }
  if (reviso_puesto  !== undefined) { sets.push('reviso_puesto = ?');  params.push(reviso_puesto  || null); }
  if (elaboro_nombre !== undefined) { sets.push('elaboro_nombre = ?'); params.push(elaboro_nombre || null); }
  if (elaboro_puesto !== undefined) { sets.push('elaboro_puesto = ?'); params.push(elaboro_puesto || null); }
  if (asunto)                         { sets.push('asunto = ?'); params.push(asunto); }
  if (firmante_id)                    { sets.push('firmante_id = ?'); params.push(parseInt(firmante_id)); }
  if (justificacion_firmante !== undefined) { sets.push('justificacion_firmante = ?'); params.push(justificacion_firmante || null); }
  if (razon !== undefined)            { sets.push('razon = ?'); params.push(razon || null); }
  if (solicita)                       { sets.push('solicita = ?'); params.push(solicita); }
  if (area)                           { sets.push('area = ?'); params.push(area); }
  if (url_solicitante !== undefined)  { sets.push('url_solicitante = ?'); params.push(url_solicitante || null); }
  if (razon_reactivacion !== undefined) { sets.push('razon_reactivacion = ?'); params.push(razon_reactivacion || null); }
  if (cuerpo !== undefined)           { sets.push('cuerpo = ?'); params.push(cuerpo || null); }
  if (id_sai   !== undefined)          { sets.push('id_sai = ?');   params.push(id_sai   || null); }
  if (sintesis !== undefined)          { sets.push('sintesis = ?'); params.push(sintesis || null); }
  sets.push(`actualizado_en = datetime('now','localtime')`);

  if (sets.length > 1) {
    db.prepare(`UPDATE oficios SET ${sets.join(', ')} WHERE id = ?`).run(...params, req.params.id);
  }
  res.json({ ok: true });
});

// POST /api/oficios/:id/acuse
router.post('/:id/acuse', (req, res, next) => {
  upload.single('acuse')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Archivo PDF requerido' });

    const existing = db.prepare(`SELECT id, acuse_path FROM oficios WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Oficio no encontrado' });

    if (existing.acuse_path && fs.existsSync(existing.acuse_path)) fs.unlinkSync(existing.acuse_path);
    db.prepare(`UPDATE oficios SET acuse_path = ?, estatus = 'archivado', actualizado_en = datetime('now','localtime') WHERE id = ?`)
      .run(req.file.path, req.params.id);
    res.json({ ok: true, acuse_path: req.file.path });
  });
});

// DELETE /api/oficios/:id/acuse
router.delete('/:id/acuse', (req, res) => {
  const row = db.prepare(`SELECT acuse_path FROM oficios WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Oficio no encontrado' });
  if (row.acuse_path && fs.existsSync(row.acuse_path)) fs.unlinkSync(row.acuse_path);
  db.prepare(`UPDATE oficios SET acuse_path = NULL, estatus = 'borrador', actualizado_en = datetime('now','localtime') WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// GET /api/oficios/:id/acuse
router.get('/:id/acuse', (req, res) => {
  const row = db.prepare(`SELECT acuse_path, numero_oficio FROM oficios WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Oficio no encontrado' });
  if (!row.acuse_path || !fs.existsSync(row.acuse_path)) return res.status(404).json({ error: 'Acuse no disponible' });
  const safeName = row.numero_oficio.replace(/\//g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="Acuse_${safeName}.pdf"`);
  res.setHeader('Content-Type', 'application/pdf');
  fs.createReadStream(row.acuse_path).pipe(res);
});

module.exports = router;
