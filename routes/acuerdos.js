const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Acuerdos de la CVIC: solo la propia Comisión (por área) o un administrador.
const CVIC_AREA = 'Comisión de Verificación de Integridad en Candidaturas';
const AUTOR = CVIC_AREA; // el autor es siempre la Comisión
router.use((req, res, next) => {
  if (req.user.rol === 'admin' || req.user.area === CVIC_AREA) return next();
  res.status(403).json({ error: 'Solo la Comisión de Verificación de Integridad en Candidaturas o un administrador pueden consultar sus acuerdos' });
});

// Por ahora solo acuerdos; las actas se agregarán aquí (con su propio consecutivo).
const TIPOS = ['acuerdo'];
const MAX_ADJUNTOS = 10;

function buildNumero(tipo, correlativo, anio) {
  return `INE/CVIC/${correlativo}/${anio}`;
}

function siguienteCorrelativo(tipo, anio) {
  return db.prepare(`SELECT COALESCE(MAX(correlativo), 0) + 1 AS n FROM cvic_acuerdos WHERE tipo = ? AND anio = ?`).get(tipo, anio).n;
}

const UPLOAD_DIR = path.join(__dirname, '../uploads/acuerdos');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const EXT_PERMITIDAS = ['.pdf', '.doc', '.docx'];
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `acuerdo_${Date.now()}_${Math.round(Math.random() * 1e6)}${path.extname(file.originalname).toLowerCase()}`),
  }),
  fileFilter: (req, file, cb) => {
    // multer entrega el nombre en latin1; se reinterpreta como UTF-8 para conservar acentos.
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (EXT_PERMITIDAS.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Solo se permiten archivos PDF o Word'));
  },
  limits: { fileSize: 20 * 1024 * 1024, files: MAX_ADJUNTOS },
});

// Envuelve multer para responder 400 con el mensaje en lugar de pasar al manejador genérico.
const recibirArchivos = (req, res, next) => upload.array('archivos', MAX_ADJUNTOS)(req, res, (err) => {
  if (err) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Cada archivo debe pesar como máximo 20 MB'
              : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `Máximo ${MAX_ADJUNTOS} archivos por acuerdo`
              : err.message;
    return res.status(400).json({ error: msg });
  }
  next();
});

const borrarArchivos = (files = []) => files.forEach(f => fs.unlink(f.path, () => {}));

// Valida tipo/fecha/síntesis/correlativo del cuerpo. Devuelve { error } o los datos normalizados.
function validar(body, idActual = null) {
  const tipo = TIPOS.includes(body.tipo) ? body.tipo : 'acuerdo';
  const fecha = String(body.fecha || '').trim();
  const sintesis = String(body.sintesis || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return { error: 'La fecha es obligatoria' };
  if (!sintesis) return { error: 'La síntesis o título es obligatoria' };
  if (sintesis.length > 1000) return { error: 'La síntesis no debe exceder 1000 caracteres' };
  const anio = parseInt(fecha.slice(0, 4));
  let correlativo;
  if (body.correlativo === undefined || body.correlativo === null || String(body.correlativo).trim() === '') {
    correlativo = siguienteCorrelativo(tipo, anio);
  } else {
    correlativo = Number(body.correlativo);
    if (!Number.isInteger(correlativo) || correlativo < 1) return { error: 'El número de acuerdo debe ser un entero mayor a 0' };
  }
  const dup = db.prepare(`SELECT id FROM cvic_acuerdos WHERE tipo = ? AND anio = ? AND correlativo = ? AND id IS NOT ?`).get(tipo, anio, correlativo, idActual);
  if (dup) return { error: `El ${buildNumero(tipo, correlativo, anio)} ya está registrado` };
  return { tipo, fecha, sintesis, anio, correlativo, numero: buildNumero(tipo, correlativo, anio) };
}

const listarAdjuntos = (id) => db.prepare(`SELECT id, original_name, size, creado_en FROM cvic_acuerdo_adjuntos WHERE acuerdo_id = ? ORDER BY id`).all(id);
const insAdjunto = db.prepare(`INSERT INTO cvic_acuerdo_adjuntos (acuerdo_id, path, original_name, size) VALUES (?, ?, ?, ?)`);

// GET /api/acuerdos?anio=&q=&tipo=
router.get('/', (req, res) => {
  const where = ['1=1'];
  const params = [];
  if (req.query.tipo) { where.push('a.tipo = ?'); params.push(req.query.tipo); }
  if (req.query.anio) { where.push('a.anio = ?'); params.push(parseInt(req.query.anio)); }
  if (req.query.q) {
    where.push('(a.numero LIKE ? OR a.sintesis LIKE ?)');
    params.push(`%${req.query.q}%`, `%${req.query.q}%`);
  }
  const rows = db.prepare(`
    SELECT a.*, u.nombre AS creado_por_nombre,
           (SELECT COUNT(*) FROM cvic_acuerdo_adjuntos x WHERE x.acuerdo_id = a.id) AS num_adjuntos
    FROM cvic_acuerdos a LEFT JOIN usuarios u ON u.id = a.creado_por
    WHERE ${where.join(' AND ')}
    ORDER BY a.anio DESC, a.correlativo DESC
  `).all(...params);
  res.json(rows);
});

// GET /api/acuerdos/siguiente?tipo=acuerdo&anio=2026 — consecutivo sugerido
router.get('/siguiente', (req, res) => {
  const tipo = TIPOS.includes(req.query.tipo) ? req.query.tipo : 'acuerdo';
  const anio = parseInt(req.query.anio) || new Date().getFullYear();
  const correlativo = siguienteCorrelativo(tipo, anio);
  res.json({ correlativo, numero: buildNumero(tipo, correlativo, anio), autor: AUTOR });
});

// GET /api/acuerdos/:id
router.get('/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM cvic_acuerdos WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Acuerdo no encontrado' });
  res.json({ ...row, adjuntos: listarAdjuntos(row.id) });
});

// POST /api/acuerdos — multipart: tipo, fecha, sintesis, correlativo (opcional), archivos[]
router.post('/', recibirArchivos, (req, res) => {
  const v = validar(req.body);
  if (v.error) { borrarArchivos(req.files); return res.status(400).json({ error: v.error }); }
  try {
    const id = db.transaction(() => {
      const r = db.prepare(`INSERT INTO cvic_acuerdos (tipo, numero, correlativo, anio, fecha, sintesis, autor, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(v.tipo, v.numero, v.correlativo, v.anio, v.fecha, v.sintesis, AUTOR, req.user.id);
      for (const f of req.files || []) insAdjunto.run(r.lastInsertRowid, f.path, f.originalname, f.size);
      return r.lastInsertRowid;
    })();
    res.status(201).json({ id, numero: v.numero });
  } catch (e) {
    borrarArchivos(req.files);
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: `El ${v.numero} ya está registrado` });
    throw e;
  }
});

// PUT /api/acuerdos/:id — edita datos (el número se recalcula si cambia el consecutivo o el año)
router.put('/:id', (req, res) => {
  const actual = db.prepare(`SELECT * FROM cvic_acuerdos WHERE id = ?`).get(req.params.id);
  if (!actual) return res.status(404).json({ error: 'Acuerdo no encontrado' });
  const v = validar({ tipo: actual.tipo, correlativo: actual.correlativo, ...req.body }, actual.id);
  if (v.error) return res.status(400).json({ error: v.error });
  db.prepare(`UPDATE cvic_acuerdos SET numero = ?, correlativo = ?, anio = ?, fecha = ?, sintesis = ?, actualizado_en = datetime('now','localtime') WHERE id = ?`)
    .run(v.numero, v.correlativo, v.anio, v.fecha, v.sintesis, actual.id);
  res.json({ ok: true, numero: v.numero });
});

// DELETE /api/acuerdos/:id — borra el acuerdo y sus archivos
router.delete('/:id', (req, res) => {
  const adj = db.prepare(`SELECT path FROM cvic_acuerdo_adjuntos WHERE acuerdo_id = ?`).all(req.params.id);
  const r = db.prepare(`DELETE FROM cvic_acuerdos WHERE id = ?`).run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Acuerdo no encontrado' });
  db.prepare(`DELETE FROM cvic_acuerdo_adjuntos WHERE acuerdo_id = ?`).run(req.params.id);
  borrarArchivos(adj);
  res.json({ ok: true });
});

// POST /api/acuerdos/:id/archivos — agrega archivos a un acuerdo existente
router.post('/:id/archivos', recibirArchivos, (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Selecciona al menos un archivo' });
  const existe = db.prepare(`SELECT id FROM cvic_acuerdos WHERE id = ?`).get(req.params.id);
  if (!existe) { borrarArchivos(req.files); return res.status(404).json({ error: 'Acuerdo no encontrado' }); }
  const count = listarAdjuntos(existe.id).length;
  if (count + req.files.length > MAX_ADJUNTOS) {
    borrarArchivos(req.files);
    return res.status(400).json({ error: `Máximo ${MAX_ADJUNTOS} archivos por acuerdo (ya tiene ${count})` });
  }
  for (const f of req.files) insAdjunto.run(existe.id, f.path, f.originalname, f.size);
  db.prepare(`UPDATE cvic_acuerdos SET actualizado_en = datetime('now','localtime') WHERE id = ?`).run(existe.id);
  res.json({ ok: true, adjuntos: listarAdjuntos(existe.id) });
});

// GET /api/acuerdos/:id/archivos/:adjId — descarga
router.get('/:id/archivos/:adjId', (req, res) => {
  const adj = db.prepare(`SELECT path, original_name FROM cvic_acuerdo_adjuntos WHERE id = ? AND acuerdo_id = ?`).get(req.params.adjId, req.params.id);
  if (!adj || !fs.existsSync(adj.path)) return res.status(404).json({ error: 'Archivo no disponible' });
  res.download(adj.path, adj.original_name || path.basename(adj.path));
});

// DELETE /api/acuerdos/:id/archivos/:adjId
router.delete('/:id/archivos/:adjId', (req, res) => {
  const adj = db.prepare(`SELECT path FROM cvic_acuerdo_adjuntos WHERE id = ? AND acuerdo_id = ?`).get(req.params.adjId, req.params.id);
  if (!adj) return res.status(404).json({ error: 'Archivo no encontrado' });
  db.prepare(`DELETE FROM cvic_acuerdo_adjuntos WHERE id = ?`).run(req.params.adjId);
  borrarArchivos([adj]);
  res.json({ ok: true });
});

module.exports = router;
