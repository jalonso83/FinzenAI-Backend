import { Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { SubscriptionStatus } from '@prisma/client';
import { revenueCatService } from '../services/revenueCatService';
import { subscriptionService } from '../services/subscriptionService';
import { ingestAttributionEvent } from '../services/attributionEventService';
import { REVENUECAT_WEBHOOK_AUTH, RC_WEBHOOK_EVENTS, PRODUCT_TO_PLAN } from '../config/revenueCat';
import { revenueCatLogger as logger } from '../utils/logger';

// Precios mensuales por plan (USD)
const PLAN_PRICES: Record<string, Record<string, number>> = {
  PRO: { monthly: 9.99, yearly: 99.99 },
  PREMIUM: { monthly: 4.99, yearly: 49.99 },
};

/**
 * Handler principal del webhook de RevenueCat
 * POST /webhooks/revenuecat
 */
export const handleRevenueCatWebhook = async (req: Request, res: Response) => {
  // Verificar Authorization header (requerido siempre)
  if (!REVENUECAT_WEBHOOK_AUTH) {
    logger.error('Webhook RC: REVENUECAT_WEBHOOK_AUTH_HEADER no configurado');
    return res.status(500).json({ error: 'Webhook not configured' });
  }
  const authHeader = req.headers['authorization'];
  if (authHeader !== REVENUECAT_WEBHOOK_AUTH) {
    logger.error('Webhook RC: Authorization header inválido');
    return res.status(401).json({ error: 'Unauthorized' });
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
      case RC_WEBHOOK_EVENTS.RENEWAL: {
        // Sync suscripción
        await revenueCatService.verifyAndSyncPurchase(userId);

        // CRÍTICO: Registrar pago en tabla Payment - DEBE exitir o fallar el webhook
        const productId = event.event.product_id;
        const productInfo = productId ? PRODUCT_TO_PLAN[productId] : null;
        const plan = productInfo?.plan || 'PRO';
        const period = productInfo?.period || 'monthly';
        const amount = PLAN_PRICES[plan]?.[period] || 9.99;
        const transactionId = event.event.transaction_id || event.event.original_transaction_id;

        // Obtener el ID de la suscripción en NUESTRA BD
        const userSubscription = await prisma.subscription.findUnique({
          where: { userId },
          select: { id: true },
        });

        if (!userSubscription) {
          logger.error(`❌ CRITICAL: No subscription found in database for user ${userId}`);
          throw new Error(`No subscription found in database for user ${userId}`);
        }

        // Evitar duplicados: verificar si ya existe un pago para esta transacción
        let existingPayment = null;
        if (transactionId) {
          existingPayment = await prisma.payment.findFirst({
            where: { description: { contains: transactionId } },
          });
        }

        if (!existingPayment) {
          try {
            await prisma.payment.create({
              data: {
                userId,
                subscriptionId: userSubscription.id,
                amount,
                currency: 'usd',
                status: 'SUCCEEDED',
                description: `RevenueCat ${eventType} - ${plan} ${period}${transactionId ? ` (tx: ${transactionId})` : ''}`,
              },
            });
            logger.log(`✅ Pago registrado: $${amount} USD para usuario ${userId} (${plan} ${period}, subscriptionId: ${userSubscription.id})`);
          } catch (paymentError: any) {
            logger.error(`❌ CRITICAL: Error registrando pago para ${userId}:`, paymentError.message);
            throw new Error(`Failed to record RevenueCat payment for user ${userId}: ${paymentError.message}`);
          }
        } else {
          logger.log(`✅ Pago duplicado ignorado para tx: ${transactionId}`);
        }

        logger.log(`✅ ${eventType} procesado para usuario ${userId}`);

        // Disparar evento Subscribe a Meta CAPI + TikTok Events API solo en INITIAL_PURCHASE
        // (no en RENEWAL — esos los trackeamos diferente para no inflar conversiones)
        // event_id determinístico desde transactionId — si RC re-entrega, dedupea correctamente.
        if (eventType === RC_WEBHOOK_EVENTS.INITIAL_PURCHASE) {
          void (async () => {
            try {
              const userForAttribution = await prisma.user.findUnique({
                where: { id: userId },
                select: { email: true, phone: true },
              });
              const deterministicEventId = deriveEventId(
                'rc-subscribe',
                transactionId || `${userId}:${Date.now()}`,
              );
              await ingestAttributionEvent({
                eventName: 'Subscribe',
                eventId: deterministicEventId,
                userId,
                email: userForAttribution?.email ?? null,
                phone: userForAttribution?.phone ?? null,
                value: amount,
                currency: 'USD',
                actionSource: 'app', // Apple/Google IAP = mobile app
                customData: {
                  provider: 'revenuecat',
                  plan,
                  period,
                  ...(transactionId ? { transactionId } : {}),
                },
              });
            } catch (attributionError) {
              logger.warn('No se pudo disparar evento Subscribe (RC):', attributionError);
            }
          })();
        }
        break;
      }

      case RC_WEBHOOK_EVENTS.UNCANCELLATION:
      case RC_WEBHOOK_EVENTS.PRODUCT_CHANGE:
        // Para uncancellation/cambio de producto: solo sync
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

/**
 * Genera un UUID determinístico (v4-like) desde un string. Mismo input → mismo UUID.
 * Usado para que webhook re-deliveries no creen eventos duplicados en Meta/TikTok.
 */
function deriveEventId(scope: string, key: string): string {
  const hash = crypto.createHash('sha256').update(`${scope}:${key}`).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}
