import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { SubscriptionStatus } from '@prisma/client';
import { revenueCatService } from '../services/revenueCatService';
import { subscriptionService } from '../services/subscriptionService';
import { REVENUECAT_WEBHOOK_AUTH, RC_WEBHOOK_EVENTS } from '../config/revenueCat';
import { revenueCatLogger as logger } from '../utils/logger';

/**
 * Handler principal del webhook de RevenueCat
 * POST /webhooks/revenuecat
 */
export const handleRevenueCatWebhook = async (req: Request, res: Response) => {
  // Verificar Authorization header
  if (REVENUECAT_WEBHOOK_AUTH) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== REVENUECAT_WEBHOOK_AUTH) {
      logger.error('Webhook RC: Authorization header inválido');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const event = req.body;

  if (!event || !event.event) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const eventType = event.event.type;
  const appUserId = event.event.app_user_id;

  logger.log(`Webhook RC recibido: ${eventType} para ${appUserId}`);

  // Ignorar usuarios anónimos de RevenueCat
  if (!appUserId || appUserId.startsWith('$RCAnonymousID')) {
    logger.log(`Ignorando evento de usuario anónimo: ${appUserId}`);
    return res.json({ received: true });
  }

  try {
    // Buscar usuario por ID (appUserId = nuestro userId)
    const user = await prisma.user.findUnique({
      where: { id: appUserId },
      select: { id: true },
    });

    if (!user) {
      logger.warn(`Usuario no encontrado para appUserId: ${appUserId}`);
      return res.json({ received: true });
    }

    const userId = user.id;

    switch (eventType) {
      case RC_WEBHOOK_EVENTS.INITIAL_PURCHASE:
      case RC_WEBHOOK_EVENTS.RENEWAL:
      case RC_WEBHOOK_EVENTS.UNCANCELLATION:
      case RC_WEBHOOK_EVENTS.PRODUCT_CHANGE:
        // Para compras/renovaciones: fetch subscriber info fresco y sync
        await revenueCatService.verifyAndSyncPurchase(userId);
        logger.log(`${eventType} procesado para usuario ${userId}`);
        break;

      case RC_WEBHOOK_EVENTS.CANCELLATION:
        // Cancelación: marcar cancelAtPeriodEnd pero NO downgrade aún
        await prisma.subscription.updateMany({
          where: { userId, paymentProvider: 'APPLE' },
          data: { cancelAtPeriodEnd: true },
        });
        logger.log(`Cancelación marcada para usuario ${userId}`);
        break;

      case RC_WEBHOOK_EVENTS.EXPIRATION:
        // Expiración: downgrade a FREE
        await revenueCatService.downgradeToFree(userId);
        logger.log(`Suscripción expirada, downgrade a FREE para usuario ${userId}`);
        break;

      case RC_WEBHOOK_EVENTS.BILLING_ISSUE_DETECTED:
        // Billing issue: marcar PAST_DUE
        await subscriptionService.updateSubscriptionStatus(userId, SubscriptionStatus.PAST_DUE);
        logger.log(`Billing issue detectado para usuario ${userId}`);
        break;

      case RC_WEBHOOK_EVENTS.TRANSFER:
        // Transferencia: re-sync desde RC
        await revenueCatService.verifyAndSyncPurchase(userId);
        logger.log(`Transferencia procesada para usuario ${userId}`);
        break;

      default:
        logger.log(`Evento RC no manejado: ${eventType}`);
    }

    return res.json({ received: true });
  } catch (error: any) {
    logger.error(`Error procesando webhook RC (${eventType}):`, error.message);
    return res.status(500).json({
      error: 'Webhook processing failed',
      message: error.message,
    });
  }
};
