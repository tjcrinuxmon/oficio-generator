const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../database');
const { JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

  const db = getDb();
  const result = db.exec(`SELECT id, nombre, email, password_hash, rol, activo FROM usuarios WHERE email = '${email.replace(/'/g, "''")}'`);

  if (!result.length || !result[0].values.length) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  const [id, nombre, emailDb, password_hash, rol, activo] = result[0].values[0];
  if (!activo) return res.status(401).json({ error: 'Usuario desactivado' });
  if (!bcrypt.compareSync(password, password_hash)) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  const token = jwt.sign({ id, email: emailDb, rol }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id, nombre, email: emailDb, rol } });
});

// GET /api/auth/me
router.get('/me', require('../middleware/auth').authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
