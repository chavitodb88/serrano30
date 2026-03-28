/**
 * Electron BrowserWindow-based scraper for sede.registradores.org
 * Replaces the Playwright-based download-worker.js
 */
const { BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'https://sede.registradores.org';
const LOGIN_URL = `${BASE_URL}/sede/sede-corpme-web/login`;
const HOME_URL = `${BASE_URL}/sede/sede-corpme-web/home`;
const NOTA_ONLINE_URL = `${BASE_URL}/sede/sede-corpme-web/registro-de-la-propiedad/publicidad/nota-online`;
const SOLICITAR_URL = `${BASE_URL}/site/certificado/propiedad/busqueda?nr=true#noback`;
const LISTADO_URL = `${BASE_URL}/site/certificado/usuario/solicitudes/listado`;

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(process.env.STORAGE_DIR || path.join(__dirname, '../storage'), 'descargas');
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '0', 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForLoad(win) {
  return new Promise((resolve) => {
    win.webContents.once('did-stop-loading', () => resolve());
  });
}

function waitForNavigation(win, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Navigation timeout')), timeout);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function executeJS(win, code) {
  return win.webContents.executeJavaScript(code);
}

async function waitForSelector(win, selector, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await executeJS(win, `!!document.querySelector('${selector}')`);
    if (found) return true;
    await sleep(500);
  }
  throw new Error(`Timeout waiting for selector: ${selector}`);
}

class ScraperWindow {
  constructor(emitFn) {
    this.emit = emitFn;
    this.win = null;
    this.stopRequested = false;
    this.downloaded = {};
    this.logFile = path.join(DOWNLOAD_DIR, '.downloaded.json');
  }

  async start() {
    if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

    // Load previous download log
    if (fs.existsSync(this.logFile)) {
      this.downloaded = JSON.parse(fs.readFileSync(this.logFile, 'utf8'));
    }

    this.emit('phase', { phase: 'launching', message: 'Abriendo navegador...' });

    // Create a scraper-specific session partition for persistent cookies
    const scraperSession = session.fromPartition('persist:scraper');

    // Handle downloads in this session
    scraperSession.on('will-download', (event, item) => {
      if (this._pendingDownloadPath) {
        item.setSavePath(this._pendingDownloadPath);
      }

      item.once('done', (e, state) => {
        if (state === 'completed') {
          this._downloadResolve && this._downloadResolve(item.getSavePath());
        } else {
          this._downloadResolve && this._downloadResolve(null);
        }
      });
    });

    this.win = new BrowserWindow({
      width: 1100,
      height: 800,
      show: true,
      title: 'Serrano30 - Descarga',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:scraper',
      },
    });

    // Prevent new windows from opening (links with target="_blank", window.open, etc.)
    // Instead, navigate the current window to the URL
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      console.log('[scraper] Blocked new window:', url);
      this.win.loadURL(url);
      return { action: 'deny' };
    });

    // Prevent the window from being closed by the page (window.close())
    this.win.on('close', (e) => {
      if (!this.stopRequested) {
        console.log('[scraper] Prevented window close');
        e.preventDefault();
      }
    });

    // Log navigations for debugging
    this.win.webContents.on('did-navigate', (e, url) => {
      console.log('[scraper] Navigated to:', url);
    });

    // Handle crashes
    this.win.webContents.on('render-process-gone', (e, details) => {
      console.log('[scraper] Renderer crashed:', details.reason);
      this.emit('error', { message: `El navegador se cerró inesperadamente: ${details.reason}` });
    });

    try {
      await this._run();
    } catch (error) {
      this.emit('error', { message: error.message });
    } finally {
      this.stopRequested = true; // Allow the close handler to let it through
      if (this.win && !this.win.isDestroyed()) {
        this.win.destroy();
      }
      this.win = null;
    }
  }

  stop() {
    this.stopRequested = true;
  }

  async _run() {
    const win = this.win;

    // --- 1. CHECK SESSION ---
    this.emit('phase', { phase: 'checking_session', message: 'Comprobando sesion...' });
    await win.loadURL(HOME_URL);
    await sleep(2000);

    // Accept cookies
    const hasCookieBtn = await executeJS(win, `
      (function() {
        const btn = document.querySelector('button');
        if (btn && btn.textContent.includes('Aceptar')) { btn.click(); return true; }
        return false;
      })()
    `);
    if (hasCookieBtn) await sleep(1000);

    const isLoggedIn = await executeJS(win, `
      (function() {
        const url = window.location.href;
        const hasUser = !!document.querySelector('[class*="user-name"]') ||
                        !!document.querySelector('.user-info, .user-data, [class*="usuario"]') ||
                        !!document.querySelector('a[href*="cerrar"], a[href*="logout"]');
        return url.includes('/home') && !url.includes('login') && hasUser;
      })()
    `);

    if (!isLoggedIn) {
      await win.loadURL(LOGIN_URL);
      await sleep(1000);

      // Accept cookies again if needed
      await executeJS(win, `
        (function() {
          const btn = document.querySelector('button');
          if (btn && btn.textContent.includes('Aceptar')) btn.click();
        })()
      `);
      await sleep(1000);

      // Show window so user can select certificate and log in
      win.show();
      this.emit('phase', { phase: 'waiting_login', message: 'Esperando login con certificado en el navegador...' });

      let loggedIn = false;
      for (let i = 0; i < 60; i++) {
        if (this.stopRequested) { this.emit('stopped', {}); return; }
        await sleep(5000);
        const url = win.webContents.getURL();
        if (url.includes('/home') && !url.includes('login')) {
          loggedIn = true;
          break;
        }
      }

      if (!loggedIn) {
        this.emit('error', { message: 'Timeout esperando login (5 min).' });
        return;
      }
      this.emit('phase', { phase: 'logged_in', message: 'Login completado.' });
    } else {
      this.emit('phase', { phase: 'logged_in', message: 'Sesion activa.' });
    }

    // --- 2. GO TO REQUEST LIST (Solicitudes realizadas) ---
    if (this.stopRequested) { this.emit('stopped', {}); return; }
    this.emit('phase', { phase: 'loading_list', message: 'Cargando listado de solicitudes...' });

    // Navigate to Mi carpeta first to establish the session context
    await win.loadURL(`${BASE_URL}/sede/sede-corpme-web/mi-carpeta`);
    await sleep(3000);

    // Now go to the actual list of requests
    await win.loadURL(LISTADO_URL);
    await sleep(3000);

    // If we landed on a page that requires certificate, try the alternative URL
    const currentUrl = win.webContents.getURL();
    if (!currentUrl.includes('listado')) {
      // Try navigating via "Solicitudes realizadas" link in the page
      const clickedSolicitudes = await executeJS(win, `
        (function() {
          const links = document.querySelectorAll('a');
          for (const el of links) {
            if (el.textContent.includes('Solicitudes realizadas')) {
              el.click();
              return true;
            }
          }
          return false;
        })()
      `).catch(() => false);

      if (clickedSolicitudes) {
        await sleep(3000);
        await waitForLoad(win);
      }
    }

    await waitForSelector(win, 'table').catch(() => {
      this.emit('error', { message: 'No se pudo acceder al listado de solicitudes. Puede requerirse certificado digital.' });
    });

    // --- 4. DOWNLOAD ANSWERED NOTES ---
    this.emit('phase', { phase: 'downloading', message: 'Iniciando descarga...' });

    let currentPage = 1;
    let totalDownloaded = 0;
    let totalSkipped = 0;
    let hasNextPage = true;

    while (hasNextPage) {
      if (this.stopRequested) break;

      const rowsData = await executeJS(win, `
        (function() {
          const rows = document.querySelectorAll('table tbody tr');
          return Array.from(rows).map(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 5) return null;
            const link = cells[0].querySelector('a');
            const estado = cells[4] ? cells[4].textContent.trim() : '';
            if (!link || !estado.includes('Respondida')) return null;
            return {
              refCode: link.textContent.trim().split('\\n')[0].trim(),
              href: link.getAttribute('href'),
            };
          }).filter(Boolean);
        })()
      `);

      for (const { refCode, href } of rowsData) {
        if (this.stopRequested) break;

        if (this.downloaded[refCode]) {
          totalSkipped++;
          continue;
        }

        this.emit('downloading', {
          ref: refCode,
          page: currentPage,
          downloaded: totalDownloaded,
          skipped: totalSkipped,
        });

        const detailUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        await win.loadURL(detailUrl);
        await sleep(2000);

        const downloadInfo = await executeJS(win, `
          (function() {
            const links = document.querySelectorAll('a, button');
            for (const el of links) {
              if (el.textContent.includes('Realizar consulta online') ||
                  el.textContent.includes('Realizar consulta')) {
                const url = el.getAttribute('data-url') || el.getAttribute('href');
                return { found: true, url: url };
              }
            }
            return { found: false };
          })()
        `);

        if (!downloadInfo.found) {
          await win.loadURL(`${LISTADO_URL}?order=desc&orderBy=id&pageSize=10&page=${currentPage}`);
          await waitForSelector(win, 'table');
          continue;
        }

        // Try to download the PDF
        const fileName = `${refCode}.pdf`;
        const filePath = path.join(DOWNLOAD_DIR, fileName);

        let downloadedFile = false;

        // Attempt via session download interception
        this._pendingDownloadPath = filePath;
        const downloadPromise = new Promise((resolve) => {
          this._downloadResolve = resolve;
          setTimeout(() => resolve(null), 30000);
        });

        await executeJS(win, `
          (function() {
            const links = document.querySelectorAll('a, button');
            for (const el of links) {
              if (el.textContent.includes('Realizar consulta online') ||
                  el.textContent.includes('Realizar consulta')) {
                el.click();
                return true;
              }
            }
            return false;
          })()
        `);

        const savedPath = await downloadPromise;
        this._pendingDownloadPath = null;
        this._downloadResolve = null;

        if (savedPath && fs.existsSync(savedPath)) {
          // Validate it's a real PDF
          const header = Buffer.alloc(4);
          const fd = fs.openSync(savedPath, 'r');
          fs.readSync(fd, header, 0, 4, 0);
          fs.closeSync(fd);

          if (header.toString('ascii') === '%PDF') {
            downloadedFile = true;
          } else {
            fs.unlinkSync(savedPath);
          }
        }

        // Fallback: fetch PDF via page context
        if (!downloadedFile && downloadInfo.url) {
          let pdfUrl = downloadInfo.url;
          if (!pdfUrl.startsWith('http')) {
            pdfUrl = pdfUrl.startsWith('/solicitud/')
              ? `${BASE_URL}/site${pdfUrl}`
              : `${BASE_URL}${pdfUrl}`;
          }

          const pdfBase64 = await executeJS(win, `
            (async function() {
              try {
                const res = await fetch('${pdfUrl}', { credentials: 'include' });
                const blob = await res.blob();
                return new Promise((resolve) => {
                  const reader = new FileReader();
                  reader.onloadend = () => resolve(reader.result.split(',')[1]);
                  reader.readAsDataURL(blob);
                });
              } catch(e) { return null; }
            })()
          `);

          if (pdfBase64) {
            const pdfBuffer = Buffer.from(pdfBase64, 'base64');
            fs.writeFileSync(filePath, pdfBuffer);
            downloadedFile = true;
          }
        }

        if (downloadedFile) {
          this.downloaded[refCode] = { date: new Date().toISOString(), file: fileName };
          fs.writeFileSync(this.logFile, JSON.stringify(this.downloaded, null, 2));
          totalDownloaded++;
          this.emit('downloaded', { ref: refCode, file: fileName, total: totalDownloaded });
        }

        // Go back to list
        await win.loadURL(
          `${LISTADO_URL}?order=desc&orderBy=id&pageSize=10&page=${currentPage}`
        );
        await waitForSelector(win, 'table');
      }

      // Next page
      const hasNext = await executeJS(win, `
        (function() {
          // Check for next page link by aria-label, text content, or class
          const byAria = document.querySelector('a[aria-label="Siguiente"]');
          if (byAria) return true;
          const byClass = document.querySelector('li.next a, li.next-page a, a.next');
          if (byClass) return true;
          // Check all links for "Siguiente" or "»" text
          const links = document.querySelectorAll('a');
          for (const a of links) {
            const text = a.textContent.trim();
            if (text === 'Siguiente' || text === '»' || text === '>' || text === '>>') return true;
          }
          return false;
        })()
      `).catch(() => false);

      if (hasNext && (MAX_PAGES === 0 || currentPage < MAX_PAGES)) {
        currentPage++;
        await win.loadURL(
          `${LISTADO_URL}?order=desc&orderBy=id&pageSize=10&page=${currentPage}`
        );
        await waitForSelector(win, 'table');
      } else {
        hasNextPage = false;
      }
    }

    if (this.stopRequested) {
      this.emit('stopped', { downloaded: totalDownloaded });
    } else {
      this.emit('completed', { downloaded: totalDownloaded, skipped: totalSkipped });
    }
  }
}

module.exports = ScraperWindow;
