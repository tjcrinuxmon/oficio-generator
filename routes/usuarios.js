const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb, saveDb } = require('../database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware, adminMiddleware);

function rowsToObjects(result) {
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
}

// GET /api/usuarios
router.get('/', (req, res) => {
  const db = getDb();
  const result = db.exec(`SELECT id, nombre, email, rol, activo, creado_en FROM usuarios ORDER BY creado_en DESC`);
  res.json(rowsToObjects(result));
});

// POST /api/usuarios
router.post('/', (req, res) => {
  const { nombre, email, password, rol } = req.body;
  if (!nombre || !email || !password) return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
  const rolFinal = ['admin', 'usuario'].includes(rol) ? rol : 'usuario';
  const hash = bcrypt.hashSync(password, 10);
  const db = getDb();
  try {
    db.run(`INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)`,
      [nombre, email, hash, rolFinal]);
    saveDb();
    const result = db.exec(`SELECT id, nombre, email, rol, activo FROM usuarios WHERE email = '${email.replace(/'/g, "''")}'`);
    const cols = result[0].columns;
    const obj = {};
    cols.forEach((c, i) => obj[c] = result[0].values[0][i]);
    res.status(201).json(obj);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'El email ya existe' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/usuarios/:id
router.put('/:id', (req, res) => {
  const { nombre, email, password, rol, activo } = req.body;
  const db = getDb();
  const existing = db.exec(`SELECT id FROM usuarios WHERE id = ${req.params.id}`);
  if (!existing.length || !existing[0].values.length) return res.status(404).json({ error: 'Usuario no encontrado' });

  if (nombre) db.run(`UPDATE usuarios SET nombre = ? WHERE id = ${req.params.id}`, [nombre]);
  if (email) db.run(`UPDATE usuarios SET email = ? WHERE id = ${req.params.id}`, [email]);
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.run(`UPDATE usuarios SET password_hash = ? WHERE id = ${req.params.id}`, [hash]);
  }
  if (rol && ['admin', 'usuario'].includes(rol)) db.run(`UPDATE usuarios SET rol = ? WHERE id = ${req.params.id}`, [rol]);
  if (activo !== undefined) db.run(`UPDATE usuarios SET activo = ? WHERE id = ${req.params.id}`, [activo ? 1 : 0]);
  saveDb();
  res.json({ ok: true });
});

// DELETE /api/usuarios/:id (desactivar)
router.delete('/:id', (req, res) => {
  const db = getDb();
  db.run(`UPDATE usuarios SET activo = 0 WHERE id = ${req.params.id}`);
  saveDb();
  res.json({ ok: true });
});

module.exports = router;
