import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';

/**
 * One-time PDF token service.
 *
 * Cuando un admin pide generar un PDF del dashboard, el backend lanza
 * Puppeteer que necesita "loguearse" en el dashboard para renderizarlo.
 * Pasar el JWT real del admin en la URL es inseguro (logs, history).
 *
 * Solución: generar un token efímero (90s) que solo sirve para que
 * Puppeteer abra el dashboard. Vive in-memory, se limpia automáticamente.
 *
 * El token NO es de un solo uso literal — durante la generación de un PDF
 * Puppeteer hace múltiples requests al backend (KPIs, charts, etc.), todos
 * con el mismo token. Lo que hace que sea seguro es la vida ultracorta.
 *
 * Limitación conocida: si Railway tuviera múltiples instancias, un token
 * generado en instance-A no funcionaría en instance-B. Hoy usamos
 * single-instance, así que no aplica. Si crece, migrar a Redis.
 */

const TOKEN_TTL_MS = 90 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

interface TokenData {
  adminUserId: string;
  adminEmail: string;
  expiresAt: number;
}

const tokens = new Map<string, TokenData>();

/**
 * Genera un token efímero asociado al admin actual.
 * El caller debe haber validado ya que es un admin (vía authenticateAdmin).
 */
export function generatePdfToken(adminUserId: string, adminEmail: string): string {
  const token = randomUUID();
  tokens.set(token, {
    adminUserId,
    adminEmail,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

/**
 * Valida un token y devuelve los datos del admin si es válido.
 * Devuelve null si no existe, expiró, o fue invalidado.
 */
export function validatePdfToken(token: string): { adminUserId: string; adminEmail: string } | null {
  const data = tokens.get(token);
  if (!data) return null;

  if (data.expiresAt < Date.now()) {
    tokens.delete(token);
    return null;
  }

  return { adminUserId: data.adminUserId, adminEmail: data.adminEmail };
}

/**
 * Invalida un token explícitamente (ej: al terminar la generación del PDF).
 * No es estrictamente necesario porque expira solo, pero ahorra memoria.
 */
export function invalidatePdfToken(token: string): void {
  tokens.delete(token);
}

/**
 * Devuelve estadísticas internas (útil para debugging / health checks).
 */
export function getPdfTokenStats(): { activeTokens: number } {
  return { activeTokens: tokens.size };
}

/**
 * Cleanup automático de tokens expirados.
 * Singleton: se inicializa al cargar el módulo.
 */
let cleanupInterval: NodeJS.Timeout | null = null;

function startCleanup() {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    try {
      const now = Date.now();
      let cleaned = 0;
      for (const [token, data] of tokens) {
        if (data.expiresAt < now) {
          tokens.delete(token);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        logger.log(`[PdfTokenService] Limpiados ${cleaned} tokens expirados (activos restantes: ${tokens.size})`);
      }
    } catch (err) {
      logger.error('[PdfTokenService] Error en cleanup interval:', err);
    }
  }, CLEANUP_INTERVAL_MS);

  // No bloquear shutdown del proceso por este interval
  if (typeof cleanupInterval.unref === 'function') {
    cleanupInterval.unref();
  }

  logger.log(`[PdfTokenService] Cleanup interval iniciado (cada ${CLEANUP_INTERVAL_MS / 1000}s, TTL ${TOKEN_TTL_MS / 1000}s)`);
}

startCleanup();
