require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { initDatabase } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Rutas
app.use('/api/auth', require('./routes/auth'));
app.use('/api/oficios', require('./routes/oficios'));
app.use('/api/firmantes', require('./routes/firmantes'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/anios', require('./routes/anios'));
app.use('/api/exportar', require('./routes/exportar'));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 Sistema de Oficios INE/DEAJ corriendo en http://localhost:${PORT}`);
    console.log(`👤 Admin inicial: admin@deaj.ine.mx / Admin1234!`);
    console.log(`📋 Correlativo 2026 iniciando en: 8411\n`);
  });
}).catch(err => {
  console.error('❌ Error al inicializar la base de datos:', err);
  process.exit(1);
});
