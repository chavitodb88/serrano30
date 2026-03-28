if (!process.versions.electron) {
  require('dotenv').config();
}
const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');

const { generateNonce, helmetMiddleware, generalLimiter, csrfProtection } = require('./middleware/security');
const { requireAuth } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const documentRoutes = require('./routes/documents');
const scraperRoutes = require('./routes/scraper');
const settingsRoutes = require('./routes/settings');

const app = express();
const PORT = process.env.PORT || 3000;

// Validar configuración mínima (skip in Electron — defaults are set in electron/main.js)
if (!process.versions.electron && (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD)) {
  console.error('ERROR: ADMIN_USER y ADMIN_PASSWORD deben estar configurados en .env');
  process.exit(1);
}

if (!process.env.SESSION_SECRET) {
  console.warn('WARN: SESSION_SECRET no configurado. Generando uno temporal (se perderá al reiniciar).');
}

// Template engine (EJS con express-ejs-layouts manual)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Seguridad
app.use(generateNonce);
app.use(helmetMiddleware);
app.use(generalLimiter);
app.disable('x-powered-by');

// Body parsing
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

// Sesiones
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  name: 's30.sid',
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000, // 8 horas
  },
}));

// CSRF en todas las rutas
app.use(csrfProtection);

// Rutas públicas
app.use(authRoutes);

// Redirect raíz
app.get('/', requireAuth, (_req, res) => res.redirect('/analisis'));

// Rutas protegidas
app.use(requireAuth, documentRoutes);
app.use(requireAuth, scraperRoutes);
app.use(requireAuth, settingsRoutes);

// Error handler para multer
app.use((err, _req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).render('error', {
      title: 'Error',
      message: 'El archivo supera el tamaño máximo permitido (20MB).',
    });
  }
  if (err.message && err.message.includes('PDF')) {
    return res.status(400).render('error', {
      title: 'Error',
      message: err.message,
    });
  }
  next(err);
});

// 404
app.use((_req, res) => {
  res.status(404).render('error', { title: 'No encontrado', message: 'Página no encontrada.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Serrano30 escuchando en http://localhost:${PORT}`);
  });
}

module.exports = app;
