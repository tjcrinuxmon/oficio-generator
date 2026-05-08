const express = require('express');
const { getDb, saveDb } = require('../database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

function rowsToObjects(result) {
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
}

// GET /api/anios
router.get('/', (req, res) => {
  const db = getDb();
  const result = db.exec(`SELECT * FROM anios_config ORDER BY anio DESC`);
  res.json(rowsToObjects(result));
});

// GET /api/anios/activo
router.get('/activo', (req, res) => {
  const db = getDb();
  const result = db.exec(`SELECT * FROM anios_config WHERE activo = 1 LIMIT 1`);
  if (!result.length || !result[0].values.length) return res.status(404).json({ error: 'No hay año activo' });
  res.json(rowsToObjects(result)[0]);
});

// POST /api/anios (admin)
router.post('/', adminMiddleware, (req, res) => {
  const { anio, correlativo_inicio } = req.body;
  if (!anio || !correlativo_inicio) return res.status(400).json({ error: 'Año y correlativo inicial son requeridos' });
  const db = getDb();
  try {
    db.run(`INSERT INTO anios_config (anio, correlativo_inicio, correlativo_actual, correlativo_opinion_actual, activo) VALUES (?, ?, ?, 0, 0)`,
      [anio, correlativo_inicio, correlativo_inicio]);
    saveDb();
    const result = db.exec(`SELECT * FROM anios_config WHERE anio = ${anio}`);
    res.status(201).json(rowsToObjects(result)[0]);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Ese año ya existe' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/anios/:id/activar (admin)
router.put('/:id/activar', adminMiddleware, (req, res) => {
  const db = getDb();
  const existing = db.exec(`SELECT id FROM anios_config WHERE id = ${req.params.id}`);
  if (!existing.length || !existing[0].values.length) return res.status(404).json({ error: 'Año no encontrado' });
  db.run(`UPDATE anios_config SET activo = 0`);
  db.run(`UPDATE anios_config SET activo = 1 WHERE id = ${req.params.id}`);
  saveDb();
  res.json({ ok: true });
});

// PUT /api/anios/:id (admin - editar correlativo inicial)
router.put('/:id', adminMiddleware, (req, res) => {
  const { correlativo_inicio } = req.body;
  if (!correlativo_inicio) return res.status(400).json({ error: 'Correlativo inicial requerido' });
  const db = getDb();
  db.run(`UPDATE anios_config SET correlativo_inicio = ?, correlativo_actual = ? WHERE id = ${req.params.id}`,
    [correlativo_inicio, correlativo_inicio]);
  saveDb();
  res.json({ ok: true });
});

// DELETE /api/anios/:id (admin)
router.delete('/:id', adminMiddleware, (req, res) => {
  const db = getDb();
  const check = db.exec(`SELECT activo FROM anios_config WHERE id = ${req.params.id}`);
  if (check.length && check[0].values.length && check[0].values[0][0]) {
    return res.status(400).json({ error: 'No se puede eliminar el año activo' });
  }
  db.run(`DELETE FROM anios_config WHERE id = ${req.params.id}`);
  saveDb();
  res.json({ ok: true });
});

module.exports = router;
