const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb, saveDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename: (req, file, cb) => {
    const ts = Date.now();
    cb(null, `acuse_${req.params.id}_${ts}.pdf`);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Solo se permiten archivos PDF'));
  },
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

function rowsToObjects(result) {
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
}

function buildOficioNumero(correlativo, anio, tipo) {
  const num = String(correlativo).padStart(3, '0');
  if (tipo === 'opinion')  return `INE/DEAJ/OTJ/${num}/${anio}`;
  if (tipo === 'dictamen')      return `INE/DEAJ/DTJ/${num}/${anio}`;
  if (tipo === 'certificacion') return `DEAJ-${num}-${anio}`;
  return `INE/DEAJ/${num}/${anio}`;
}

// GET /api/oficios
router.get('/', (req, res) => {
  const db = getDb();
  const { estatus, area, firmante_id, fecha_inicio, fecha_fin, q, tipo } = req.query;
  let where = ['1=1'];
  if (req.user.rol !== 'admin') where.push(`o.creado_por = ${req.user.id}`);
  if (estatus) where.push(`o.estatus = '${estatus.replace(/'/g, "''")}'`);
  if (area) where.push(`o.area LIKE '%${area.replace(/'/g, "''")}%'`);
  if (firmante_id) where.push(`o.firmante_id = ${parseInt(firmante_id)}`);
  if (fecha_inicio) where.push(`o.fecha >= '${fecha_inicio}'`);
  if (fecha_fin) where.push(`o.fecha <= '${fecha_fin}'`);
  if (tipo === 'oficio')   where.push(`(o.tipo = 'oficio' OR o.tipo IS NULL)`);
  if (tipo === 'opinion')  where.push(`o.tipo = 'opinion'`);
  if (tipo === 'dictamen')       where.push(`o.tipo = 'dictamen'`);
  if (tipo === 'certificacion')  where.push(`o.tipo = 'certificacion'`);
  if (q) {
    const sq = q.replace(/'/g, "''");
    where.push(`(o.numero_oficio LIKE '%${sq}%' OR o.destinatario LIKE '%${sq}%' OR o.asunto LIKE '%${sq}%' OR o.solicita LIKE '%${sq}%')`);
  }

  const sql = `
    SELECT o.*, f.nombre as firmante_nombre, f.cargo as firmante_cargo, f.es_titular,
           u.nombre as creado_por_nombre
    FROM oficios o
    LEFT JOIN firmantes f ON o.firmante_id = f.id
    LEFT JOIN usuarios u ON o.creado_por = u.id
    WHERE ${where.join(' AND ')}
    ORDER BY o.correlativo DESC
  `;
  const result = db.exec(sql);
  res.json(rowsToObjects(result));
});

// GET /api/oficios/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const ownerClause = req.user.rol !== 'admin' ? `AND o.creado_por = ${req.user.id}` : '';
  const result = db.exec(`
    SELECT o.*, f.nombre as firmante_nombre, f.cargo as firmante_cargo, f.es_titular,
           u.nombre as creado_por_nombre
    FROM oficios o
    LEFT JOIN firmantes f ON o.firmante_id = f.id
    LEFT JOIN usuarios u ON o.creado_por = u.id
    WHERE o.id = ${req.params.id} ${ownerClause}
  `);
  if (!result.length || !result[0].values.length) return res.status(404).json({ error: 'Oficio no encontrado' });
  res.json(rowsToObjects(result)[0]);
});

// POST /api/oficios/generar — ATÓMICO
router.post('/generar', (req, res) => {
  const { fecha, destinatario, cargo_destinatario, asunto, firmante_id, justificacion_firmante, razon, solicita, area, url_solicitante } = req.body;
  const tipo             = ['oficio', 'opinion', 'dictamen', 'certificacion'].includes(req.body.tipo) ? req.body.tipo : 'oficio';
  const isOpinion        = tipo === 'opinion';
  const isDictamen       = tipo === 'dictamen';
  const isCertificacion  = tipo === 'certificacion';

  const missingBase    = !fecha || !asunto || !firmante_id || !solicita || !area;
  const missingOficio  = !isOpinion && !isDictamen && (!destinatario || !cargo_destinatario);
  const missingReq     = (isOpinion || isDictamen) && !url_solicitante;
  if (missingBase || missingOficio || missingReq) {
    return res.status(400).json({ error: 'Todos los campos obligatorios son requeridos' });
  }

  const db = getDb();

  // Verificar firmante
  const firmResult = db.exec(`SELECT es_titular FROM firmantes WHERE id = ${parseInt(firmante_id)} AND activo = 1`);
  if (!firmResult.length || !firmResult[0].values.length) return res.status(400).json({ error: 'Firmante no válido' });
  const esTitular = firmResult[0].values[0][0];
  const requiereJustificacion = !esTitular;

  if (requiereJustificacion && !justificacion_firmante) {
    return res.status(400).json({ error: 'La justificación es obligatoria cuando no firma el titular' });
  }

  // Año activo
  const anioResult = db.exec(`SELECT id, anio, correlativo_actual, correlativo_opinion_actual, correlativo_dictamen_actual, correlativo_certificacion_actual FROM anios_config WHERE activo = 1 LIMIT 1`);
  if (!anioResult.length || !anioResult[0].values.length) return res.status(500).json({ error: 'No hay año activo configurado' });
  const [anioId, anio, correlativoActual, correlativoOpinionActual, correlativoDictamenActual, correlativoCertificacionActual] = anioResult[0].values[0];

  // OPERACIÓN ATÓMICA: sql.js es síncrono, un solo hilo JS
  const nuevoCorrelativo = isDictamen
    ? (correlativoDictamenActual || 0) + 1
    : isOpinion
      ? (correlativoOpinionActual || 0) + 1
      : isCertificacion
        ? (correlativoCertificacionActual || 0) + 1
        : correlativoActual + 1;
  const numeroOficio = buildOficioNumero(nuevoCorrelativo, anio, tipo);

  try {
    if (isDictamen) {
      db.run(`UPDATE anios_config SET correlativo_dictamen_actual = ${nuevoCorrelativo} WHERE id = ${anioId}`);
    } else if (isOpinion) {
      db.run(`UPDATE anios_config SET correlativo_opinion_actual = ${nuevoCorrelativo} WHERE id = ${anioId}`);
    } else if (isCertificacion) {
      db.run(`UPDATE anios_config SET correlativo_certificacion_actual = ${nuevoCorrelativo} WHERE id = ${anioId}`);
    } else {
      db.run(`UPDATE anios_config SET correlativo_actual = ${nuevoCorrelativo} WHERE id = ${anioId}`);
    }
    db.run(
      `INSERT INTO oficios (numero_oficio, correlativo, anio, tipo, fecha, destinatario, cargo_destinatario, asunto, firmante_id, requiere_justificacion, justificacion_firmante, razon, solicita, area, url_solicitante, creado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        numeroOficio, nuevoCorrelativo, anio, tipo, fecha,
        destinatario || '', cargo_destinatario || '',
        asunto, parseInt(firmante_id), requiereJustificacion ? 1 : 0,
        justificacion_firmante || null, razon || null, solicita, area,
        url_solicitante || null, req.user.id
      ]
    );
    saveDb();

    const result = db.exec(`
      SELECT o.*, f.nombre as firmante_nombre, f.cargo as firmante_cargo,
             u.nombre as creado_por_nombre
      FROM oficios o
      LEFT JOIN firmantes f ON o.firmante_id = f.id
      LEFT JOIN usuarios u ON o.creado_por = u.id
      WHERE o.numero_oficio = '${numeroOficio}'
    `);
    res.status(201).json(rowsToObjects(result)[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/oficios/:id
router.put('/:id', (req, res) => {
  const { estatus, fecha, destinatario, cargo_destinatario, asunto, firmante_id, justificacion_firmante, razon, solicita, area, url_solicitante, razon_reactivacion } = req.body;
  const db = getDb();
  const ownerClause = req.user.rol !== 'admin' ? `AND creado_por = ${req.user.id}` : '';
  const existing = db.exec(`SELECT id FROM oficios WHERE id = ${req.params.id} ${ownerClause}`);
  if (!existing.length || !existing[0].values.length) return res.status(404).json({ error: 'Oficio no encontrado' });

  if (estatus && ['enviado', 'archivado'].includes(estatus)) {
    const acuseCheck = db.exec(`SELECT acuse_path FROM oficios WHERE id = ${req.params.id}`);
    const acusePath = acuseCheck.length ? acuseCheck[0].values[0][0] : null;
    if (!acusePath) {
      return res.status(400).json({ error: 'Se requiere un acuse para cambiar a Enviado o Archivado' });
    }
  }

  const updates = [];
  if (estatus) updates.push(`estatus = '${estatus.replace(/'/g, "''")}'`);
  if (fecha) updates.push(`fecha = '${fecha}'`);
  if (destinatario) updates.push(`destinatario = '${destinatario.replace(/'/g, "''")}'`);
  if (cargo_destinatario) updates.push(`cargo_destinatario = '${cargo_destinatario.replace(/'/g, "''")}'`);
  if (asunto) updates.push(`asunto = '${asunto.replace(/'/g, "''")}'`);
  if (firmante_id) updates.push(`firmante_id = ${parseInt(firmante_id)}`);
  if (justificacion_firmante !== undefined) updates.push(`justificacion_firmante = '${(justificacion_firmante||'').replace(/'/g, "''")}'`);
  if (razon !== undefined) updates.push(`razon = '${(razon||'').replace(/'/g, "''")}'`);
  if (solicita) updates.push(`solicita = '${solicita.replace(/'/g, "''")}'`);
  if (area) updates.push(`area = '${area.replace(/'/g, "''")}'`);
  if (url_solicitante !== undefined) updates.push(`url_solicitante = '${(url_solicitante||'').replace(/'/g, "''")}'`);
  if (razon_reactivacion !== undefined) updates.push(`razon_reactivacion = '${(razon_reactivacion||'').replace(/'/g, "''")}'`);
  updates.push(`actualizado_en = datetime('now','localtime')`);

  if (updates.length > 1) {
    db.run(`UPDATE oficios SET ${updates.join(', ')} WHERE id = ${req.params.id}`);
    saveDb();
  }
  res.json({ ok: true });
});

// POST /api/oficios/:id/acuse
router.post('/:id/acuse', (req, res, next) => {
  upload.single('acuse')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Archivo PDF requerido' });

    const db = getDb();
    const existing = db.exec(`SELECT id, acuse_path FROM oficios WHERE id = ${req.params.id}`);
    if (!existing.length || !existing[0].values.length) return res.status(404).json({ error: 'Oficio no encontrado' });

    const oldPath = existing[0].values[0][1];
    if (oldPath && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);

    const newPath = req.file.path;
    db.run(`UPDATE oficios SET acuse_path = ?, estatus = 'archivado', actualizado_en = datetime('now','localtime') WHERE id = ${req.params.id}`, [newPath]);
    saveDb();
    res.json({ ok: true, acuse_path: newPath });
  });
});

// DELETE /api/oficios/:id/acuse
router.delete('/:id/acuse', (req, res) => {
  const db = getDb();
  const result = db.exec(`SELECT acuse_path FROM oficios WHERE id = ${req.params.id}`);
  if (!result.length || !result[0].values.length) return res.status(404).json({ error: 'Oficio no encontrado' });

  const acusePath = result[0].values[0][0];
  if (acusePath && fs.existsSync(acusePath)) fs.unlinkSync(acusePath);

  db.run(`UPDATE oficios SET acuse_path = NULL, estatus = 'enviado', actualizado_en = datetime('now','localtime') WHERE id = ${req.params.id}`);
  saveDb();
  res.json({ ok: true });
});

// GET /api/oficios/:id/acuse
router.get('/:id/acuse', (req, res) => {
  const db = getDb();
  const result = db.exec(`SELECT acuse_path, numero_oficio FROM oficios WHERE id = ${req.params.id}`);
  if (!result.length || !result[0].values.length) return res.status(404).json({ error: 'Oficio no encontrado' });
  const [acusePath, numeroOficio] = result[0].values[0];
  if (!acusePath || !fs.existsSync(acusePath)) return res.status(404).json({ error: 'Acuse no disponible' });
  const safeName = numeroOficio.replace(/\//g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="Acuse_${safeName}.pdf"`);
  res.setHeader('Content-Type', 'application/pdf');
  fs.createReadStream(acusePath).pipe(res);
});

module.exports = router;
