const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
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
  const { fecha, destinatario, cargo_destinatario, asunto, firmante_id, justificacion_firmante, razon, solicita, area, url_solicitante } = req.body;
  const tipo            = ['oficio', 'opinion', 'dictamen', 'certificacion'].includes(req.body.tipo) ? req.body.tipo : 'oficio';
  const isOpinion       = tipo === 'opinion';
  const isDictamen      = tipo === 'dictamen';
  const isCertificacion = tipo === 'certificacion';

  if (!fecha || !asunto || !firmante_id || !solicita || !area) return res.status(400).json({ error: 'Todos los campos obligatorios son requeridos' });
  if (!isOpinion && !isDictamen && (!destinatario || !cargo_destinatario)) return res.status(400).json({ error: 'Todos los campos obligatorios son requeridos' });
  if ((isOpinion || isDictamen) && !url_solicitante) return res.status(400).json({ error: 'Todos los campos obligatorios son requeridos' });

  const firmante = db.prepare(`SELECT es_titular FROM firmantes WHERE id = ? AND activo = 1`).get(parseInt(firmante_id));
  if (!firmante) return res.status(400).json({ error: 'Firmante no válido' });
  const requiereJustificacion = !firmante.es_titular;
  if (requiereJustificacion && !justificacion_firmante) return res.status(400).json({ error: 'La justificación es obligatoria cuando no firma el titular' });

  const anioRow = db.prepare(`SELECT id, anio, correlativo_actual, correlativo_opinion_actual, correlativo_dictamen_actual, correlativo_certificacion_actual FROM anios_config WHERE activo = 1 LIMIT 1`).get();
  if (!anioRow) return res.status(500).json({ error: 'No hay año activo configurado' });

  const generar = db.transaction(() => {
    const nuevoCorrelativo = isDictamen
      ? (anioRow.correlativo_dictamen_actual || 0) + 1
      : isOpinion
        ? (anioRow.correlativo_opinion_actual || 0) + 1
        : isCertificacion
          ? (anioRow.correlativo_certificacion_actual || 0) + 1
          : anioRow.correlativo_actual + 1;

    const numeroOficio = buildOficioNumero(nuevoCorrelativo, anioRow.anio, tipo);

    if (isDictamen)      db.prepare(`UPDATE anios_config SET correlativo_dictamen_actual = ? WHERE id = ?`).run(nuevoCorrelativo, anioRow.id);
    else if (isOpinion)  db.prepare(`UPDATE anios_config SET correlativo_opinion_actual = ? WHERE id = ?`).run(nuevoCorrelativo, anioRow.id);
    else if (isCertificacion) db.prepare(`UPDATE anios_config SET correlativo_certificacion_actual = ? WHERE id = ?`).run(nuevoCorrelativo, anioRow.id);
    else                 db.prepare(`UPDATE anios_config SET correlativo_actual = ? WHERE id = ?`).run(nuevoCorrelativo, anioRow.id);

    db.prepare(`INSERT INTO oficios (numero_oficio, correlativo, anio, tipo, fecha, destinatario, cargo_destinatario, asunto, firmante_id, requiere_justificacion, justificacion_firmante, razon, solicita, area, url_solicitante, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(numeroOficio, nuevoCorrelativo, anioRow.anio, tipo, fecha,
           destinatario || '', cargo_destinatario || '',
           asunto, parseInt(firmante_id), requiereJustificacion ? 1 : 0,
           justificacion_firmante || null, razon || null, solicita, area,
           url_solicitante || null, req.user.id);

    return db.prepare(`SELECT o.*, f.nombre as firmante_nombre, f.cargo as firmante_cargo, u.nombre as creado_por_nombre ${JOIN} WHERE o.numero_oficio = ?`).get(numeroOficio);
  });

  try {
    res.status(201).json(generar());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/oficios/:id
router.put('/:id', (req, res) => {
  const { estatus, fecha, destinatario, cargo_destinatario, asunto, firmante_id, justificacion_firmante, razon, solicita, area, url_solicitante, razon_reactivacion } = req.body;
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
  if (asunto)                         { sets.push('asunto = ?'); params.push(asunto); }
  if (firmante_id)                    { sets.push('firmante_id = ?'); params.push(parseInt(firmante_id)); }
  if (justificacion_firmante !== undefined) { sets.push('justificacion_firmante = ?'); params.push(justificacion_firmante || null); }
  if (razon !== undefined)            { sets.push('razon = ?'); params.push(razon || null); }
  if (solicita)                       { sets.push('solicita = ?'); params.push(solicita); }
  if (area)                           { sets.push('area = ?'); params.push(area); }
  if (url_solicitante !== undefined)  { sets.push('url_solicitante = ?'); params.push(url_solicitante || null); }
  if (razon_reactivacion !== undefined) { sets.push('razon_reactivacion = ?'); params.push(razon_reactivacion || null); }
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
