const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

// Resolve userData paths before anything else
const userDataPath = app.getPath('userData');
const storagePath = path.join(userDataPath, 'storage');

// Set environment for the Express app
process.env.STORAGE_DIR = storagePath;
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

// Copy .env template on first run
const envPath = path.join(userDataPath, '.env');
if (!fs.existsSync(envPath)) {
  const templatePath = path.join(__dirname, '..', '.env.example');
  if (fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, envPath);
  } else {
    // Create minimal .env
    fs.writeFileSync(envPath, [
      'ADMIN_USER=admin',
      'ADMIN_PASSWORD=admin',
      `SESSION_SECRET=${require('crypto').randomBytes(32).toString('hex')}`,
      'OPENAI_API_KEY=',
      '',
    ].join('\n'));
  }
}

// Load .env from userData
require('dotenv').config({ path: envPath, override: true });

// Ensure required vars have defaults for desktop
if (!process.env.ADMIN_USER) process.env.ADMIN_USER = 'admin';
if (!process.env.ADMIN_PASSWORD) process.env.ADMIN_PASSWORD = 'admin';
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = require('crypto').randomBytes(32).toString('hex');
}

let mainWindow = null;
let expressServer = null;
let serverPort = null;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function startExpressServer() {
  const expressApp = require('../src/app');
  const port = await findFreePort();

  return new Promise((resolve) => {
    expressServer = expressApp.listen(port, '127.0.0.1', () => {
      console.log(`Express server on http://127.0.0.1:${port}`);
      resolve(port);
    });
  });
}

function createMainWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Serrano30',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/login`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Handle client certificate requests (for sede.registradores.org)
app.on('select-client-certificate', (event, webContents, url, certificates, callback) => {
  event.preventDefault();
  if (certificates.length === 1) {
    callback(certificates[0]);
  } else if (certificates.length > 0) {
    // Let the OS show the certificate picker
    callback(certificates[0]);
  } else {
    callback();
  }
});

// Allow self-signed or local certificates for 127.0.0.1
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (url.startsWith('http://127.0.0.1')) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

app.whenReady().then(async () => {
  try {
    serverPort = await startExpressServer();
    createMainWindow(serverPort);
  } catch (err) {
    console.error('Failed to start:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (expressServer) expressServer.close();
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null && serverPort) {
    createMainWindow(serverPort);
  }
});

// Export for scraper-adapter to use
module.exports = { getMainWindow: () => mainWindow, getServerPort: () => serverPort };
