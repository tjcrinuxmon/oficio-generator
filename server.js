require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

require('./database'); // synchronous init — runs migrations and seeds on startup

const app = express();
const PORT = process.env.PORT || 3003;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  exposedHeaders: ['Content-Disposition', 'Content-Length'],
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/usuarios',  require('./routes/usuarios'));
app.use('/api/oficios',   require('./routes/oficios'));
app.use('/api/firmantes', require('./routes/firmantes'));
app.use('/api/anios',     require('./routes/anios'));
app.use('/api/exportar',  require('./routes/exportar'));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n🚀 SiCoDEAJ — Sistema de Control Documental DEAJ corriendo en http://localhost:${PORT}`);
  console.log(`👤 Admin inicial: admin@deaj.ine.mx / Admin1234!`);
  console.log(`📋 Correlativo 2026 iniciando en: 8411\n`);
});
