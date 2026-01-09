/**
 * Configuración de paginación para prevenir abuso de API
 *
 * Límites máximos por endpoint para evitar:
 * - Timeouts por queries muy grandes
 * - Consumo excesivo de memoria
 * - Potenciales ataques DoS
 */

export const PAGINATION = {
  // Límites por defecto
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,

  // Límites máximos por tipo de recurso
  MAX_LIMITS: {
    TRANSACTIONS: 100,    // Transacciones pueden ser muchas
    BUDGETS: 50,          // Pocos presupuestos por usuario
    GOALS: 50,            // Pocas metas por usuario
    NOTIFICATIONS: 100,   // Notificaciones pueden acumularse
    GAMIFICATION: 50,     // Leaderboards, badges
    EMAIL_SYNC: 50,       // Emails importados
    SUBSCRIPTIONS: 20,    // Historial de pagos
    REMINDERS: 50,        // Recordatorios
  },

  // Límite absoluto (nunca exceder)
  ABSOLUTE_MAX: 100,
} as const;

/**
 * Función helper para aplicar límite máximo
 * @param requestedLimit - Límite solicitado por el cliente
 * @param maxLimit - Límite máximo permitido
 * @param defaultLimit - Límite por defecto si no se especifica
 */
export function sanitizeLimit(
  requestedLimit: string | number | undefined,
  maxLimit: number = PAGINATION.ABSOLUTE_MAX,
  defaultLimit: number = PAGINATION.DEFAULT_LIMIT
): number {
  const limit = typeof requestedLimit === 'string'
    ? parseInt(requestedLimit, 10)
    : (requestedLimit || defaultLimit);

  // Si es NaN o negativo, usar default
  if (isNaN(limit) || limit < 1) {
    return defaultLimit;
  }

  // Aplicar límite máximo
  return Math.min(limit, maxLimit);
}

/**
 * Función helper para sanitizar página
 */
export function sanitizePage(requestedPage: string | number | undefined): number {
  const page = typeof requestedPage === 'string'
    ? parseInt(requestedPage, 10)
    : (requestedPage || PAGINATION.DEFAULT_PAGE);

  // Si es NaN o menor a 1, usar 1
  if (isNaN(page) || page < 1) {
    return PAGINATION.DEFAULT_PAGE;
  }

  return page;
}
