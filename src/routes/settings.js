const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

function getEnvPath() {
  if (process.versions.electron) {
    try {
      const { app } = require('electron');
      return path.join(app.getPath('userData'), '.env');
    } catch (e) {
      // Fallback if electron module not accessible from renderer
    }
  }
  return path.join(__dirname, '../../.env');
}

function readEnvFile() {
  const envPath = getEnvPath();
  const vars = {};
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx).trim();
        const val = trimmed.substring(eqIdx + 1).trim();
        vars[key] = val;
      }
    }
  }
  return vars;
}

function writeEnvFile(vars) {
  const envPath = getEnvPath();
  const lines = [];
  for (const [key, val] of Object.entries(vars)) {
    lines.push(`${key}=${val}`);
  }
  fs.writeFileSync(envPath, lines.join('\n') + '\n');
}

router.get('/settings', (req, res) => {
  const vars = readEnvFile();
  const flash = req.session.flash;
  req.session.flash = null;

  res.render('settings', {
    title: 'Configuracion',
    activeTab: 'settings',
    flash,
    settings: {
      openaiKey: vars.OPENAI_API_KEY || '',
      adminUser: vars.ADMIN_USER || 'admin',
    },
  });
});

router.post('/settings', (req, res) => {
  const vars = readEnvFile();

  if (req.body.openai_key !== undefined) {
    vars.OPENAI_API_KEY = req.body.openai_key.trim();
    process.env.OPENAI_API_KEY = vars.OPENAI_API_KEY;
  }

  if (req.body.admin_user) {
    vars.ADMIN_USER = req.body.admin_user.trim();
    process.env.ADMIN_USER = vars.ADMIN_USER;
  }

  if (req.body.admin_password) {
    vars.ADMIN_PASSWORD = req.body.admin_password;
    process.env.ADMIN_PASSWORD = req.body.admin_password;
  }

  writeEnvFile(vars);

  req.session.flash = { type: 'success', message: 'Configuracion guardada. Algunos cambios requieren reiniciar la app.' };
  res.redirect('/settings');
});

module.exports = router;
