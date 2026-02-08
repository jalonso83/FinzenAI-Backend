import { Request, Response } from 'express';
import { revenueCatService } from '../services/revenueCatService';
import { subscriptionService } from '../services/subscriptionService';
import { prisma } from '../lib/prisma';
import { revenueCatLogger as logger } from '../utils/logger';

/**
 * POST /api/subscriptions/rc/verify-purchase
 * Verifica la compra con RevenueCat y sincroniza la DB
 */
export const verifyPurchase = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    // Verificar si el usuario ya tiene una suscripción Stripe activa
    const existing = await prisma.subscription.findUnique({
      where: { userId },
      select: { plan: true, status: true, paymentProvider: true, stripeSubscriptionId: true },
    });

    if (
      existing &&
      existing.plan !== 'FREE' &&
      existing.status === 'ACTIVE' &&
      existing.paymentProvider === 'STRIPE' &&
      existing.stripeSubscriptionId
    ) {
      return res.status(409).json({
        error: 'Ya tienes una suscripción activa con Stripe. Cancélala primero antes de comprar via App Store.',
      });
    }

    // Sincronizar desde RevenueCat
    await revenueCatService.verifyAndSyncPurchase(userId);

    // Retornar suscripción completa (con limits, features, etc.)
    const subscription = await subscriptionService.getUserSubscription(userId);

    logger.log(`Compra verificada para usuario ${userId}: ${subscription.plan}`);

    return res.json(subscription);
  } catch (error: any) {
    logger.error('Error verificando compra RC:', error.message);
    return res.status(500).json({
      error: 'No se pudo verificar la compra',
      message: error.message,
    });
  }
};

/**
 * POST /api/subscriptions/rc/restore
 * Restaura compras desde RevenueCat
 */
export const restorePurchases = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    await revenueCatService.restorePurchases(userId);

    // Retornar suscripción actualizada
    const subscription = await subscriptionService.getUserSubscription(userId);

    logger.log(`Compras restauradas para usuario ${userId}: ${subscription.plan}`);

    return res.json(subscription);
  } catch (error: any) {
    logger.error('Error restaurando compras RC:', error.message);
    return res.status(500).json({
      error: 'No se pudieron restaurar las compras',
      message: error.message,
    });
  }
};

/**
 * GET /api/subscriptions/rc/status
 * Obtiene el estado de la suscripción (con paymentProvider)
 */
export const getStatus = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const subscription = await subscriptionService.getUserSubscription(userId);

    return res.json(subscription);
  } catch (error: any) {
    logger.error('Error obteniendo status RC:', error.message);
    return res.status(500).json({
      error: 'No se pudo obtener el estado de la suscripción',
      message: error.message,
    });
  }
};
