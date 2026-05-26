const express = require('express');
const db = require('../database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/anios
router.get('/', (req, res) => {
  res.json(db.prepare(`SELECT * FROM anios_config ORDER BY anio DESC`).all());
});

// GET /api/anios/activo
router.get('/activo', (req, res) => {
  const row = db.prepare(`SELECT * FROM anios_config WHERE activo = 1 LIMIT 1`).get();
  if (!row) return res.status(404).json({ error: 'No hay año activo' });
  res.json(row);
});

// POST /api/anios (admin)
router.post('/', adminMiddleware, (req, res) => {
  const { anio, correlativo_inicio, correlativo_opinion_inicio = 1, correlativo_dictamen_inicio = 1, correlativo_certificacion_inicio = 1 } = req.body;
  if (!anio || !correlativo_inicio) return res.status(400).json({ error: 'Año y correlativo inicial de oficios son requeridos' });
  try {
    db.prepare(`INSERT INTO anios_config
      (anio, correlativo_inicio, correlativo_actual,
       correlativo_opinion_inicio, correlativo_opinion_actual,
       correlativo_dictamen_inicio, correlativo_dictamen_actual,
       correlativo_certificacion_inicio, correlativo_certificacion_actual, activo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
      .run(anio, correlativo_inicio, correlativo_inicio,
           correlativo_opinion_inicio, correlativo_opinion_inicio,
           correlativo_dictamen_inicio, correlativo_dictamen_inicio,
           correlativo_certificacion_inicio, correlativo_certificacion_inicio);
    res.status(201).json(db.prepare(`SELECT * FROM anios_config WHERE anio = ?`).get(anio));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Ese año ya existe' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/anios/:id/activar (admin)
router.put('/:id/activar', adminMiddleware, (req, res) => {
  if (!db.prepare(`SELECT id FROM anios_config WHERE id = ?`).get(req.params.id)) {
    return res.status(404).json({ error: 'Año no encontrado' });
  }
  db.prepare(`UPDATE anios_config SET activo = 0`).run();
  db.prepare(`UPDATE anios_config SET activo = 1 WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// PUT /api/anios/:id (admin - editar correlativos iniciales)
router.put('/:id', adminMiddleware, (req, res) => {
  const {
    correlativo_inicio,
    correlativo_opinion_inicio,
    correlativo_dictamen_inicio,
    correlativo_certificacion_inicio,
  } = req.body;
  if (!correlativo_inicio) return res.status(400).json({ error: 'Correlativo inicial de oficios requerido' });
  const opI = correlativo_opinion_inicio ?? 1;
  const dtI = correlativo_dictamen_inicio ?? 1;
  const ctI = correlativo_certificacion_inicio ?? 1;
  db.prepare(`UPDATE anios_config SET
    correlativo_inicio = ?, correlativo_actual = ?,
    correlativo_opinion_inicio = ?, correlativo_opinion_actual = ?,
    correlativo_dictamen_inicio = ?, correlativo_dictamen_actual = ?,
    correlativo_certificacion_inicio = ?, correlativo_certificacion_actual = ?
    WHERE id = ?`)
    .run(correlativo_inicio, correlativo_inicio, opI, opI, dtI, dtI, ctI, ctI, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/anios/:id (admin)
router.delete('/:id', adminMiddleware, (req, res) => {
  const row = db.prepare(`SELECT activo FROM anios_config WHERE id = ?`).get(req.params.id);
  if (row?.activo) return res.status(400).json({ error: 'No se puede eliminar el año activo' });
  db.prepare(`DELETE FROM anios_config WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
