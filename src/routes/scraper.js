const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const scraper = process.versions.electron
  ? require('../../electron/scraper-adapter')
  : require('../services/scraper');

const router = express.Router();

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || (process.versions.electron
  ? path.join(process.env.STORAGE_DIR || path.join(__dirname, '../../storage'), 'descargas')
  : path.join(__dirname, '../../descargas'));
const UPLOADS_DIR = path.join(process.env.STORAGE_DIR || path.join(__dirname, '../../storage'), 'uploads');

// Validate PDF magic bytes
function isPdfFile(filePath) {
  const buffer = Buffer.alloc(4);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buffer, 0, 4, 0);
  fs.closeSync(fd);
  return buffer.toString('ascii') === '%PDF';
}

// --- DESCARGA DASHBOARD ---
router.get('/descarga', (req, res) => {
  // List downloaded files from descargas/
  let files = [];
  if (fs.existsSync(DOWNLOAD_DIR)) {
    files = fs.readdirSync(DOWNLOAD_DIR)
      .filter(f => f.endsWith('.pdf'))
      .map(f => {
        const filePath = path.join(DOWNLOAD_DIR, f);
        const stat = fs.statSync(filePath);
        return {
          name: f,
          size: stat.size,
          date: stat.mtime,
        };
      })
      .sort((a, b) => b.date - a.date);
  }

  const flash = req.session.flash;
  req.session.flash = null;

  const scraperStatus = scraper.getStatus();

  res.render('descarga', {
    title: 'Descarga',
    activeTab: 'descarga',
    files,
    flash,
    scraperStatus,
  });
});

// --- START SCRAPER ---
router.post('/descarga/start', (req, res) => {
  const started = scraper.startScraper();
  req.session.flash = started
    ? { type: 'info', message: 'Scraper iniciado. Se abrirá una ventana de Chrome.' }
    : { type: 'warning', message: 'El scraper ya está en ejecución.' };
  res.redirect('/descarga');
});

// --- STOP SCRAPER ---
router.post('/descarga/stop', (req, res) => {
  scraper.stopScraper();
  req.session.flash = { type: 'warning', message: 'Deteniendo scraper...' };
  res.redirect('/descarga');
});

// --- SSE: SCRAPER PROGRESS ---
router.get('/descarga/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  scraper.addListener(res);

  req.on('close', () => {
    scraper.removeListener(res);
  });
});

// --- SCRAPER STATUS (JSON) ---
router.get('/descarga/status', (req, res) => {
  res.json(scraper.getStatus());
});

// --- IMPORT DOWNLOADED PDFs TO ANALYSIS ---
router.post('/descarga/import', (req, res) => {
  const fileNames = req.body.files;
  if (!fileNames || fileNames.length === 0) {
    req.session.flash = { type: 'warning', message: 'No se seleccionaron archivos para importar.' };
    return res.redirect('/descarga');
  }

  const names = Array.isArray(fileNames) ? fileNames : [fileNames];
  const insert = db.prepare('INSERT INTO documents (filename, original_name, size) VALUES (?, ?, ?)');

  let imported = 0;
  let skipped = 0;

  for (const name of names) {
    const sourcePath = path.join(DOWNLOAD_DIR, name);

    if (!fs.existsSync(sourcePath) || !isPdfFile(sourcePath)) {
      skipped++;
      continue;
    }

    const stat = fs.statSync(sourcePath);
    const newFilename = `${uuidv4()}.pdf`;
    const destPath = path.join(UPLOADS_DIR, newFilename);

    fs.copyFileSync(sourcePath, destPath);
    insert.run(newFilename, name, stat.size);
    imported++;
  }

  let message = `${imported} archivo(s) importado(s) a Análisis.`;
  if (skipped > 0) message += ` ${skipped} omitido(s).`;
  if (imported > 0) message += ' Ve a la pestaña Análisis para procesarlos.';

  req.session.flash = { type: imported > 0 ? 'success' : 'warning', message };
  res.redirect('/descarga');
});

module.exports = router;
