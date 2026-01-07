import { Request, Response } from 'express';
import { ReferralService } from '../services/referralService';
import { REFERRAL_CONFIG } from '../config/referralConfig';

import { logger } from '../utils/logger';
interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
  };
}

/**
 * Obtiene o genera el código de referido del usuario autenticado
 * GET /api/referrals/code
 */
export const getOrCreateReferralCode = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!REFERRAL_CONFIG.ENABLED) {
      return res.status(503).json({
        error: 'Service unavailable',
        message: 'El sistema de referidos está temporalmente deshabilitado'
      });
    }

    const { code, shareUrl } = await ReferralService.getOrCreateReferralCode(userId);

    return res.status(200).json({
      success: true,
      referralCode: code,
      shareUrl,
      discount: `${REFERRAL_CONFIG.REFEREE_DISCOUNT_PERCENT}% de descuento`,
      reward: `${REFERRAL_CONFIG.REFERRER_FREE_MONTHS} mes(es) gratis`,
      message: 'Comparte tu código con amigos para ganar recompensas'
    });

  } catch (error: any) {
    logger.error('[ReferralsController] Error getting referral code:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Valida un código de referido (endpoint público para pre-registro)
 * GET /api/referrals/validate/:code
 */
export const validateReferralCode = async (req: Request, res: Response) => {
  try {
    const { code } = req.params;

    if (!code) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Código de referido es requerido'
      });
    }

    if (!REFERRAL_CONFIG.ENABLED) {
      return res.status(503).json({
        error: 'Service unavailable',
        message: 'El sistema de referidos está temporalmente deshabilitado'
      });
    }

    const result = await ReferralService.validateReferralCode(code);

    if (!result.valid) {
      return res.status(400).json({
        valid: false,
        reason: result.reason,
        message: getReason(result.reason)
      });
    }

    return res.status(200).json({
      valid: true,
      referrerName: result.referrerName,
      discount: `${result.discount}%`,
      discountMessage: `Obtén ${result.discount}% de descuento en tu primer mes`
    });

  } catch (error: any) {
    logger.error('[ReferralsController] Error validating code:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Obtiene las estadísticas de referidos del usuario
 * GET /api/referrals/stats
 */
export const getReferralStats = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!REFERRAL_CONFIG.ENABLED) {
      return res.status(503).json({
        error: 'Service unavailable',
        message: 'El sistema de referidos está temporalmente deshabilitado'
      });
    }

    const stats = await ReferralService.getUserReferralStats(userId);

    return res.status(200).json({
      success: true,
      ...stats,
      config: {
        discountPercent: REFERRAL_CONFIG.REFEREE_DISCOUNT_PERCENT,
        freeMonths: REFERRAL_CONFIG.REFERRER_FREE_MONTHS,
        expiryDays: REFERRAL_CONFIG.EXPIRY_DAYS
      }
    });

  } catch (error: any) {
    logger.error('[ReferralsController] Error getting stats:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Obtiene las recompensas pendientes del usuario
 * GET /api/referrals/rewards
 */
export const getPendingRewards = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!REFERRAL_CONFIG.ENABLED) {
      return res.status(503).json({
        error: 'Service unavailable',
        message: 'El sistema de referidos está temporalmente deshabilitado'
      });
    }

    const rewards = await ReferralService.getPendingRewards(userId);

    return res.status(200).json({
      success: true,
      pendingRewards: rewards,
      totalPending: rewards.length
    });

  } catch (error: any) {
    logger.error('[ReferralsController] Error getting rewards:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Obtiene información de configuración del sistema de referidos
 * GET /api/referrals/info
 */
export const getReferralInfo = async (_req: Request, res: Response) => {
  try {
    if (!REFERRAL_CONFIG.ENABLED) {
      return res.status(503).json({
        enabled: false,
        message: 'El sistema de referidos está temporalmente deshabilitado'
      });
    }

    return res.status(200).json({
      enabled: true,
      benefits: {
        referee: {
          discount: REFERRAL_CONFIG.REFEREE_DISCOUNT_PERCENT,
          description: `${REFERRAL_CONFIG.REFEREE_DISCOUNT_PERCENT}% de descuento en tu primer mes`
        },
        referrer: {
          freeMonths: REFERRAL_CONFIG.REFERRER_FREE_MONTHS,
          description: `${REFERRAL_CONFIG.REFERRER_FREE_MONTHS} mes(es) gratis por cada amigo que pague`
        }
      },
      terms: {
        expiryDays: REFERRAL_CONFIG.EXPIRY_DAYS,
        description: `Tu amigo tiene ${REFERRAL_CONFIG.EXPIRY_DAYS} días para suscribirse después de registrarse`
      }
    });

  } catch (error: any) {
    logger.error('[ReferralsController] Error getting info:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Función helper para traducir códigos de error a mensajes amigables
 */
function getReason(reason?: string): string {
  switch (reason) {
    case 'CODE_NOT_FOUND':
      return 'El código de referido no existe';
    case 'CODE_INACTIVE':
      return 'Este código de referido ya no está activo';
    case 'CODE_MAX_USAGES_REACHED':
      return 'Este código ha alcanzado su límite de usos';
    case 'REFERRAL_SYSTEM_DISABLED':
      return 'El sistema de referidos está temporalmente deshabilitado';
    case 'SELF_REFERRAL_NOT_ALLOWED':
      return 'No puedes usar tu propio código de referido';
    case 'USER_ALREADY_REFERRED':
      return 'Ya tienes un código de referido aplicado';
    case 'SUSPICIOUS_REFERRAL':
      return 'No se pudo procesar el referido';
    default:
      return 'Código de referido inválido';
  }
}
