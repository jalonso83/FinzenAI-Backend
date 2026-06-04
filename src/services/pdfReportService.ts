import puppeteer, { Browser } from 'puppeteer';
import { ENV } from '../config/env';
import { logger } from '../utils/logger';
import { generatePdfToken, invalidatePdfToken } from './pdfTokenService';

/**
 * Generación de PDFs server-side con Puppeteer (Chromium headless).
 *
 * Flujo de generateDashboardPdf:
 *  1. Genera un pdfToken efímero (90s TTL) asociado al admin que pidió el PDF.
 *  2. Construye URL hacia la landing: /dashboard/detalles?mode=pdf&pdfToken=...&from=...&to=...&label=...&generatedBy=...
 *  3. Lanza Chromium, navega a esa URL.
 *  4. La landing en mode=pdf renderiza cover + 6 tabs + glosario.
 *  5. Espera a que la landing señale window.__PDF_READY__ === true.
 *  6. Genera el PDF con header/footer y márgenes.
 *  7. Invalida el token y cierra el browser.
 */

const PDF_GENERATION_TIMEOUT_MS = 60_000;
const PDF_READY_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_PDFS = 1;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Valida que el periodo sea coherente: fechas ISO (YYYY-MM-DD) válidas, from ≤ to,
 * y dentro de límites sanos (no antes de 2024, no más de 1 día en el futuro).
 */
function isValidPeriod(from: string, to: string): boolean {
  if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) return false;
  const f = new Date(`${from}T00:00:00Z`);
  const t = new Date(`${to}T00:00:00Z`);
  if (isNaN(f.getTime()) || isNaN(t.getTime())) return false;
  if (f > t) return false;
  const min = new Date('2024-01-01T00:00:00Z');
  const max = new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (f < min || t > max) return false;
  return true;
}

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

export class PdfInvalidRangeError extends Error {
  constructor(range: string) {
    super(`Invalid range: ${range}`);
    this.name = 'PdfInvalidRangeError';
  }
}

export interface GenerateDashboardPdfParams {
  adminUserId: string;
  adminEmail: string;
  from: string;        // YYYY-MM-DD
  to: string;          // YYYY-MM-DD
  periodLabel: string; // etiqueta legible para portada + header
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Genera el PDF del dashboard ejecutivo.
 * Lanza PdfBusyError si ya hay otro PDF en proceso.
 * Lanza PdfInvalidRangeError si el range no es válido.
 */
export async function generateDashboardPdf(
  params: GenerateDashboardPdfParams,
): Promise<Buffer> {
  // El periodo en curso (mes/trimestre actual) puede tener 'to' en el futuro
  // (ej. Q2 termina el 30-jun). Lo recortamos a hoy: no se rechaza el reporte y
  // solo se consulta hasta hoy. El label se mantiene ("Q2 2026", etc.).
  const from = params.from;
  const today = new Date().toISOString().split('T')[0];
  const to = params.to > today ? today : params.to;

  if (!isValidPeriod(from, to)) {
    throw new PdfInvalidRangeError(`${from}..${to}`);
  }

  if (activePdfGenerations >= MAX_CONCURRENT_PDFS) {
    throw new PdfBusyError();
  }

  activePdfGenerations++;
  let browser: Browser | null = null;
  let pdfToken: string | null = null;

  const startTime = Date.now();
  logger.log(
    `[PdfReport] Generando PDF dashboard | admin=${params.adminEmail} periodo=${params.periodLabel} (${from}..${to})`,
  );

  try {
    // 1. Token efímero
    pdfToken = generatePdfToken(params.adminUserId, params.adminEmail);

    // 2. URL de la landing en modo PDF
    const url = new URL(`${ENV.LANDING_URL}/dashboard/detalles`);
    url.searchParams.set('mode', 'pdf');
    url.searchParams.set('pdfToken', pdfToken);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    url.searchParams.set('label', params.periodLabel);
    url.searchParams.set('generatedBy', params.adminEmail);

    // 3. Lanzar Chromium
    browser = await puppeteer.launch({
      headless: true,
      args: PUPPETEER_LAUNCH_ARGS,
      timeout: PDF_GENERATION_TIMEOUT_MS,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1800 });

    // Diagnóstico: capturar logs del browser, network failures y respuestas 4xx/5xx.
    // Usamos logger.error para TODO porque en producción solo .error sale.
    page.on('console', (msg) => {
      logger.error(`[PdfReport][Browser-console] ${msg.type()}: ${msg.text()}`);
    });
    page.on('requestfailed', (request) => {
      logger.error(`[PdfReport][Browser-net] FAIL ${request.url()} - ${request.failure()?.errorText}`);
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status >= 400) {
        logger.error(`[PdfReport][Browser-net] HTTP ${status} ${response.url()}`);
      }
    });
    page.on('pageerror', (error) => {
      logger.error(`[PdfReport][Browser-pageerror] ${error.message}`);
    });

    // 4. Navegar. Usamos 'domcontentloaded' (no 'networkidle0') porque el
    // dashboard tiene scripts persistentes (analytics, etc.) que mantienen la
    // red activa indefinidamente. La garantía real de que el contenido está
    // listo viene del waitForFunction(__PDF_READY__) más abajo.
    await page.goto(url.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: PDF_GENERATION_TIMEOUT_MS,
    });

    // 5. Esperar la señal del frontend
    try {
      await page.waitForFunction(
        '(window.__PDF_READY__ === true)',
        { timeout: PDF_READY_TIMEOUT_MS },
      );
    } catch (err) {
      logger.error('[PdfReport] Timeout esperando window.__PDF_READY__');
      throw new Error('PDF render timed out — el dashboard tardó demasiado en señalar listo');
    }

    // 6. Esperar fonts
    await page.evaluateHandle('document.fonts.ready');

    // 7. Delay extra para animaciones de charts (recharts ~1500ms + buffer).
    // Sin esto, los donut/line/bar charts se capturan mid-animation y salen
    // cortados en el PDF.
    await new Promise(resolve => setTimeout(resolve, 2500));

    // 8. Generar PDF con header/footer
    const rangeLabel = params.periodLabel;
    const generatedDate = new Date().toLocaleDateString('es-DO', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const headerTemplate = `
      <div style="font-size:9px;color:#666;width:100%;padding:0 15mm;font-family:sans-serif;text-align:center;">
        <span>FinZen AI · Reporte Ejecutivo · Periodo: ${escapeHtml(rangeLabel)}</span>
      </div>
    `;

    const footerTemplate = `
      <div style="font-size:9px;color:#666;width:100%;padding:0 15mm;display:flex;justify-content:space-between;font-family:sans-serif;">
        <span>Generado: ${escapeHtml(generatedDate)}</span>
        <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span>
      </div>
    `;

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
    });

    const elapsed = Date.now() - startTime;
    logger.log(
      `[PdfReport] ✅ PDF generado en ${elapsed}ms (${pdfBuffer.length} bytes)`,
    );

    return Buffer.from(pdfBuffer);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    logger.error(`[PdfReport] ❌ Error generando PDF (${elapsed}ms):`, error);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch((err) => {
        logger.error('[PdfReport] Error cerrando browser:', err);
      });
    }
    if (pdfToken) {
      invalidatePdfToken(pdfToken);
    }
    activePdfGenerations--;
  }
}
