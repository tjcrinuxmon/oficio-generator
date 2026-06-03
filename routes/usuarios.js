const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware, adminMiddleware);

// GET /api/usuarios
router.get('/', (req, res) => {
  res.json(db.prepare(`SELECT id, nombre, email, rol, activo, area, creado_en FROM usuarios ORDER BY creado_en DESC`).all());
});

// POST /api/usuarios
router.post('/', (req, res) => {
  const { nombre, email, password, rol, area } = req.body;
  if (!nombre || !email || !password) return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
  const rolFinal = ['admin', 'usuario'].includes(rol) ? rol : 'usuario';
  const hash = bcrypt.hashSync(password, 10);
  try {
    const r = db.prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, area) VALUES (?, ?, ?, ?, ?)`).run(nombre, email.toLowerCase(), hash, rolFinal, area || null);
    res.status(201).json(db.prepare(`SELECT id, nombre, email, rol, activo, area FROM usuarios WHERE id = ?`).get(r.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'El email ya existe' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/usuarios/:id
router.put('/:id', (req, res) => {
  const { nombre, email, password, rol, activo, area } = req.body;
  if (!db.prepare(`SELECT id FROM usuarios WHERE id = ?`).get(req.params.id)) {
    return res.status(404).json({ error: 'Usuario no encontrado' });
  }
  if (nombre)   db.prepare(`UPDATE usuarios SET nombre = ? WHERE id = ?`).run(nombre, req.params.id);
  if (email)    db.prepare(`UPDATE usuarios SET email = ? WHERE id = ?`).run(email.toLowerCase(), req.params.id);
  if (password) db.prepare(`UPDATE usuarios SET password_hash = ? WHERE id = ?`).run(bcrypt.hashSync(password, 10), req.params.id);
  if (rol && ['admin', 'usuario'].includes(rol)) db.prepare(`UPDATE usuarios SET rol = ? WHERE id = ?`).run(rol, req.params.id);
  if (activo !== undefined) db.prepare(`UPDATE usuarios SET activo = ? WHERE id = ?`).run(activo ? 1 : 0, req.params.id);
  if (area  !== undefined) db.prepare(`UPDATE usuarios SET area  = ? WHERE id = ?`).run(area  || null, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/usuarios/:id (desactivar)
router.delete('/:id', (req, res) => {
  db.prepare(`UPDATE usuarios SET activo = 0 WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
