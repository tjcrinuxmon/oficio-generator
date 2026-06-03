const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db        = require('../database');
const { JWT_SECRET } = require('../middleware/auth');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera 15 minutos.' },
});

const router = express.Router();

// POST /api/auth/login
router.post('/login', loginLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

  const u = db.prepare(`SELECT id, nombre, email, password_hash, rol, activo, area FROM usuarios WHERE email = ?`).get(email.toLowerCase().trim());
  if (!u) return res.status(401).json({ error: 'Credenciales incorrectas' });
  if (!u.activo) return res.status(401).json({ error: 'Usuario desactivado' });
  if (!bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'Credenciales incorrectas' });

  const token = jwt.sign({ id: u.id, email: u.email, rol: u.rol, area: u.area || null }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol, area: u.area || null } });
});

// GET /api/auth/me
router.get('/me', require('../middleware/auth').authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// GET /api/auth/sso?sso_token=xxx  — portal SSO entry point
const PORTAL_SSO_SECRET = process.env.PORTAL_SSO_SECRET;
if (!PORTAL_SSO_SECRET) { console.error('FATAL: PORTAL_SSO_SECRET no definido'); process.exit(1); }
router.get('/sso', (req, res) => {
  const { sso_token } = req.query;
  if (!sso_token) return res.redirect('/?error=missing_token');
  try {
    const payload = jwt.verify(sso_token, PORTAL_SSO_SECRET);
    let u = db.prepare(`SELECT id, nombre, email, rol, activo, area FROM usuarios WHERE email = ?`).get(payload.email);
    if (!u) {
      db.prepare(`INSERT OR IGNORE INTO usuarios (nombre, email, password_hash, rol, activo, area) VALUES (?, ?, 'sso_user', ?, 1, ?)`)
        .run(payload.nombre, payload.email, payload.rol || 'usuario', payload.area || null);
      u = db.prepare(`SELECT id, nombre, email, rol, activo, area FROM usuarios WHERE email = ?`).get(payload.email);
    } else if (payload.area && !u.area) {
      db.prepare(`UPDATE usuarios SET area = ? WHERE id = ?`).run(payload.area, u.id);
      u.area = payload.area;
    }
    const token = jwt.sign({ id: u.id, email: u.email, rol: u.rol, area: u.area || null }, JWT_SECRET, { expiresIn: '8h' });
    const safeToken = JSON.stringify(token);
    const safeUser  = JSON.stringify({ id: u.id, nombre: u.nombre, email: u.email, rol: u.rol, area: u.area || null });
    res.send(`<!DOCTYPE html><html><body><script>localStorage.setItem('ine_token',${safeToken});localStorage.setItem('ine_user',${safeUser});window.location.href='/oficios';</script></body></html>`);
  } catch (e) {
    res.redirect('/?error=invalid_token');
  }
});

module.exports = router;
