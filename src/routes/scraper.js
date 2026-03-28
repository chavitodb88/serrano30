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
  // Collect PDFs recursively (may be in referencia subfolders)
  let files = [];
  function scanDir(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scanDir(path.join(dir, entry.name), entry.name);
      } else if (entry.name.endsWith('.pdf')) {
        const filePath = path.join(dir, entry.name);
        const stat = fs.statSync(filePath);
        const codigo = entry.name.replace('.pdf', '');
        files.push({
          name: entry.name,
          relativePath: prefix ? `${prefix}/${entry.name}` : entry.name,
          codigo,
          folder: prefix || null,
          size: stat.size,
          date: stat.mtime,
        });
      }
    }
  }
  scanDir(DOWNLOAD_DIR, '');

  // Enrich with metadata from DB
  const metaStmt = db.prepare('SELECT * FROM scraper_downloads WHERE codigo = ?');
  for (const file of files) {
    const meta = metaStmt.get(file.codigo);
    if (meta) {
      file.referencia = meta.referencia || '';
      file.registro = meta.registro || '';
      file.solicitante = meta.solicitante || '';
      file.fechaCreacion = meta.fecha_creacion || '';
      file.importe = meta.importe || '';
    }
  }

  files.sort((a, b) => b.date - a.date);

  // Filter support
  const filterRef = req.query.ref || '';
  const filterReg = req.query.reg || '';
  if (filterRef) files = files.filter(f => (f.referencia || '').toLowerCase().includes(filterRef.toLowerCase()));
  if (filterReg) files = files.filter(f => (f.registro || '').toLowerCase().includes(filterReg.toLowerCase()));

  const flash = req.session.flash;
  req.session.flash = null;

  const scraperStatus = scraper.getStatus();

  res.render('descarga', {
    title: 'Descarga',
    activeTab: 'descarga',
    files,
    flash,
    scraperStatus,
    filterRef,
    filterReg,
  });
});

// --- START SCRAPER ---
router.post('/descarga/start', (req, res) => {
  const filters = {
    referencia: req.body.referencia || '',
    tipoSolicitud: req.body.tipo_solicitud || '',
    usuario: req.body.usuario || '',
    fechaDesde: req.body.fecha_desde || '',
    fechaHasta: req.body.fecha_hasta || '',
  };
  const started = scraper.startScraper(filters);
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
    // name can be "file.pdf" or "subfolder/file.pdf"
    const sourcePath = path.join(DOWNLOAD_DIR, ...name.split('/'));

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

// --- CLEAR ALL DOWNLOADED FILES ---
router.post('/descarga/clear', (req, res) => {
  if (fs.existsSync(DOWNLOAD_DIR)) {
    const entries = fs.readdirSync(DOWNLOAD_DIR, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(DOWNLOAD_DIR, entry.name);
      if (entry.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else if (entry.name !== '.downloaded.json') {
        fs.unlinkSync(fullPath);
      }
    }
  }
  // Clear download log so scraper re-downloads
  const logFile = path.join(DOWNLOAD_DIR, '.downloaded.json');
  if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
  // Clear scraper_downloads table
  db.prepare('DELETE FROM scraper_downloads').run();

  req.session.flash = { type: 'success', message: 'Todos los archivos descargados han sido borrados.' };
  res.redirect('/descarga');
});

module.exports = router;
