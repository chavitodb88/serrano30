/**
 * Scraper orchestrator — manages the Playwright child process
 * Same SSE pattern as worker.js
 */
const { fork } = require('child_process');
const path = require('path');

const WORKER_PATH = path.join(__dirname, 'download-worker.js');

// State
const state = {
  running: false,
  phase: null,
  message: '',
  currentRef: null,
  downloaded: 0,
  startedAt: null,
};

let childProcess = null;

// SSE listeners
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

function startScraper() {
  if (state.running) return false;

  state.running = true;
  state.phase = 'launching';
  state.message = 'Iniciando...';
  state.currentRef = null;
  state.downloaded = 0;
  state.startedAt = new Date().toISOString();

  notifyListeners('started', getStatus());

  childProcess = fork(WORKER_PATH, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  childProcess.on('message', (msg) => {
    const { event, data } = msg;

    switch (event) {
      case 'phase':
        state.phase = data.phase;
        state.message = data.message;
        notifyListeners('phase', { phase: data.phase, message: data.message });
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
        break;

      case 'completed':
        state.running = false;
        state.phase = 'completed';
        state.message = `Completado: ${data.downloaded} nota(s) descargada(s)`;
        state.currentRef = null;
        childProcess = null;
        notifyListeners('completed', data);
        break;

      case 'stopped':
        state.running = false;
        state.phase = 'stopped';
        state.message = 'Detenido por el usuario';
        state.currentRef = null;
        childProcess = null;
        notifyListeners('stopped', data);
        break;

      case 'error':
        state.running = false;
        state.phase = 'error';
        state.message = data.message;
        state.currentRef = null;
        childProcess = null;
        notifyListeners('error', data);
        break;
    }
  });

  childProcess.on('exit', (code) => {
    if (state.running) {
      // Unexpected exit
      state.running = false;
      state.phase = 'error';
      state.message = `Proceso terminado inesperadamente (código ${code})`;
      childProcess = null;
      notifyListeners('error', { message: state.message });
    }
  });

  return true;
}

function stopScraper() {
  if (!state.running || !childProcess) return false;

  childProcess.send('stop');

  // Force kill after 10 seconds if it doesn't stop gracefully
  const killTimeout = setTimeout(() => {
    if (childProcess) {
      childProcess.kill('SIGTERM');
      state.running = false;
      state.phase = 'stopped';
      state.message = 'Detenido (forzado)';
      childProcess = null;
      notifyListeners('stopped', { downloaded: state.downloaded });
    }
  }, 10000);

  childProcess.on('exit', () => clearTimeout(killTimeout));

  return true;
}

module.exports = {
  startScraper,
  stopScraper,
  getStatus,
  addListener,
  removeListener,
};
