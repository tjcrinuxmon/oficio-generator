const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');
const { JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

  const u = db.prepare(`SELECT id, nombre, email, password_hash, rol, activo FROM usuarios WHERE email = ?`).get(email.toLowerCase().trim());
  if (!u) return res.status(401).json({ error: 'Credenciales incorrectas' });
  if (!u.activo) return res.status(401).json({ error: 'Usuario desactivado' });
  if (!bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'Credenciales incorrectas' });

  const token = jwt.sign({ id: u.id, email: u.email, rol: u.rol }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol } });
});

// GET /api/auth/me
router.get('/me', require('../middleware/auth').authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// GET /api/auth/sso?sso_token=xxx  — portal SSO entry point
const PORTAL_SSO_SECRET = process.env.PORTAL_SSO_SECRET || 'ine_portal_sso_oficios_2026';
router.get('/sso', (req, res) => {
  const { sso_token } = req.query;
  if (!sso_token) return res.redirect('/?error=missing_token');
  try {
    const payload = jwt.verify(sso_token, PORTAL_SSO_SECRET);
    let u = db.prepare(`SELECT id, nombre, email, rol, activo FROM usuarios WHERE email = ?`).get(payload.email);
    if (!u) {
      db.prepare(`INSERT OR IGNORE INTO usuarios (nombre, email, password_hash, rol, activo) VALUES (?, ?, 'sso_user', ?, 1)`)
        .run(payload.nombre, payload.email, payload.rol || 'usuario');
      u = db.prepare(`SELECT id, nombre, email, rol, activo FROM usuarios WHERE email = ?`).get(payload.email);
    }
    const token = jwt.sign({ id: u.id, email: u.email, rol: u.rol }, JWT_SECRET, { expiresIn: '8h' });
    res.send(`<!DOCTYPE html><html><body><script>localStorage.setItem('ine_token','${token}');window.location.href='/oficios';</script></body></html>`);
  } catch (e) {
    res.redirect('/?error=invalid_token');
  }
});

module.exports = router;
