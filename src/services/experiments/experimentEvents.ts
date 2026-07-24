import { prisma } from '../../lib/prisma';
import { logger } from '../../utils/logger';

/**
 * Instrumentación GENÉRICA de experimentos. Insert plano en experiment_events —
 * SIN los side-effects de gamification_events (FinScore, badges, streak). Reusable
 * por cualquier experimento vía `experimentKey`.
 *
 * Best-effort: nunca lanza. Si el insert falla, se loguea y el flujo sigue — la
 * medición jamás debe romper la UX.
 */
export async function trackExperimentEvent(
  experimentKey: string,
  userId: string,
  eventType: string,
  props?: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.experimentEvent.create({
      data: {
        experimentKey,
        userId,
        eventType,
        props: props === undefined ? undefined : (props as object),
      },
    });
  } catch (err) {
    logger.error(`[Experiment:${experimentKey}] Error registrando evento ${eventType} (${userId}):`, err);
  }
}
