const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { CVIC_AREA, puedeCvic, buildOficioNumero, validarDocumento, insertarDocumento } = require('../lib/documentos');

const router = express.Router();
router.use(authMiddleware);

// Generación masiva desde Excel (plantilla con catálogos + carga). Antes de las rutas /:id.
router.use('/carga-masiva', require('./cargaMasiva'));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename: (req, file, cb) => cb(null, `acuse_${req.params.id}_${Date.now()}_${Math.round(Math.random() * 1e6)}.pdf`),
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Solo se permiten archivos PDF'));
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

// Archivos de los acuerdos CVIC: PDF o Word, hasta 10, conservando la extensión.
const EXT_ACUERDO = ['.pdf', '.doc', '.docx'];
const MAX_ADJUNTOS_ACUERDO = 10;
const uploadAcuerdo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
    filename: (req, file, cb) => cb(null, `acuerdo_${req.params.id || 'nuevo'}_${Date.now()}_${Math.round(Math.random() * 1e6)}${path.extname(file.originalname).toLowerCase()}`),
  }),
  fileFilter: (req, file, cb) => {
    // multer entrega el nombre en latin1; se reinterpreta como UTF-8 para conservar acentos.
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (EXT_ACUERDO.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Solo se permiten archivos PDF o Word'));
  },
  limits: { fileSize: 20 * 1024 * 1024, files: MAX_ADJUNTOS_ACUERDO },
});
const MSG_LIMITE_ACUERDO = (err) =>
  err.code === 'LIMIT_FILE_SIZE' ? 'Cada archivo debe pesar como máximo 20 MB'
  : (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') ? `Máximo ${MAX_ADJUNTOS_ACUERDO} archivos por acuerdo`
  : err.message;
const borrarSubidos = (files = []) => files.forEach(f => fs.unlink(f.path, () => {}));

const CONTENT_TYPES = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

const JOIN = `
  FROM oficios o
  LEFT JOIN firmantes f ON o.firmante_id = f.id
  LEFT JOIN usuarios u ON o.creado_por = u.id
`;

// Tipos reservados a la Comisión: sus oficios y sus acuerdos.
const TIPOS_CVIC = ['cvic', 'acuerdo'];
const esTipoCvic = (tipo) => TIPOS_CVIC.includes(tipo);

function buildWhere(query, userId, rol, userArea) {
  const { estatus, area, firmante_id, fecha_inicio, fecha_fin, q, tipo } = query;
  const where = ['1=1'];
  const params = [];
  // Enlace: ve todos los oficios de SU dirección (área). Otros no-admin: solo los propios.
  if (rol === 'enlace') {
    where.push('o.area = ?'); params.push(userArea || '');
  } else if (rol !== 'admin') {
    // Los acuerdos son de toda la Comisión: cualquier usuario de la CVIC los ve.
    where.push(userArea === CVIC_AREA ? `(o.creado_por = ? OR o.tipo = 'acuerdo')` : 'o.creado_por = ?'); params.push(userId);
  }
  // Los oficios CVIC solo los ve la propia Comisión (por área) o un administrador.
  if (!(rol === 'admin' || userArea === CVIC_AREA)) {
    where.push(`(o.tipo IS NULL OR o.tipo NOT IN ('cvic', 'acuerdo'))`);
  }
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
  const { clause, params } = buildWhere(req.query, req.user.id, req.user.rol, req.user.area);
  const sql = `SELECT o.*, f.nombre as firmante_nombre, f.cargo as firmante_cargo, f.es_titular, u.nombre as creado_por_nombre, (SELECT COUNT(*) FROM oficio_adjuntos a WHERE a.oficio_id = o.id) AS adjuntos_count ${JOIN} WHERE ${clause} ORDER BY o.id DESC`;
  res.json(db.prepare(sql).all(...params));
});

// GET /api/oficios/:id
router.get('/:id', (req, res) => {
  // Enlace accede a oficios de su dirección; otros no-admin, solo a los propios.
  let ownerClause = '';
  const params = [req.params.id];
  if (req.user.rol === 'enlace') {
    ownerClause = 'AND o.area = ?'; params.push(req.user.area || '');
  } else if (req.user.rol !== 'admin') {
    ownerClause = req.user.area === CVIC_AREA ? `AND (o.creado_por = ? OR o.tipo = 'acuerdo')` : 'AND o.creado_por = ?'; params.push(req.user.id);
  }
  const row = db.prepare(`SELECT o.*, f.nombre as firmante_nombre, f.cargo as firmante_cargo, f.es_titular, u.nombre as creado_por_nombre ${JOIN} WHERE o.id = ? ${ownerClause}`).get(...params);
  if (!row) return res.status(404).json({ error: 'Oficio no encontrado' });
  if (esTipoCvic(row.tipo) && !puedeCvic(req.user)) return res.status(404).json({ error: 'Oficio no encontrado' });
  res.json(row);
});

// POST /api/oficios/generar — atomic
router.post('/generar', (req, res) => {
  const v = validarDocumento(req.body, req.user);
  if (v.error) return res.status(v.status).json({ error: v.error });
  try {
    const { id } = db.transaction(() => insertarDocumento(v.datos, req.user.id))();
    res.status(201).json(db.prepare(`SELECT o.*, f.nombre as firmante_nombre, f.cargo as firmante_cargo, u.nombre as creado_por_nombre ${JOIN} WHERE o.id = ?`).get(id));
  } catch (e) {
    console.error('[generar]', e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'No se pudo generar el documento' });
  }
});

// POST /api/oficios/acuerdo — registra un acuerdo de la CVIC (multipart: fecha, sintesis, archivos[]).
// No se genera Word: el acuerdo ya está aprobado y se sube. Autor y área son siempre la Comisión;
// no lleva destinatario ni ID SAI. firmante_id es obligatorio (llave foránea): se guarda la
// Presidencia de la Comisión, que no se muestra en pantalla ni en el Excel.
router.post('/acuerdo', (req, res) => {
  uploadAcuerdo.array('archivos', MAX_ADJUNTOS_ACUERDO)(req, res, (err) => {
    if (err) return res.status(400).json({ error: MSG_LIMITE_ACUERDO(err) });
    const files = req.files || [];
    const fallar = (status, error) => { borrarSubidos(files); res.status(status).json({ error }); };

    if (!puedeCvic(req.user)) return fallar(403, 'Solo la Comisión de Verificación de Integridad en Candidaturas o un administrador pueden registrar acuerdos');
    const fecha = String(req.body.fecha || '').trim();
    const sintesis = String(req.body.sintesis || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !sintesis) return fallar(400, 'La fecha y la síntesis o título son obligatorias');
    if (sintesis.length > 1000) return fallar(400, 'La síntesis o título no debe exceder 1000 caracteres');

    const activo = db.prepare(`SELECT id, anio, correlativo_acuerdo_actual FROM anios_config WHERE activo = 1 LIMIT 1`).get();
    if (!activo) return fallar(500, 'No hay año activo configurado');
    if (parseInt(fecha.slice(0, 4)) !== activo.anio) return fallar(400, `La fecha del acuerdo debe ser de ${activo.anio} (año activo)`);
    const presidencia = db.prepare(`SELECT id FROM firmantes WHERE cvic_rol = 'presidencia' ORDER BY activo DESC, id LIMIT 1`).get()
                     || db.prepare(`SELECT id FROM firmantes WHERE es_titular = 1 ORDER BY id LIMIT 1`).get();
    if (!presidencia) return fallar(500, 'No hay firmante de la Presidencia de la Comisión en el catálogo');

    try {
      const acuerdo = db.transaction(() => {
        const maxReal = db.prepare(`SELECT COALESCE(MAX(correlativo), 0) AS max FROM oficios WHERE anio = ? AND tipo = 'acuerdo'`).get(activo.anio).max;
        const correlativo = Math.max(activo.correlativo_acuerdo_actual || 0, maxReal) + 1;
        const numero = buildOficioNumero(correlativo, activo.anio, 'acuerdo');
        db.prepare(`UPDATE anios_config SET correlativo_acuerdo_actual = ? WHERE id = ?`).run(correlativo, activo.id);
        const r = db.prepare(`INSERT INTO oficios (numero_oficio, correlativo, anio, tipo, fecha, destinatario, cargo_destinatario, asunto, firmante_id, solicita, area, justificacion_sai, estatus, acuse_path, creado_por)
                              VALUES (?, ?, ?, 'acuerdo', ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(numero, correlativo, activo.anio, fecha, sintesis, presidencia.id, req.user.nombre, CVIC_AREA,
               'No aplica a acuerdos de la Comisión de Verificación de Integridad en Candidaturas.',
               files.length ? 'archivado' : 'borrador', files[0]?.path || null, req.user.id);
        const ins = db.prepare(`INSERT INTO oficio_adjuntos (oficio_id, path, original_name, size) VALUES (?, ?, ?, ?)`);
        for (const f of files) ins.run(r.lastInsertRowid, f.path, f.originalname, f.size);
        return db.prepare(`SELECT o.*, u.nombre as creado_por_nombre ${JOIN} WHERE o.id = ?`).get(r.lastInsertRowid);
      })();
      res.status(201).json(acuerdo);
    } catch (e) {
      fallar(500, e.message);
    }
  });
});

// PUT /api/oficios/:id
router.put('/:id', (req, res) => {
  const { estatus, fecha, destinatario, cargo_destinatario, institucion, asunto, cuerpo, id_sai, justificacion_sai, sintesis, firmante_id, justificacion_firmante, razon, solicita, area, url_solicitante, razon_reactivacion, reviso_nombre, reviso_puesto, elaboro_nombre, elaboro_puesto, ambito, incluir_vre } = req.body;
  const ownerClause = req.user.rol === 'admin' ? ''
    : req.user.area === CVIC_AREA ? `AND (creado_por = ? OR tipo = 'acuerdo')` // acuerdos: los edita toda la Comisión
    : 'AND creado_por = ?';
  const checkParams = req.user.rol !== 'admin' ? [req.params.id, req.user.id] : [req.params.id];
  const oficioActual = db.prepare(`SELECT id, tipo, modalidad_cvic, anio FROM oficios WHERE id = ? ${ownerClause}`).get(...checkParams);
  if (!oficioActual) {
    return res.status(404).json({ error: 'Oficio no encontrado' });
  }
  if (esTipoCvic(oficioActual.tipo) && !puedeCvic(req.user)) {
    return res.status(404).json({ error: 'Oficio no encontrado' });
  }
  // El número del acuerdo lleva el año: la fecha no puede salirse de ese año.
  if (oficioActual.tipo === 'acuerdo' && fecha && parseInt(String(fecha).slice(0, 4)) !== oficioActual.anio) {
    return res.status(400).json({ error: `La fecha del acuerdo debe ser de ${oficioActual.anio}` });
  }
  // Un oficio CVIC ya numerado no puede cambiar a un firmante de la otra modalidad (Presidencia ↔ Secretaría Técnica).
  if (firmante_id && oficioActual.tipo === 'cvic') {
    const nuevoFirmante = db.prepare(`SELECT cvic_rol FROM firmantes WHERE id = ?`).get(parseInt(firmante_id));
    const modalidadActual = oficioActual.modalidad_cvic || 'presidencia';
    if (!nuevoFirmante || nuevoFirmante.cvic_rol !== modalidadActual) {
      return res.status(400).json({ error: 'El firmante seleccionado no corresponde a la modalidad CVIC de este oficio' });
    }
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
  if (ambito !== undefined)           { sets.push('ambito = ?'); params.push(ambito === 'externo' ? 'externo' : 'interno'); }
  if (incluir_vre !== undefined)      { sets.push('incluir_vre = ?'); params.push((incluir_vre === false || incluir_vre === 0 || incluir_vre === '0' || incluir_vre === 'false') ? 0 : 1); }
  // ID SAI y justificación de SAI: mutuamente excluyentes. Si llega el ID SAI, gana y se limpia la justificación.
  if (id_sai !== undefined || justificacion_sai !== undefined) {
    const idv = id_sai ? String(id_sai).trim() : '';
    if (idv && (!/^\d+$/.test(idv) || idv.length > 10)) {
      return res.status(400).json({ error: 'El ID SAI debe ser numérico y tener máximo 10 dígitos' });
    }
    const jusv = idv ? null : (justificacion_sai ? String(justificacion_sai).trim() || null : null);
    sets.push('id_sai = ?');            params.push(idv || null);
    sets.push('justificacion_sai = ?'); params.push(jusv);
  }
  if (sintesis !== undefined)          { sets.push('sintesis = ?'); params.push(sintesis || null); }
  sets.push(`actualizado_en = datetime('now','localtime')`);

  if (sets.length > 1) {
    db.prepare(`UPDATE oficios SET ${sets.join(', ')} WHERE id = ?`).run(...params, req.params.id);
  }
  res.json({ ok: true });
});

const MAX_ADJUNTOS = 3;

// Deja acuse_path apuntando al primer adjunto (indicador de "tiene acuse") o NULL.
function sincronizarAcusePath(oficioId) {
  const first = db.prepare(`SELECT path FROM oficio_adjuntos WHERE oficio_id = ? ORDER BY id LIMIT 1`).get(oficioId);
  db.prepare(`UPDATE oficios SET acuse_path = ? WHERE id = ?`).run(first ? first.path : null, oficioId);
  return !!first;
}

// Adjuntos: solo quien puede ver el oficio (misma regla que GET /:id) puede listar, descargar,
// subir o borrar sus archivos. Antes bastaba con estar autenticado y conocer el id.
// Va antes de multer para no escribir en disco archivos de una petición no autorizada.
function exigirOficio(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Oficio no encontrado' });
  let ownerClause = '';
  const params = [id];
  if (req.user.rol === 'enlace') {
    ownerClause = 'AND area = ?'; params.push(req.user.area || '');
  } else if (req.user.rol !== 'admin') {
    ownerClause = req.user.area === CVIC_AREA ? `AND (creado_por = ? OR tipo = 'acuerdo')` : 'AND creado_por = ?'; params.push(req.user.id);
  }
  const oficio = db.prepare(`SELECT id, tipo, numero_oficio, acuse_path FROM oficios WHERE id = ? ${ownerClause}`).get(...params);
  if (!oficio || (esTipoCvic(oficio.tipo) && !puedeCvic(req.user))) return res.status(404).json({ error: 'Oficio no encontrado' });
  req.oficio = oficio;
  next();
}

// GET /api/oficios/:id/acuses — lista de adjuntos
router.get('/:id/acuses', exigirOficio, (req, res) => {
  const rows = db.prepare(`SELECT id, original_name, size, creado_en FROM oficio_adjuntos WHERE oficio_id = ? ORDER BY id`).all(req.oficio.id);
  res.json(rows);
});

// POST /api/oficios/:id/acuse — agrega un adjunto (hasta 3, no reemplaza; acuerdos: hasta 10, PDF o Word)
router.post('/:id/acuse', exigirOficio, (req, res) => {
  const tipo = req.oficio.tipo;
  const esAcuerdo = tipo === 'acuerdo';
  const max = esAcuerdo ? MAX_ADJUNTOS_ACUERDO : MAX_ADJUNTOS;
  (esAcuerdo ? uploadAcuerdo : upload).single('acuse')(req, res, (err) => {
    if (err) return res.status(400).json({ error: esAcuerdo ? MSG_LIMITE_ACUERDO(err) : err.message });
    if (!req.file) return res.status(400).json({ error: esAcuerdo ? 'Archivo PDF o Word requerido' : 'Archivo PDF requerido' });

    const count = db.prepare(`SELECT COUNT(*) c FROM oficio_adjuntos WHERE oficio_id = ?`).get(req.params.id).c;
    if (count >= max) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: `Máximo ${max} archivos por ${esAcuerdo ? 'acuerdo' : 'oficio'}` }); }

    db.prepare(`INSERT INTO oficio_adjuntos (oficio_id, path, original_name, size) VALUES (?, ?, ?, ?)`)
      .run(req.params.id, req.file.path, req.file.originalname, req.file.size);
    sincronizarAcusePath(req.params.id);
    db.prepare(`UPDATE oficios SET estatus = 'archivado', actualizado_en = datetime('now','localtime') WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });
});

// GET /api/oficios/:id/acuse/:adjId — descarga un adjunto específico
router.get('/:id/acuse/:adjId', exigirOficio, (req, res) => {
  const adj = db.prepare(`SELECT a.path, a.original_name, o.numero_oficio FROM oficio_adjuntos a JOIN oficios o ON o.id = a.oficio_id WHERE a.id = ? AND a.oficio_id = ?`).get(req.params.adjId, req.params.id);
  if (!adj || !fs.existsSync(adj.path)) return res.status(404).json({ error: 'Archivo no disponible' });
  let name = (adj.original_name || `Acuse_${adj.numero_oficio}`).replace(/[/\\]/g, '_');
  // La extensión real (PDF o, en acuerdos, Word) sale del archivo guardado.
  const ext = path.extname(adj.path).toLowerCase() || '.pdf';
  if (!name.toLowerCase().endsWith(ext)) name += ext;
  res.attachment(name); // codifica nombres con acentos o guiones largos (filename*)
  res.setHeader('Content-Type', CONTENT_TYPES[ext] || 'application/octet-stream');
  fs.createReadStream(adj.path).pipe(res);
});

// DELETE /api/oficios/:id/acuse/:adjId — elimina un adjunto específico
router.delete('/:id/acuse/:adjId', exigirOficio, (req, res) => {
  const adj = db.prepare(`SELECT path FROM oficio_adjuntos WHERE id = ? AND oficio_id = ?`).get(req.params.adjId, req.params.id);
  if (!adj) return res.status(404).json({ error: 'Adjunto no encontrado' });
  if (adj.path && fs.existsSync(adj.path)) { try { fs.unlinkSync(adj.path); } catch (_) {} }
  db.prepare(`DELETE FROM oficio_adjuntos WHERE id = ?`).run(req.params.adjId);
  const tieneAcuse = sincronizarAcusePath(req.params.id);
  if (!tieneAcuse) db.prepare(`UPDATE oficios SET estatus = 'borrador', actualizado_en = datetime('now','localtime') WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// DELETE /api/oficios/:id/acuse — elimina TODOS los adjuntos (regresa a Borrador)
router.delete('/:id/acuse', exigirOficio, (req, res) => {
  const rows = db.prepare(`SELECT path FROM oficio_adjuntos WHERE oficio_id = ?`).all(req.params.id);
  for (const r of rows) if (r.path && fs.existsSync(r.path)) { try { fs.unlinkSync(r.path); } catch (_) {} }
  db.prepare(`DELETE FROM oficio_adjuntos WHERE oficio_id = ?`).run(req.params.id);
  const legacy = db.prepare(`SELECT acuse_path FROM oficios WHERE id = ?`).get(req.params.id);
  if (legacy?.acuse_path && fs.existsSync(legacy.acuse_path)) { try { fs.unlinkSync(legacy.acuse_path); } catch (_) {} }
  db.prepare(`UPDATE oficios SET acuse_path = NULL, estatus = 'borrador', actualizado_en = datetime('now','localtime') WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// GET /api/oficios/:id/acuse — descarga el acuse principal (compatibilidad con Historial)
router.get('/:id/acuse', exigirOficio, (req, res) => {
  const row = req.oficio;
  if (!row.acuse_path || !fs.existsSync(row.acuse_path)) return res.status(404).json({ error: 'Acuse no disponible' });
  const safeName = row.numero_oficio.replace(/\//g, '_');
  const ext = path.extname(row.acuse_path).toLowerCase() || '.pdf';
  res.setHeader('Content-Disposition', `attachment; filename="Acuse_${safeName}${ext}"`);
  res.setHeader('Content-Type', CONTENT_TYPES[ext] || 'application/octet-stream');
  fs.createReadStream(row.acuse_path).pipe(res);
});

module.exports = router;
