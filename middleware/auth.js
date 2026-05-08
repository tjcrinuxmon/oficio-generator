const jwt = require('jsonwebtoken');
const { getDb } = require('../database');

const JWT_SECRET = process.env.JWT_SECRET || 'oficio-ine-deaj-secret-2026';

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const db = getDb();
    const result = db.exec(`SELECT id, nombre, email, rol, activo FROM usuarios WHERE id = ${payload.id}`);
    if (!result.length || !result[0].values.length) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }
    const [id, nombre, email, rol, activo] = result[0].values[0];
    if (!activo) return res.status(401).json({ error: 'Usuario desactivado' });
    req.user = { id, nombre, email, rol };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user?.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo administradores' });
  }
  next();
}

module.exports = { authMiddleware, adminMiddleware, JWT_SECRET };
