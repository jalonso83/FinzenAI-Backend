import { Request, Response } from 'express';
import crypto from 'crypto';
import { logger } from '../utils/logger';

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
    });
  } catch (error) {
    logger.error('[Config] Error getting features:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Error obteniendo configuración',
    });
  }
};
