#!/usr/bin/env node
/**
 * Crea (o actualiza) una CUENTA DE SERVICIO para integraciones máquina-a-máquina
 * que necesiten generar oficios desde otro sistema.
 *
 * La cuenta se autentica igual que un usuario normal (POST /api/auth/login),
 * obtiene un JWT de 8h y lo usa como Bearer token. Para REVOCARLA al instante,
 * basta con desactivarla:  UPDATE usuarios SET activo = 0 WHERE email = '...';
 * (el authMiddleware verifica `activo` en cada petición).
 *
 * Uso:
 *   node scripts/crear-usuario-servicio.js <email> <password> [nombre] [rol]
 *
 * Ejemplo:
 *   node scripts/crear-usuario-servicio.js sistema-x@deaj 'una-clave-larga-y-aleatoria' "Sistema X (integración)" usuario
 *
 * Recomendaciones:
 *   - rol de bajo privilegio (por defecto "usuario"): solo verá/descargará los
 *     oficios que ella misma genere (creado_por).
 *   - usa una contraseña larga y aleatoria; guárdala en el gestor de secretos
 *     del sistema externo, NO en el código.
 */
const bcrypt = require('bcryptjs');
const db = require('../database');

const [, , emailArg, password, nombre = 'Cuenta de servicio', rol = 'usuario'] = process.argv;

if (!emailArg || !password) {
  console.error('Uso: node scripts/crear-usuario-servicio.js <email> <password> [nombre] [rol]');
  process.exit(1);
}
if (password.length < 12) {
  console.error('La contraseña debe tener al menos 12 caracteres (es una cuenta de servicio).');
  process.exit(1);
}

const email = emailArg.toLowerCase().trim();
const hash = bcrypt.hashSync(password, 10);

const existing = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);

if (existing) {
  db.prepare('UPDATE usuarios SET password_hash = ?, rol = ?, activo = 1, nombre = ? WHERE id = ?')
    .run(hash, rol, nombre, existing.id);
  console.log(`✓ Cuenta de servicio ACTUALIZADA  (id=${existing.id}, email=${email}, rol=${rol})`);
} else {
  const info = db.prepare(
    'INSERT INTO usuarios (nombre, email, password_hash, rol, activo, area) VALUES (?, ?, ?, ?, 1, NULL)'
  ).run(nombre, email, hash, rol);
  console.log(`✓ Cuenta de servicio CREADA  (id=${info.lastInsertRowid}, email=${email}, rol=${rol})`);
}

console.log('\nSiguiente paso: prueba el login\n  curl -X POST https://<gateway>/api/of/auth/login \\');
console.log(`    -H "Content-Type: application/json" -d '{"email":"${email}","password":"<la-clave>"}'`);
