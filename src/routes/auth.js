const express = require('express');
const bcrypt = require('bcryptjs');
const { loginLimiter } = require('../middleware/security');

const router = express.Router();

const SALT_ROUNDS = 12;
let adminHash = null;

// Pre-hash del password al cargar el módulo
async function initAdminHash() {
  const password = process.env.ADMIN_PASSWORD;
  if (password) {
    adminHash = await bcrypt.hash(password, SALT_ROUNDS);
  }
}
initAdminHash();

router.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  const error = req.session.loginError;
  req.session.loginError = null;
  res.render('login', { title: 'Iniciar sesión', error });
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const adminUser = process.env.ADMIN_USER;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminUser || !adminPassword) {
    req.session.loginError = 'Credenciales de administrador no configuradas en el servidor.';
    return res.redirect('/login');
  }

  // Comparación en tiempo constante para el usuario
  const userMatch = username && username === adminUser;

  // bcrypt.compare ya es timing-safe
  if (!adminHash) {
    adminHash = await bcrypt.hash(adminPassword, SALT_ROUNDS);
  }
  const passMatch = password ? await bcrypt.compare(password, adminHash) : false;

  if (userMatch && passMatch) {
    // Regenerar sesión para prevenir session fixation
    req.session.regenerate((err) => {
      if (err) {
        req.session.loginError = 'Error interno del servidor.';
        return res.redirect('/login');
      }
      req.session.authenticated = true;
      req.session.user = username;
      res.redirect('/');
    });
  } else {
    req.session.loginError = 'Usuario o contraseña incorrectos.';
    res.redirect('/login');
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
