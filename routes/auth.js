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

// GET /api/auth/sso?sso_token=xxx  — portal SSO entry point
const PORTAL_SSO_SECRET = process.env.PORTAL_SSO_SECRET || 'ine_portal_sso_oficios_2026';
router.get('/sso', (req, res) => {
  const { sso_token } = req.query;
  if (!sso_token) return res.redirect('/?error=missing_token');
  try {
    const payload = jwt.verify(sso_token, PORTAL_SSO_SECRET);
    const db = getDb();
    let result = db.exec(`SELECT id, nombre, email, rol, activo FROM usuarios WHERE email = '${payload.email.replace(/'/g,"''")}'`);
    let user;
    if (!result.length || !result[0].values.length) {
      // Auto-create user on first SSO login
      db.run(`INSERT OR IGNORE INTO usuarios (nombre, email, password_hash, rol, activo) VALUES ('${payload.nombre.replace(/'/g,"''")}','${payload.email.replace(/'/g,"''")}','sso_user','${(payload.rol||'usuario')}',1)`);
      result = db.exec(`SELECT id, nombre, email, rol, activo FROM usuarios WHERE email = '${payload.email.replace(/'/g,"''")}'`);
    }
    const [id, nombre, email, rol] = result[0].values[0];
    user = { id, nombre, email, rol };
    const token = jwt.sign({ id, email, rol }, JWT_SECRET, { expiresIn: '8h' });
    const userJson = JSON.stringify(user).replace(/'/g, "\\'");
    res.send(`<!DOCTYPE html><html><body><script>localStorage.setItem('ine_token','${token}');window.location.href='/oficios';</script></body></html>`);
  } catch (e) {
    res.redirect('/?error=invalid_token');
  }
});

module.exports = router;
