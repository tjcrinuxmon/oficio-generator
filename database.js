const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'oficio_db.sqlite');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    rol TEXT NOT NULL DEFAULT 'usuario',
    activo INTEGER NOT NULL DEFAULT 1,
    creado_en DATETIME DEFAULT (datetime('now','localtime'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS firmantes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    cargo TEXT NOT NULL,
    es_titular INTEGER NOT NULL DEFAULT 0,
    activo INTEGER NOT NULL DEFAULT 1
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS anios_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anio INTEGER UNIQUE NOT NULL,
    correlativo_inicio INTEGER NOT NULL,
    correlativo_actual INTEGER NOT NULL,
    activo INTEGER NOT NULL DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS oficios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero_oficio TEXT UNIQUE NOT NULL,
    correlativo INTEGER NOT NULL,
    anio INTEGER NOT NULL,
    fecha TEXT NOT NULL,
    destinatario TEXT NOT NULL,
    cargo_destinatario TEXT NOT NULL,
    asunto TEXT NOT NULL,
    firmante_id INTEGER NOT NULL,
    requiere_justificacion INTEGER NOT NULL DEFAULT 0,
    justificacion_firmante TEXT,
    razon TEXT,
    solicita TEXT NOT NULL,
    area TEXT NOT NULL,
    estatus TEXT NOT NULL DEFAULT 'borrador',
    acuse_path TEXT,
    creado_por INTEGER NOT NULL,
    creado_en DATETIME DEFAULT (datetime('now','localtime')),
    actualizado_en DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (firmante_id) REFERENCES firmantes(id),
    FOREIGN KEY (creado_por) REFERENCES usuarios(id)
  )
`);

// Migrations — add columns without recreating tables
try { db.exec(`ALTER TABLE oficios ADD COLUMN tipo TEXT NOT NULL DEFAULT 'oficio'`); } catch (_) {}
try { db.exec(`ALTER TABLE anios_config ADD COLUMN correlativo_opinion_actual INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE anios_config ADD COLUMN correlativo_dictamen_actual INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE anios_config ADD COLUMN correlativo_certificacion_actual INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE anios_config ADD COLUMN correlativo_opinion_inicio INTEGER NOT NULL DEFAULT 1`); } catch (_) {}
try { db.exec(`ALTER TABLE anios_config ADD COLUMN correlativo_dictamen_inicio INTEGER NOT NULL DEFAULT 1`); } catch (_) {}
try { db.exec(`ALTER TABLE anios_config ADD COLUMN correlativo_certificacion_inicio INTEGER NOT NULL DEFAULT 1`); } catch (_) {}
try { db.exec(`ALTER TABLE oficios ADD COLUMN url_solicitante TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE oficios ADD COLUMN razon_reactivacion TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE oficios ADD COLUMN cuerpo TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE oficios ADD COLUMN id_sai TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE oficios ADD COLUMN sintesis TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE oficios ADD COLUMN institucion TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN area TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE oficios ADD COLUMN reviso_nombre TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE oficios ADD COLUMN reviso_puesto TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE oficios ADD COLUMN elaboro_nombre TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE oficios ADD COLUMN elaboro_puesto TEXT`); } catch (_) {}

// Seed: default admin
if (!db.prepare(`SELECT id FROM usuarios WHERE rol = 'admin' LIMIT 1`).get()) {
  const adminPwd = process.env.ADMIN_SEED_PASSWORD || require('crypto').randomBytes(12).toString('base64url');
  const hash = bcrypt.hashSync(adminPwd, 10);
  db.prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)`)
    .run('Administrador', 'admin@deaj.ine.mx', hash, 'admin');
  console.log(`👤 Admin creado: admin@deaj.ine.mx / ${adminPwd}  ← guarda esta contraseña`);
}

// Seed: default titular
if (!db.prepare(`SELECT id FROM firmantes WHERE es_titular = 1 LIMIT 1`).get()) {
  db.prepare(`INSERT INTO firmantes (nombre, cargo, es_titular) VALUES (?, ?, ?)`)
    .run('Anahí Silva Tosca', 'Titular de la DEAJ', 1);
}
db.prepare(`UPDATE firmantes SET nombre = 'Anahí Silva Tosca' WHERE nombre = 'Abahí Silva Tosca'`).run();
db.prepare(`UPDATE firmantes SET cargo = 'Directora Ejecutiva de Asuntos Jurídicos' WHERE nombre = 'Anahí Silva Tosca' AND cargo != 'Directora Ejecutiva de Asuntos Jurídicos'`).run();

// Normalize: documents with an acuse file should be archived
db.prepare(`UPDATE oficios SET estatus = 'archivado' WHERE acuse_path IS NOT NULL AND acuse_path != '' AND estatus != 'archivado'`).run();

// Seed: 2026 year config
if (!db.prepare(`SELECT id FROM anios_config WHERE anio = 2026 LIMIT 1`).get()) {
  db.prepare(`INSERT INTO anios_config (anio, correlativo_inicio, correlativo_actual, activo) VALUES (?, ?, ?, ?)`)
    .run(2026, 8411, 8411, 1);
}

console.log('✅ Base de datos inicializada correctamente');

module.exports = db;
