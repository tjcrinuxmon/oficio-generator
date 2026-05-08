const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'oficio_db.sqlite');

let db = null;

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

async function initDatabase() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`PRAGMA journal_mode = WAL;`);

  // Tabla usuarios
  db.run(`
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

  // Tabla firmantes
  db.run(`
    CREATE TABLE IF NOT EXISTS firmantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      cargo TEXT NOT NULL,
      es_titular INTEGER NOT NULL DEFAULT 0,
      activo INTEGER NOT NULL DEFAULT 1
    )
  `);

  // Tabla catálogo de años
  db.run(`
    CREATE TABLE IF NOT EXISTS anios_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anio INTEGER UNIQUE NOT NULL,
      correlativo_inicio INTEGER NOT NULL,
      correlativo_actual INTEGER NOT NULL,
      activo INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Tabla oficios
  db.run(`
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

  // Migraciones — agregan columnas a tablas existentes sin recrearlas
  try { db.run(`ALTER TABLE oficios ADD COLUMN tipo TEXT NOT NULL DEFAULT 'oficio'`); } catch (_) {}
  try { db.run(`ALTER TABLE anios_config ADD COLUMN correlativo_opinion_actual INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
  try { db.run(`ALTER TABLE oficios ADD COLUMN url_solicitante TEXT`); } catch (_) {}

  // Datos iniciales — admin por defecto
  const adminExists = db.exec(`SELECT id FROM usuarios WHERE rol = 'admin' LIMIT 1`);
  if (!adminExists.length || !adminExists[0].values.length) {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('Admin1234!', 10);
    db.run(`INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)`,
      ['Administrador', 'admin@deaj.ine.mx', hash, 'admin']);
  }

  // Titular por defecto
  const titularExists = db.exec(`SELECT id FROM firmantes WHERE es_titular = 1 LIMIT 1`);
  if (!titularExists.length || !titularExists[0].values.length) {
    db.run(`INSERT INTO firmantes (nombre, cargo, es_titular) VALUES (?, ?, ?)`,
      ['Anahí Silva Tosca', 'Titular de la DEAJ', 1]);
  }
  // Corrección de nombre incorrecto en registros existentes
  db.run(`UPDATE firmantes SET nombre = 'Anahí Silva Tosca' WHERE nombre = 'Abahí Silva Tosca'`);

  // Normalizar estatus: documentos con acuse deben estar en archivado
  db.run(`UPDATE oficios SET estatus = 'archivado' WHERE acuse_path IS NOT NULL AND acuse_path != '' AND estatus != 'archivado'`);

  // Año 2026 por defecto
  const anioExists = db.exec(`SELECT id FROM anios_config WHERE anio = 2026 LIMIT 1`);
  if (!anioExists.length || !anioExists[0].values.length) {
    db.run(`INSERT INTO anios_config (anio, correlativo_inicio, correlativo_actual, activo) VALUES (?, ?, ?, ?)`,
      [2026, 8411, 8411, 1]);
  }

  saveDb();
  console.log('✅ Base de datos inicializada correctamente');
  return db;
}

function getDb() {
  if (!db) throw new Error('Base de datos no inicializada');
  return db;
}

module.exports = { initDatabase, getDb, saveDb };
