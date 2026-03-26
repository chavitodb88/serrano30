const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

// Helmet con CSP configurado para Bootstrap CDN
// Generar nonce por request para scripts inline seguros
function generateNonce(_req, res, next) {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
}

const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net', (_req, res) => `'nonce-${res.locals.cspNonce}'`],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      fontSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      imgSrc: ["'self'", 'data:'],
    },
  },
});

// Rate limiter para login: 5 intentos por ventana de 15 min
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Demasiados intentos de login. Inténtalo de nuevo en 15 minutos.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter general
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// CSRF protection (synchronizer token pattern)
function csrfProtection(req, res, next) {
  // Generar token si no existe en la sesión
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  // Validar en métodos de escritura (skip multipart — lo valida multer post-parse)
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      // En multipart, req.body aún no está parseado. Se valida después de multer.
      return next();
    }

    const token = req.body._csrf || req.headers['x-csrf-token'];
    const sessionToken = req.session.csrfToken;

    if (!token || !sessionToken || token.length !== sessionToken.length) {
      return res.redirect('back');
    }

    if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(sessionToken))) {
      return res.redirect('back');
    }
  }
  next();
}

module.exports = { generateNonce, helmetMiddleware, loginLimiter, generalLimiter, csrfProtection };
