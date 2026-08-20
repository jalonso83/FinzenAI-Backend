import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { logger } from '../utils/logger';

/**
 * Registra un uso de funcionalidad. Fire-and-forget: NO se espera (no añade latencia
 * a la respuesta del endpoint) y captura su propio error (nunca rompe el request).
 *
 * Genérico para cualquier feature medible sin tocar la app: la pantalla ya pega a su
 * endpoint; se llama a esto dentro del handler.
 *
 * @param feature ej. 'ant_expense'
 * @param action  ej. 'analysis' (uso real) | 'config' (abrió la pantalla)
 */
export function recordFeatureUsage(
  userId: string,
  feature: string,
  action: string,
  /** Contexto opcional del evento (ej. `{ plan: 'PRO' }` al activar un trial).
   *  NO metas aquí nada que sirva para filtrar: para eso está `action`, que es
   *  columna indexada. Esto es para lo que se quiere leer, no buscar. */
  metadata?: Prisma.InputJsonValue,
): void {
  prisma.featureUsage
    .create({ data: { userId, feature, action, metadata } })
    .catch((e) => logger.error('[FeatureUsage] Error registrando uso:', e));
}
