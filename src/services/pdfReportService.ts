import puppeteer, { Browser } from 'puppeteer';
import { logger } from '../utils/logger';

/**
 * Generación de PDFs server-side con Puppeteer (Chromium headless).
 *
 * Estado actual: Hito 1 (infrastructure setup) — solo expone `generateDummyPdf()`
 * para validar end-to-end que Puppeteer funciona en Railway.
 *
 * Próximos hitos agregarán `generateDashboardPdf()` que navega al dashboard
 * con un one-time token y genera el reporte real.
 */

const PDF_GENERATION_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_PDFS = 1;

let activePdfGenerations = 0;

/**
 * Args estándar para Puppeteer en contenedores Linux (Railway, Docker).
 * --no-sandbox: requerido en contenedores sin user namespaces.
 * --disable-dev-shm-usage: evita problemas con /dev/shm pequeño en containers.
 */
const PUPPETEER_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

export class PdfBusyError extends Error {
  constructor() {
    super('PDF_BUSY');
    this.name = 'PdfBusyError';
  }
}

/**
 * Hito 1: PDF dummy con HTML inline. Valida que Puppeteer arranca, renderiza,
 * y devuelve un buffer válido. NO toca el dashboard real todavía.
 */
export async function generateDummyPdf(): Promise<Buffer> {
  if (activePdfGenerations >= MAX_CONCURRENT_PDFS) {
    throw new PdfBusyError();
  }

  activePdfGenerations++;
  let browser: Browser | null = null;

  const startTime = Date.now();
  logger.log('[PdfReport] Generando PDF dummy...');

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: PUPPETEER_LAUNCH_ARGS,
      timeout: PDF_GENERATION_TIMEOUT_MS,
    });

    const page = await browser.newPage();

    const html = `
      <!doctype html>
      <html lang="es">
        <head>
          <meta charset="utf-8">
          <title>FinZen AI · PDF Test</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px; color: #1a1a1a; }
            h1 { color: #0066cc; margin-bottom: 8px; }
            .meta { color: #666; font-size: 13px; }
            .info { margin-top: 24px; padding: 16px; background: #f5f7fa; border-left: 4px solid #0066cc; }
          </style>
        </head>
        <body>
          <h1>FinZen AI · PDF Test</h1>
          <p class="meta">Hito 1 — Infrastructure setup validado</p>
          <div class="info">
            <p><strong>Generado:</strong> ${new Date().toLocaleString('es-DO', { dateStyle: 'full', timeStyle: 'medium' })}</p>
            <p><strong>Versión:</strong> 1.0.0 (dummy)</p>
            <p>Si ves este PDF, Puppeteer + Chromium están funcionando correctamente en producción.</p>
          </div>
        </body>
      </html>
    `;

    await page.setContent(html, {
      waitUntil: 'networkidle0',
      timeout: PDF_GENERATION_TIMEOUT_MS,
    });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '20mm', left: '15mm', right: '15mm' },
    });

    const elapsed = Date.now() - startTime;
    logger.log(`[PdfReport] ✅ PDF dummy generado en ${elapsed}ms (${pdfBuffer.length} bytes)`);

    return Buffer.from(pdfBuffer);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    logger.error(`[PdfReport] ❌ Error generando PDF dummy (${elapsed}ms):`, error);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch((err) => {
        logger.error('[PdfReport] Error cerrando browser:', err);
      });
    }
    activePdfGenerations--;
  }
}
