const path = require('path');
const fs = require('fs');
const db = require('../config/database');
const { extractTextFromPdf, analyzeWithGpt } = require('./analyzer');

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, '../../storage');
const UPLOADS_DIR = path.join(STORAGE_DIR, 'uploads');
const PROCESSED_DIR = path.join(STORAGE_DIR, 'processed');

// Estado del worker
const state = {
  running: false,
  currentDocId: null,
  processed: 0,
  errors: 0,
  total: 0,
  startedAt: null,
};

// Listeners de progreso (SSE)
const listeners = new Set();

function notifyListeners(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) {
    res.write(message);
  }
}

function addListener(res) {
  listeners.add(res);
  // Enviar estado actual inmediatamente
  res.write(`event: status\ndata: ${JSON.stringify(getStatus())}\n\n`);
}

function removeListener(res) {
  listeners.delete(res);
}

function getStatus() {
  return { ...state };
}

// Prepared statements
const getQueue = db.prepare(`
  SELECT id FROM documents WHERE status = 'queued' ORDER BY uploaded_at ASC
`);
const getDoc = db.prepare('SELECT * FROM documents WHERE id = ?');
const updateStatus = db.prepare(
  'UPDATE documents SET status = ?, analyzed_at = CASE WHEN ? = \'analyzed\' THEN CURRENT_TIMESTAMP ELSE analyzed_at END, error_message = ? WHERE id = ?'
);
const insertResult = db.prepare(`
  INSERT INTO analysis_results (document_id, finca_registral, registro_propiedad, idufir,
    referencia_catastral, metros_cuadrados, valor_tasacion, acreedor_hipoteca,
    principal_hipotecario, interes_ordinario, intereses_moratorios, tipo_dominio, raw_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

async function processDocument(doc) {
  const filePath = path.join(UPLOADS_DIR, doc.filename);

  if (!fs.existsSync(filePath)) {
    updateStatus.run('error', 'error', 'Archivo no encontrado en el servidor.', doc.id);
    return false;
  }

  const text = await extractTextFromPdf(filePath);

  if (!text || text.trim().length < 50) {
    updateStatus.run('error', 'error', 'PDF sin texto extraíble (puede ser imagen/escaneado).', doc.id);
    return false;
  }

  const data = await analyzeWithGpt(text, doc.original_name);

  insertResult.run(
    doc.id,
    data.finca_registral,
    data.registro_propiedad,
    data.idufir,
    data.referencia_catastral,
    data.metros_cuadrados ? Number(data.metros_cuadrados) : null,
    data.valor_tasacion ? Number(data.valor_tasacion) : null,
    data.acreedor_hipoteca,
    data.principal_hipotecario ? Number(data.principal_hipotecario) : null,
    data.interes_ordinario,
    data.intereses_moratorios,
    data.tipo_dominio,
    JSON.stringify(data)
  );

  updateStatus.run('analyzed', 'analyzed', null, doc.id);

  // Copiar a procesados
  const processedPath = path.join(PROCESSED_DIR, doc.filename);
  fs.copyFileSync(filePath, processedPath);

  return true;
}

async function processQueue() {
  if (state.running) return;

  const queue = getQueue.all();
  if (queue.length === 0) return;

  state.running = true;
  state.processed = 0;
  state.errors = 0;
  state.total = queue.length;
  state.startedAt = new Date().toISOString();

  notifyListeners('started', { total: state.total });

  for (const { id } of queue) {
    // Comprobar si se ha cancelado
    if (!state.running) break;

    const doc = getDoc.get(id);
    if (!doc || doc.status !== 'queued') continue;

    state.currentDocId = doc.id;
    notifyListeners('processing', {
      id: doc.id,
      name: doc.original_name,
      processed: state.processed,
      total: state.total,
    });

    try {
      const ok = await processDocument(doc);
      if (ok) {
        state.processed++;
      } else {
        state.errors++;
      }
    } catch (error) {
      updateStatus.run('error', 'error', error.message, doc.id);
      state.errors++;
    }

    notifyListeners('progress', {
      id: doc.id,
      name: doc.original_name,
      processed: state.processed,
      errors: state.errors,
      total: state.total,
    });

    // Ceder el event loop entre documentos para no bloquear el servidor
    await new Promise((resolve) => setImmediate(resolve));
  }

  state.running = false;
  state.currentDocId = null;

  notifyListeners('completed', {
    processed: state.processed,
    errors: state.errors,
    total: state.total,
  });
}

function enqueueDocuments(ids) {
  const markQueued = db.prepare("UPDATE documents SET status = 'queued' WHERE id = ? AND status IN ('pending', 'error')");
  let queued = 0;
  for (const id of ids) {
    const result = markQueued.run(id);
    queued += result.changes;
  }
  // Iniciar procesamiento en background
  if (queued > 0) {
    setImmediate(() => processQueue());
  }
  return queued;
}

function cancelProcessing() {
  state.running = false;
  // Revertir los queued que no se han procesado a pending
  db.prepare("UPDATE documents SET status = 'pending' WHERE status = 'queued'").run();
  notifyListeners('cancelled', { processed: state.processed, total: state.total });
}

module.exports = {
  enqueueDocuments,
  cancelProcessing,
  getStatus,
  addListener,
  removeListener,
};
