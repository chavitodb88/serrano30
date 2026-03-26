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

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || './descargas';
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '0', 10);
const CHROME_PROFILE = path.join(__dirname, '../../storage/chrome-profile');

function msg(text) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${text}`);
  console.log(`${'═'.repeat(60)}\n`);
}

async function main() {
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  if (!fs.existsSync(CHROME_PROFILE)) fs.mkdirSync(CHROME_PROFILE, { recursive: true });

  const logFile = path.join(DOWNLOAD_DIR, '.downloaded.json');
  let downloaded = {};
  if (fs.existsSync(logFile)) {
    downloaded = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  }

  console.log('Iniciando navegador...');

  const context = await chromium.launchPersistentContext(CHROME_PROFILE, {
    channel: 'chrome',
    headless: false,
    acceptDownloads: true,
    locale: 'es-ES',
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    // --- 1. COMPROBAR SESIÓN ---
    console.log('Comprobando sesión...');
    await page.goto(HOME_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Aceptar cookies
    const cookieBtn = await page.$('button:has-text("Aceptar")');
    if (cookieBtn) {
      await cookieBtn.click();
      await page.waitForTimeout(1000);
    }

    // Verificar sesión: buscar nombre de usuario en la página
    const userEl = await page.$('text=J.CANO, text=CANO, [class*="user-name"]');
    const isHome = page.url().includes('/home') && !page.url().includes('login');

    if (!isHome || !userEl) {
      console.log('No hay sesión activa.');
      await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });

      const cookieBtn2 = await page.$('button:has-text("Aceptar")');
      if (cookieBtn2) { await cookieBtn2.click(); await page.waitForTimeout(1000); }

      msg('Haz login con certificado en el navegador.\n  El script continuará al detectar la sesión.');

      // Esperar login (máx 5 minutos)
      let loggedIn = false;
      for (let i = 0; i < 60; i++) {
        await page.waitForTimeout(5000);
        const url = page.url();
        if (url.includes('/home') && !url.includes('login')) {
          loggedIn = true;
          break;
        }
        if (url.includes('select-represented')) {
          console.log('  Esperando selección de representado...');
        }
      }
      if (!loggedIn) throw new Error('Timeout esperando login (5 min).');
      console.log('Login completado.');
    } else {
      console.log('Sesión activa.');
    }

    // --- 2. ESTABLECER SESIÓN SSO PARA /site/ ---
    // Navegar por la ruta que establece el SSO: nota-online → solicitar
    console.log('Estableciendo sesión SSO...');

    await page.goto(NOTA_ONLINE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Buscar y hacer clic en "Solicitar nota online"
    const solicitarLink = await page.$('a:has-text("Solicitar nota online"), a:has-text("Solicitar Nota"), button:has-text("Solicitar")');
    if (solicitarLink) {
      console.log('Clic en Solicitar nota online (SSO)...');
      await Promise.all([
        page.waitForNavigation({ timeout: 30000 }).catch(() => {}),
        solicitarLink.click(),
      ]);
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);
      console.log(`URL tras SSO: ${page.url()}`);
    } else {
      // Intentar navegar directamente a la URL de solicitar
      console.log('Navegando directamente a búsqueda...');
      await page.goto(SOLICITAR_URL, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    // --- 3. IR AL LISTADO DE SOLICITUDES ---
    console.log('Navegando al listado de solicitudes...');
    await page.goto(LISTADO_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    console.log(`URL: ${page.url()}`);
    await page.screenshot({ path: path.join(DOWNLOAD_DIR, 'debug-listado.png'), fullPage: true });

    // Verificar tabla
    await page.waitForSelector('table', { timeout: 15000 });
    console.log('Listado cargado.');

    // --- 4. DESCARGAR NOTAS RESPONDIDAS ---
    msg('DESCARGA AUTOMÁTICA INICIADA');

    let currentPage = 1;
    let totalDownloaded = 0;
    let totalSkipped = 0;
    let hasNextPage = true;

    while (hasNextPage) {
      console.log(`\n--- Página ${currentPage} ---`);

      // Extraer datos de las filas de una vez (evita problemas de DOM detached)
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

      console.log(`Filas: ${rowsData.length} respondidas`);

      for (const { refCode, href } of rowsData) {

        if (downloaded[refCode]) {
          totalSkipped++;
          continue;
        }

        console.log(`  [DESCARGANDO] ${refCode}...`);

        // Ir al detalle
        const detailUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 });

        // Buscar "Realizar consulta online"
        const downloadBtn = await page.$('a:has-text("Realizar consulta online"), button:has-text("Realizar consulta")');
        if (!downloadBtn) {
          console.log(`  [WARN] ${refCode} - sin botón de descarga`);
          await page.goto(`${LISTADO_URL}?order=desc&orderBy=id&pageSize=10&page=${currentPage}`, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForSelector('table', { timeout: 15000 });
          continue;
        }

        // Obtener URL del PDF desde data-url o href
        const pdfPath = await downloadBtn.getAttribute('data-url') || await downloadBtn.getAttribute('href');

        if (!pdfPath) {
          console.log(`  [WARN] ${refCode} - botón sin URL de descarga`);
          await page.goto(`${LISTADO_URL}?order=desc&orderBy=id&pageSize=10&page=${currentPage}`, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForSelector('table', { timeout: 15000 });
          continue;
        }

        // Construir URL completa: /solicitud/nota-online/{ID} → /site/solicitud/nota-online/{ID}
        let pdfUrl;
        if (pdfPath.startsWith('http')) {
          pdfUrl = pdfPath;
        } else if (pdfPath.startsWith('/solicitud/')) {
          pdfUrl = `${BASE_URL}/site${pdfPath}`;
        } else {
          pdfUrl = `${BASE_URL}${pdfPath}`;
        }

        console.log(`  URL PDF: ${pdfUrl}`);

        // Descargar el PDF haciendo clic en el botón (dispara descarga nativa)
        const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
        await downloadBtn.click();
        const download = await downloadPromise;

        if (download) {
          const fileName = `${refCode}.pdf`;
          const filePath = path.join(DOWNLOAD_DIR, fileName);
          await download.saveAs(filePath);

          // Verificar que es un PDF real
          const header = Buffer.alloc(4);
          const fd = fs.openSync(filePath, 'r');
          fs.readSync(fd, header, 0, 4, 0);
          fs.closeSync(fd);

          if (header.toString('ascii') === '%PDF') {
            downloaded[refCode] = { date: new Date().toISOString(), file: fileName };
            fs.writeFileSync(logFile, JSON.stringify(downloaded, null, 2));
            totalDownloaded++;
            console.log(`  [OK] ${refCode} -> ${fileName}`);
          } else {
            console.log(`  [WARN] ${refCode} - archivo no es PDF, eliminando`);
            fs.unlinkSync(filePath);
          }
        } else {
          // El clic navegó en vez de descargar — capturar la respuesta
          await page.waitForLoadState('networkidle', { timeout: 30000 });

          // Usar fetch desde la página para obtener el PDF como blob
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
            console.log(`  [OK] ${refCode} -> ${fileName} (fetch)`);
          } else {
            console.log(`  [ERROR] ${refCode} - no se pudo descargar`);
          }
        }

        // Volver al listado
        await page.goto(
          `${LISTADO_URL}?order=desc&orderBy=id&pageSize=10&page=${currentPage}`,
          { waitUntil: 'networkidle', timeout: 30000 }
        );
        await page.waitForSelector('table', { timeout: 15000 });
      }

      // Siguiente página
      if (totalSkipped > 0) {
        console.log(`  (${totalSkipped} ya descargadas en esta página)`);
        totalSkipped = 0;
      }

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

    msg(`COMPLETADO: ${totalDownloaded} nota(s) descargada(s)`);

  } catch (error) {
    console.error('\nError:', error.message);
    await page.screenshot({ path: path.join(DOWNLOAD_DIR, 'error-screenshot.png'), fullPage: true }).catch(() => {});
    console.error('Screenshot guardado en error-screenshot.png');
  }

  // No cerrar el navegador
  console.log('\nNavegador abierto. Ctrl+C para terminar.');
  await new Promise(() => {});
}

main();
