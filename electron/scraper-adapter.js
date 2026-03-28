/**
 * Scraper adapter for Electron — same API as src/services/scraper.js
 * Uses BrowserWindow instead of child_process fork.
 */
const ScraperWindow = require('./scraper-window');

const state = {
  running: false,
  phase: null,
  message: '',
  currentRef: null,
  downloaded: 0,
  startedAt: null,
};

let scraperInstance = null;
const listeners = new Set();

function notifyListeners(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) {
    res.write(message);
  }
}

function addListener(res) {
  listeners.add(res);
  res.write(`event: status\ndata: ${JSON.stringify(getStatus())}\n\n`);
}

function removeListener(res) {
  listeners.delete(res);
}

function getStatus() {
  return { ...state };
}

function emit(event, data) {
  switch (event) {
    case 'phase':
      state.phase = data.phase;
      state.message = data.message;
      notifyListeners('phase', data);
      break;
    case 'downloading':
      state.currentRef = data.ref;
      state.message = `Descargando ${data.ref}...`;
      notifyListeners('downloading', data);
      break;
    case 'downloaded':
      state.downloaded = data.total;
      state.currentRef = data.ref;
      state.message = `Descargado: ${data.ref}`;
      notifyListeners('downloaded', data);
      // Save metadata to DB
      try {
        const db = require('../src/config/database');
        const upsert = db.prepare(`
          INSERT INTO scraper_downloads (codigo, referencia, registro, solicitante, fecha_creacion, fecha_respuesta, importe, filename)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(codigo) DO UPDATE SET
            referencia=excluded.referencia, registro=excluded.registro, solicitante=excluded.solicitante,
            fecha_creacion=excluded.fecha_creacion, fecha_respuesta=excluded.fecha_respuesta,
            importe=excluded.importe, filename=excluded.filename, downloaded_at=CURRENT_TIMESTAMP
        `);
        upsert.run(data.ref, data.referencia || null, data.registro || null, data.solicitante || null,
          data.fechaCreacion || null, data.fechaRespuesta || null, data.importe || null, data.file || null);
      } catch (e) {
        console.error('[scraper-adapter] Error saving metadata:', e.message);
      }
      break;
    case 'completed':
      state.running = false;
      state.phase = 'completed';
      state.message = `Completado: ${data.downloaded} nota(s) descargada(s)`;
      state.currentRef = null;
      scraperInstance = null;
      notifyListeners('completed', data);
      break;
    case 'stopped':
      state.running = false;
      state.phase = 'stopped';
      state.message = 'Detenido por el usuario';
      state.currentRef = null;
      scraperInstance = null;
      notifyListeners('stopped', data);
      break;
    case 'error':
      state.running = false;
      state.phase = 'error';
      state.message = data.message;
      state.currentRef = null;
      scraperInstance = null;
      notifyListeners('error', data);
      break;
  }
}

function startScraper(filters = {}) {
  if (state.running) return false;

  state.running = true;
  state.phase = 'launching';
  state.message = 'Iniciando...';
  state.currentRef = null;
  state.downloaded = 0;
  state.startedAt = new Date().toISOString();

  notifyListeners('started', getStatus());

  scraperInstance = new ScraperWindow(emit, filters);
  scraperInstance.start();

  return true;
}

function stopScraper() {
  if (!state.running || !scraperInstance) return false;
  scraperInstance.stop();
  return true;
}

module.exports = {
  startScraper,
  stopScraper,
  getStatus,
  addListener,
  removeListener,
};
