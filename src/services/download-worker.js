/**
 * Download worker — Playwright scraper for sede.registradores.org
 * Runs as a child process (fork) or standalone CLI.
 * Communicates via IPC when forked, console.log when standalone.
 */
require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'https://sede.registradores.org';
const LOGIN_URL = `${BASE_URL}/sede/sede-corpme-web/login`;
const HOME_URL = `${BASE_URL}/sede/sede-corpme-web/home`;
const NOTA_ONLINE_URL = `${BASE_URL}/sede/sede-corpme-web/registro-de-la-propiedad/publicidad/nota-online`;
const SOLICITAR_URL = `${BASE_URL}/site/certificado/propiedad/busqueda?nr=true#noback`;
const LISTADO_URL = `${BASE_URL}/site/certificado/usuario/solicitudes/listado`;

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, '../../descargas');
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '0', 10);
const CHROME_PROFILE = path.join(__dirname, '../../storage/chrome-profile');

// IPC or console output
const isForked = typeof process.send === 'function';
function emit(event, data = {}) {
  if (isForked) {
    process.send({ event, data });
  } else {
    console.log(`[${event}]`, JSON.stringify(data));
  }
}

// Listen for stop command from parent
let stopRequested = false;
if (isForked) {
  process.on('message', (msg) => {
    if (msg === 'stop') {
      stopRequested = true;
    }
  });
}

async function main() {
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  if (!fs.existsSync(CHROME_PROFILE)) fs.mkdirSync(CHROME_PROFILE, { recursive: true });

  const logFile = path.join(DOWNLOAD_DIR, '.downloaded.json');
  let downloaded = {};
  if (fs.existsSync(logFile)) {
    downloaded = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  }

  emit('phase', { phase: 'launching', message: 'Abriendo navegador...' });

  const context = await chromium.launchPersistentContext(CHROME_PROFILE, {
    channel: 'chrome',
    headless: false,
    acceptDownloads: true,
    locale: 'es-ES',
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    // --- 1. CHECK SESSION ---
    emit('phase', { phase: 'checking_session', message: 'Comprobando sesión...' });
    await page.goto(HOME_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Accept cookies
    const cookieBtn = await page.$('button:has-text("Aceptar")');
    if (cookieBtn) {
      await cookieBtn.click();
      await page.waitForTimeout(1000);
    }

    const userEl = await page.$('text=J.CANO, text=CANO, [class*="user-name"]');
    const isHome = page.url().includes('/home') && !page.url().includes('login');

    if (!isHome || !userEl) {
      await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });

      const cookieBtn2 = await page.$('button:has-text("Aceptar")');
      if (cookieBtn2) { await cookieBtn2.click(); await page.waitForTimeout(1000); }

      emit('phase', { phase: 'waiting_login', message: 'Esperando login con certificado en el navegador...' });

      let loggedIn = false;
      for (let i = 0; i < 60; i++) {
        if (stopRequested) { emit('stopped', {}); return; }
        await page.waitForTimeout(5000);
        const url = page.url();
        if (url.includes('/home') && !url.includes('login')) {
          loggedIn = true;
          break;
        }
      }
      if (!loggedIn) {
        emit('error', { message: 'Timeout esperando login (5 min).' });
        return;
      }
      emit('phase', { phase: 'logged_in', message: 'Login completado.' });
    } else {
      emit('phase', { phase: 'logged_in', message: 'Sesión activa.' });
    }

    // --- 2. ESTABLISH SSO ---
    if (stopRequested) { emit('stopped', {}); return; }
    emit('phase', { phase: 'establishing_sso', message: 'Estableciendo sesión SSO...' });

    await page.goto(NOTA_ONLINE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const solicitarLink = await page.$('a:has-text("Solicitar nota online"), a:has-text("Solicitar Nota"), button:has-text("Solicitar")');
    if (solicitarLink) {
      await Promise.all([
        page.waitForNavigation({ timeout: 30000 }).catch(() => {}),
        solicitarLink.click(),
      ]);
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);
    } else {
      await page.goto(SOLICITAR_URL, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    // --- 3. GO TO REQUEST LIST ---
    if (stopRequested) { emit('stopped', {}); return; }
    emit('phase', { phase: 'loading_list', message: 'Cargando listado de solicitudes...' });

    await page.goto(LISTADO_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    await page.waitForSelector('table', { timeout: 15000 });

    // --- 4. DOWNLOAD ANSWERED NOTES ---
    emit('phase', { phase: 'downloading', message: 'Iniciando descarga...' });

    let currentPage = 1;
    let totalDownloaded = 0;
    let totalSkipped = 0;
    let hasNextPage = true;

    while (hasNextPage) {
      if (stopRequested) break;

      const rowsData = await page.$$eval('table tbody tr', (rows) => {
        return rows.map(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length < 5) return null;
          const link = cells[0].querySelector('a');
          const estado = cells[4] ? cells[4].textContent.trim() : '';
          if (!link || !estado.includes('Respondida')) return null;
          return {
            refCode: link.textContent.trim().split('\n')[0].trim(),
            href: link.getAttribute('href'),
          };
        }).filter(Boolean);
      });

      for (const { refCode, href } of rowsData) {
        if (stopRequested) break;

        if (downloaded[refCode]) {
          totalSkipped++;
          continue;
        }

        emit('downloading', {
          ref: refCode,
          page: currentPage,
          downloaded: totalDownloaded,
          skipped: totalSkipped,
        });

        const detailUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 });

        const downloadBtn = await page.$('a:has-text("Realizar consulta online"), button:has-text("Realizar consulta")');
        if (!downloadBtn) {
          await page.goto(`${LISTADO_URL}?order=desc&orderBy=id&pageSize=10&page=${currentPage}`, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForSelector('table', { timeout: 15000 });
          continue;
        }

        const pdfPath = await downloadBtn.getAttribute('data-url') || await downloadBtn.getAttribute('href');

        if (!pdfPath) {
          await page.goto(`${LISTADO_URL}?order=desc&orderBy=id&pageSize=10&page=${currentPage}`, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForSelector('table', { timeout: 15000 });
          continue;
        }

        let pdfUrl;
        if (pdfPath.startsWith('http')) {
          pdfUrl = pdfPath;
        } else if (pdfPath.startsWith('/solicitud/')) {
          pdfUrl = `${BASE_URL}/site${pdfPath}`;
        } else {
          pdfUrl = `${BASE_URL}${pdfPath}`;
        }

        const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
        await downloadBtn.click();
        const download = await downloadPromise;

        if (download) {
          const fileName = `${refCode}.pdf`;
          const filePath = path.join(DOWNLOAD_DIR, fileName);
          await download.saveAs(filePath);

          const header = Buffer.alloc(4);
          const fd = fs.openSync(filePath, 'r');
          fs.readSync(fd, header, 0, 4, 0);
          fs.closeSync(fd);

          if (header.toString('ascii') === '%PDF') {
            downloaded[refCode] = { date: new Date().toISOString(), file: fileName };
            fs.writeFileSync(logFile, JSON.stringify(downloaded, null, 2));
            totalDownloaded++;
            emit('downloaded', { ref: refCode, file: fileName, total: totalDownloaded });
          } else {
            fs.unlinkSync(filePath);
          }
        } else {
          await page.waitForLoadState('networkidle', { timeout: 30000 });

          const pdfBase64 = await page.evaluate(async (url) => {
            const res = await fetch(url, { credentials: 'include' });
            const blob = await res.blob();
            return new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result.split(',')[1]);
              reader.readAsDataURL(blob);
            });
          }, pdfUrl);

          if (pdfBase64) {
            const pdfBuffer = Buffer.from(pdfBase64, 'base64');
            const fileName = `${refCode}.pdf`;
            fs.writeFileSync(path.join(DOWNLOAD_DIR, fileName), pdfBuffer);
            downloaded[refCode] = { date: new Date().toISOString(), file: fileName };
            fs.writeFileSync(logFile, JSON.stringify(downloaded, null, 2));
            totalDownloaded++;
            emit('downloaded', { ref: refCode, file: fileName, total: totalDownloaded });
          }
        }

        await page.goto(
          `${LISTADO_URL}?order=desc&orderBy=id&pageSize=10&page=${currentPage}`,
          { waitUntil: 'networkidle', timeout: 30000 }
        );
        await page.waitForSelector('table', { timeout: 15000 });
      }

      // Next page
      const nextPageBtn = await page.$('a[aria-label="Siguiente"], a:has-text("»"), a:has-text("Siguiente"), li.next a');
      if (nextPageBtn && (MAX_PAGES === 0 || currentPage < MAX_PAGES)) {
        currentPage++;
        await page.goto(
          `${LISTADO_URL}?order=desc&orderBy=id&pageSize=10&page=${currentPage}`,
          { waitUntil: 'networkidle', timeout: 30000 }
        );
        await page.waitForSelector('table', { timeout: 15000 });
      } else {
        hasNextPage = false;
      }
    }

    if (stopRequested) {
      emit('stopped', { downloaded: totalDownloaded });
    } else {
      emit('completed', { downloaded: totalDownloaded, skipped: totalSkipped });
    }

  } catch (error) {
    emit('error', { message: error.message });
    await page.screenshot({ path: path.join(DOWNLOAD_DIR, 'error-screenshot.png'), fullPage: true }).catch(() => {});
  } finally {
    // Close browser when done (or stopped)
    await context.close().catch(() => {});
  }
}

main();
