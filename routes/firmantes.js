const express = require('express');
const db = require('../database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/firmantes
router.get('/', (req, res) => {
  res.json(db.prepare(`SELECT * FROM firmantes WHERE activo = 1 ORDER BY es_titular DESC, nombre ASC`).all());
});

// POST /api/firmantes (admin)
router.post('/', adminMiddleware, (req, res) => {
  const { nombre, cargo, es_titular } = req.body;
  if (!nombre || !cargo) return res.status(400).json({ error: 'Nombre y cargo son requeridos' });
  const esTitular = es_titular ? 1 : 0;
  if (esTitular) db.prepare(`UPDATE firmantes SET es_titular = 0`).run();
  const r = db.prepare(`INSERT INTO firmantes (nombre, cargo, es_titular) VALUES (?, ?, ?)`).run(nombre, cargo, esTitular);
  res.status(201).json(db.prepare(`SELECT * FROM firmantes WHERE id = ?`).get(r.lastInsertRowid));
});

// PUT /api/firmantes/:id (admin)
router.put('/:id', adminMiddleware, (req, res) => {
  const { nombre, cargo, es_titular, activo } = req.body;
  if (!db.prepare(`SELECT id FROM firmantes WHERE id = ?`).get(req.params.id)) {
    return res.status(404).json({ error: 'Firmante no encontrado' });
  }
  if (nombre)   db.prepare(`UPDATE firmantes SET nombre = ? WHERE id = ?`).run(nombre, req.params.id);
  if (cargo)    db.prepare(`UPDATE firmantes SET cargo = ? WHERE id = ?`).run(cargo, req.params.id);
  if (es_titular !== undefined) {
    if (es_titular) db.prepare(`UPDATE firmantes SET es_titular = 0`).run();
    db.prepare(`UPDATE firmantes SET es_titular = ? WHERE id = ?`).run(es_titular ? 1 : 0, req.params.id);
  }
  if (activo !== undefined) db.prepare(`UPDATE firmantes SET activo = ? WHERE id = ?`).run(activo ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/firmantes/:id (admin)
router.delete('/:id', adminMiddleware, (req, res) => {
  const row = db.prepare(`SELECT es_titular FROM firmantes WHERE id = ?`).get(req.params.id);
  if (row?.es_titular) return res.status(400).json({ error: 'No se puede eliminar al titular' });
  db.prepare(`UPDATE firmantes SET activo = 0 WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
