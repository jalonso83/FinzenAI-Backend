import { Request, Response } from 'express';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import { prisma } from '../lib/prisma';

/**
 * Hash determinístico de userId → bucket 0-99.
 * Permite rollout consistente: el mismo user siempre cae en el mismo bucket.
 * El prefijo namespacea por feature, así un user en el 10% de feature A
 * no necesariamente cae en el 10% de feature B.
 */
function userBucket(userId: string, featureName: string): number {
  const hash = crypto
    .createHash('sha256')
    .update(`${featureName}:${userId}`)
    .digest();
  return hash.readUInt32BE(0) % 100;
}

/**
 * Determina si un user tiene habilitado el botón de saltar onboarding.
 *
 * Orden de evaluación:
 *   1. Whitelist (gana siempre — para dogfood/QA)
 *   2. Flag global ENABLED + bucket dentro del rollout %
 *
 * Variables de entorno:
 *   ONBOARDING_SKIP_ENABLED      = 'true' | 'false' (default: 'false')
 *   ONBOARDING_SKIP_ROLLOUT_PCT  = entero 0-100 (default: 0)
 *   ONBOARDING_SKIP_WHITELIST    = 'userId1,userId2,...' (default: '')
 */
export function isOnboardingSkipEnabled(userId: string): boolean {
  const whitelist = (process.env.ONBOARDING_SKIP_WHITELIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (whitelist.includes(userId)) {
    return true;
  }

  if (process.env.ONBOARDING_SKIP_ENABLED !== 'true') {
    return false;
  }

  const rolloutRaw = parseInt(process.env.ONBOARDING_SKIP_ROLLOUT_PCT || '0', 10);
  const rolloutPct = Number.isFinite(rolloutRaw)
    ? Math.max(0, Math.min(100, rolloutRaw))
    : 0;

  if (rolloutPct === 0) return false;
  if (rolloutPct >= 100) return true;

  return userBucket(userId, 'onboarding-skip') < rolloutPct;
}

/**
 * Determina si un user entra en la variante "onboarding NO bloqueante" (H10):
 * puede llegar al dashboard sin completar el onboarding.
 *
 * Experimento de holdout: bucket < PCT = variante (sin muro), bucket >= PCT =
 * control (gate actual). Namespace propio ('onboarding-nonblocking'), así que
 * la asignación es INDEPENDIENTE del bucket de skip. Determinística y estable
 * por cuenta → reconstruible en SQL para medir por brazo.
 *
 * IMPORTANTE para el análisis: excluir los userId de la whitelist (QA/dogfood)
 * porque no son asignación aleatoria. Congelar el PCT durante toda la corrida.
 *
 * Variables de entorno:
 *   ONBOARDING_NONBLOCKING_ENABLED      = 'true' | 'false' (default: 'false')
 *   ONBOARDING_NONBLOCKING_ROLLOUT_PCT  = entero 0-100 (default: 0) — arranque: 50
 *   ONBOARDING_NONBLOCKING_WHITELIST    = 'userId1,userId2,...' (default: '')
 */
export function isOnboardingNonblockingEnabled(userId: string): boolean {
  const whitelist = (process.env.ONBOARDING_NONBLOCKING_WHITELIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (whitelist.includes(userId)) {
    return true;
  }

  if (process.env.ONBOARDING_NONBLOCKING_ENABLED !== 'true') {
    return false;
  }

  const rolloutRaw = parseInt(process.env.ONBOARDING_NONBLOCKING_ROLLOUT_PCT || '0', 10);
  const rolloutPct = Number.isFinite(rolloutRaw)
    ? Math.max(0, Math.min(100, rolloutRaw))
    : 0;

  if (rolloutPct === 0) return false;
  if (rolloutPct >= 100) return true;

  return userBucket(userId, 'onboarding-nonblocking') < rolloutPct;
}

/**
 * GET /api/config/features
 * Devuelve flags de features habilitados para el usuario autenticado.
 * La app móvil debe consultar este endpoint tras login y guardar en memoria.
 */
export const getFeatures = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Usuario no autenticado' });
    }

    return res.json({
      onboardingSkipEnabled: isOnboardingSkipEnabled(userId),
      onboardingNonblockingEnabled: isOnboardingNonblockingEnabled(userId),
    });
  } catch (error) {
    logger.error('[Config] Error getting features:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Error obteniendo configuración',
    });
  }
};

/**
 * POST /api/config/app-entered
 * Marca (una sola vez) que el usuario llegó al dashboard = "entró a la app".
 * Señal de entrada para el experimento H10 (onboarding no bloqueante): la variante
 * entra SIN completar onboarding, así que onboardingCompleted no sirve como señal.
 * Idempotente: solo escribe si firstAppEntryAt está en NULL (no pisa la primera vez).
 */
export const markAppEntered = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Usuario no autenticado' });
    }

    await prisma.user.updateMany({
      where: { id: userId, firstAppEntryAt: null },
      data: { firstAppEntryAt: new Date() },
    });

    return res.json({ ok: true });
  } catch (error) {
    logger.error('[Config] Error marking app entered:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Error registrando entrada a la app',
    });
  }
};
