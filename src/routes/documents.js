const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { generateExcel } = require('../services/excel');
const worker = require('../services/worker');

const router = express.Router();

// Validar CSRF post-multer (para multipart forms)
function validateCsrf(req) {
  const token = req.body._csrf;
  const sessionToken = req.session.csrfToken;
  if (!token || !sessionToken || token.length !== sessionToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(sessionToken));
}

const STORAGE_DIR = path.join(__dirname, '../../storage');
const UPLOADS_DIR = path.join(STORAGE_DIR, 'uploads');
const PROCESSED_DIR = path.join(STORAGE_DIR, 'processed');
const EXPORTS_DIR = path.join(STORAGE_DIR, 'exports');

// Configuración de Multer
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, _file, cb) => {
    cb(null, `${uuidv4()}.pdf`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Solo se permiten archivos PDF.'));
    }
    cb(null, true);
  },
});

// Validar magic bytes del PDF (%PDF)
function isPdfFile(filePath) {
  const buffer = Buffer.alloc(4);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buffer, 0, 4, 0);
  fs.closeSync(fd);
  return buffer.toString('ascii') === '%PDF';
}

// --- DASHBOARD ---
router.get('/', (req, res) => {
  const documents = db.prepare(`
    SELECT d.*, ar.id as result_id
    FROM documents d
    LEFT JOIN analysis_results ar ON ar.document_id = d.id
    ORDER BY d.uploaded_at DESC
  `).all();

  const exports = db.prepare(`
    SELECT * FROM exports ORDER BY created_at DESC LIMIT 10
  `).all();

  const stats = {
    total: documents.length,
    pending: documents.filter((d) => d.status === 'pending').length,
    queued: documents.filter((d) => d.status === 'queued').length,
    analyzed: documents.filter((d) => d.status === 'analyzed').length,
    error: documents.filter((d) => d.status === 'error').length,
  };

  const flash = req.session.flash;
  req.session.flash = null;

  const workerStatus = worker.getStatus();

  res.render('dashboard', { title: 'Dashboard', documents, exports, stats, flash, workerStatus });
});

// --- SUBIR PDFs ---
router.post('/upload', upload.array('pdfs', 50), (req, res) => {
  if (!validateCsrf(req)) {
    (req.files || []).forEach((f) => fs.existsSync(f.path) && fs.unlinkSync(f.path));
    return res.redirect('/');
  }

  if (!req.files || req.files.length === 0) {
    req.session.flash = { type: 'danger', message: 'No se seleccionaron archivos.' };
    return res.redirect('/');
  }

  const insert = db.prepare(`
    INSERT INTO documents (filename, original_name, size) VALUES (?, ?, ?)
  `);

  let uploaded = 0;
  let rejected = 0;

  for (const file of req.files) {
    if (!isPdfFile(file.path)) {
      fs.unlinkSync(file.path);
      rejected++;
      continue;
    }
    insert.run(file.filename, file.originalname, file.size);
    uploaded++;
  }

  let message = `${uploaded} archivo(s) subido(s) correctamente.`;
  if (rejected > 0) message += ` ${rejected} rechazado(s) por no ser PDF válido.`;

  req.session.flash = { type: uploaded > 0 ? 'success' : 'danger', message };
  res.redirect('/');
});

// --- ANALIZAR DOCUMENTOS (background) ---
router.post('/analyze', (req, res) => {
  const ids = req.body.documentIds;
  if (!ids || ids.length === 0) {
    req.session.flash = { type: 'warning', message: 'No se seleccionaron documentos para analizar.' };
    return res.redirect('/');
  }

  const idList = Array.isArray(ids) ? ids.map(Number) : [Number(ids)];
  const queued = worker.enqueueDocuments(idList);

  req.session.flash = {
    type: 'info',
    message: `${queued} documento(s) en cola de análisis. El progreso se muestra en tiempo real.`,
  };
  res.redirect('/');
});

// --- CANCELAR ANÁLISIS ---
router.post('/analyze/cancel', (req, res) => {
  worker.cancelProcessing();
  req.session.flash = { type: 'warning', message: 'Análisis cancelado.' };
  res.redirect('/');
});

// --- SSE: PROGRESO EN TIEMPO REAL ---
router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx
  res.flushHeaders();

  worker.addListener(res);

  req.on('close', () => {
    worker.removeListener(res);
  });
});

// --- ESTADO DEL WORKER (JSON) ---
router.get('/analyze/status', (req, res) => {
  res.json(worker.getStatus());
});

// --- EXPORTAR EXCEL ---
router.post('/export', (req, res) => {
  const results = db.prepare(`
    SELECT ar.*, d.original_name
    FROM analysis_results ar
    JOIN documents d ON d.id = ar.document_id
    ORDER BY ar.created_at DESC
  `).all();

  if (results.length === 0) {
    req.session.flash = { type: 'warning', message: 'No hay resultados de análisis para exportar.' };
    return res.redirect('/');
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `notas-simples_${timestamp}.xlsx`;
  const outputPath = path.join(EXPORTS_DIR, filename);

  generateExcel(results, outputPath)
    .then(() => {
      db.prepare('INSERT INTO exports (filename, document_count) VALUES (?, ?)').run(filename, results.length);
      res.download(outputPath, filename);
    })
    .catch((error) => {
      req.session.flash = { type: 'danger', message: `Error al generar Excel: ${error.message}` };
      res.redirect('/');
    });
});

// --- DESCARGAR EXCEL PREVIO ---
router.get('/export/:id', (req, res) => {
  const exp = db.prepare('SELECT * FROM exports WHERE id = ?').get(req.params.id);
  if (!exp) return res.status(404).send('Exportación no encontrada.');

  const filePath = path.join(EXPORTS_DIR, exp.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Archivo no encontrado.');

  res.download(filePath, exp.filename);
});

// --- VER PDF ORIGINAL ---
router.get('/document/:id/view', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).send('Documento no encontrado.');

  let filePath = path.join(UPLOADS_DIR, doc.filename);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(PROCESSED_DIR, doc.filename);
  }
  if (!fs.existsSync(filePath)) return res.status(404).send('Archivo no encontrado.');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${doc.original_name}"`);
  fs.createReadStream(filePath).pipe(res);
});

// --- ELIMINAR DOCUMENTO ---
router.post('/document/:id/delete', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) {
    req.session.flash = { type: 'danger', message: 'Documento no encontrado.' };
    return res.redirect('/');
  }

  [path.join(UPLOADS_DIR, doc.filename), path.join(PROCESSED_DIR, doc.filename)].forEach((p) => {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });

  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);

  req.session.flash = { type: 'success', message: `"${doc.original_name}" eliminado.` };
  res.redirect('/');
});

module.exports = router;
