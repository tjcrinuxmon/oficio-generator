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

// GET /api/firmantes
router.get('/', (req, res) => {
  const db = getDb();
  const result = db.exec(`SELECT * FROM firmantes WHERE activo = 1 ORDER BY es_titular DESC, nombre ASC`);
  res.json(rowsToObjects(result));
});

// POST /api/firmantes (admin)
router.post('/', adminMiddleware, (req, res) => {
  const { nombre, cargo, es_titular } = req.body;
  if (!nombre || !cargo) return res.status(400).json({ error: 'Nombre y cargo son requeridos' });
  const esTitular = es_titular ? 1 : 0;
  const db = getDb();
  if (esTitular) db.run(`UPDATE firmantes SET es_titular = 0`);
  db.run(`INSERT INTO firmantes (nombre, cargo, es_titular) VALUES (?, ?, ?)`, [nombre, cargo, esTitular]);
  saveDb();
  const result = db.exec(`SELECT * FROM firmantes ORDER BY id DESC LIMIT 1`);
  res.status(201).json(rowsToObjects(result)[0]);
});

// PUT /api/firmantes/:id (admin)
router.put('/:id', adminMiddleware, (req, res) => {
  const { nombre, cargo, es_titular, activo } = req.body;
  const db = getDb();
  const existing = db.exec(`SELECT id FROM firmantes WHERE id = ${req.params.id}`);
  if (!existing.length || !existing[0].values.length) return res.status(404).json({ error: 'Firmante no encontrado' });

  if (nombre) db.run(`UPDATE firmantes SET nombre = ? WHERE id = ${req.params.id}`, [nombre]);
  if (cargo) db.run(`UPDATE firmantes SET cargo = ? WHERE id = ${req.params.id}`, [cargo]);
  if (es_titular !== undefined) {
    if (es_titular) db.run(`UPDATE firmantes SET es_titular = 0`);
    db.run(`UPDATE firmantes SET es_titular = ? WHERE id = ${req.params.id}`, [es_titular ? 1 : 0]);
  }
  if (activo !== undefined) db.run(`UPDATE firmantes SET activo = ? WHERE id = ${req.params.id}`, [activo ? 1 : 0]);
  saveDb();
  res.json({ ok: true });
});

// DELETE /api/firmantes/:id (admin)
router.delete('/:id', adminMiddleware, (req, res) => {
  const db = getDb();
  const titular = db.exec(`SELECT es_titular FROM firmantes WHERE id = ${req.params.id}`);
  if (titular.length && titular[0].values.length && titular[0].values[0][0]) {
    return res.status(400).json({ error: 'No se puede eliminar al titular' });
  }
  db.run(`UPDATE firmantes SET activo = 0 WHERE id = ${req.params.id}`);
  saveDb();
  res.json({ ok: true });
});

module.exports = router;
