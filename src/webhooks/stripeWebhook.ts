import { Request, Response } from 'express';
import { stripe, STRIPE_WEBHOOK_SECRET, PLANS } from '../config/stripe';
import { subscriptionService } from '../services/subscriptionService';
import { EmailSyncService } from '../services/emailSyncService';
import { SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { getPlanFromPriceId } from '../config/stripe';
import { ReferralService } from '../services/referralService';
import Stripe from 'stripe';

import { logger } from '../utils/logger';
/**
 * Handler principal del webhook de Stripe
 */
export const handleStripeWebhook = async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;

  let event: Stripe.Event;

  try {
    // Verificar firma del webhook
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err: any) {
    logger.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  logger.log(`📬 Webhook received: ${event.type}`);

  try {
    // Procesar evento según tipo
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      case 'customer.subscription.trial_will_end':
        await handleTrialWillEnd(event.data.object as Stripe.Subscription);
        break;

      default:
        logger.log(`⚠️  Unhandled event type: ${event.type}`);
    }

    logger.log(`✅ Webhook ${event.type} processed successfully`);
    res.json({ received: true, processed: true });
  } catch (error: any) {
    logger.error(`❌ CRITICAL: Error processing webhook ${event.type}:`, error.message);
    logger.error('Stack trace:', error.stack);
    // IMPORTANTE: Responder con error 500 para que Stripe reintente
    res.status(500).json({
      error: 'Webhook processing failed',
      message: error.message,
      eventType: event.type
    });
  }
};

/**
 * Checkout completado - primera suscripción o cambio de plan
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  logger.log('✅ Checkout completed:', session.id);

  const userId = session.metadata?.userId;
  if (!userId) {
    logger.error('❌ No userId in session metadata');
    return;
  }

  if (session.mode === 'subscription' && session.subscription) {
    const subscription = await stripe.subscriptions.retrieve(
      session.subscription as string
    );

    await updateSubscriptionFromStripe(userId, subscription);
  }
}

/**
 * Suscripción creada
 */
async function handleSubscriptionCreated(subscription: Stripe.Subscription) {
  logger.log('✅ Subscription created:', subscription.id);

  const userId = subscription.metadata?.userId;
  if (!userId) {
    logger.error('❌ No userId in subscription metadata');
    return;
  }

  await updateSubscriptionFromStripe(userId, subscription);
}

/**
 * Suscripción actualizada (cambio de plan, renovación, etc)
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  logger.log('✅ Subscription updated:', subscription.id);

  const userId = subscription.metadata?.userId;
  if (!userId) {
    logger.error('❌ No userId in subscription metadata');
    return;
  }

  // Obtener plan actual antes de actualizar
  const currentSubscription = await subscriptionService.getUserSubscription(userId);
  const currentPlan = currentSubscription?.plan;

  // Determinar nuevo plan
  const priceId = subscription.items.data[0].price.id;
  const planInfo = getPlanFromPriceId(priceId);
  const newPlan = planInfo?.plan || 'FREE';

  // Si el usuario baja de PRO a otro plan, eliminar conexiones de email
  if (currentPlan === 'PRO' && newPlan !== 'PRO') {
    try {
      const deletedConnections = await EmailSyncService.deleteAllUserEmailConnections(userId);
      if (deletedConnections > 0) {
        logger.log(`[Webhook] Eliminadas ${deletedConnections} conexiones de email al bajar de PRO a ${newPlan}`);
      }
    } catch (emailError) {
      logger.warn(`[Webhook] Error eliminando conexiones de email:`, emailError);
    }
  }

  await updateSubscriptionFromStripe(userId, subscription);
}

/**
 * Suscripción eliminada/cancelada
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  logger.log('✅ Subscription deleted:', subscription.id);

  const userId = subscription.metadata?.userId;
  if (!userId) {
    logger.error('❌ No userId in subscription metadata');
    return;
  }

  // Eliminar conexiones de email (email sync es exclusivo PRO)
  try {
    const deletedConnections = await EmailSyncService.deleteAllUserEmailConnections(userId);
    if (deletedConnections > 0) {
      logger.log(`[Webhook] Eliminadas ${deletedConnections} conexiones de email al cancelar suscripción`);
    }
  } catch (emailError) {
    logger.warn(`[Webhook] Error eliminando conexiones de email:`, emailError);
  }

  // Downgrade a FREE
  await subscriptionService.downgradeToFree(userId);
}

/**
 * Pago exitoso
 */
async function handlePaymentSucceeded(invoice: Stripe.Invoice) {
  logger.log('✅ Payment succeeded:', invoice.id);

  // Obtener el subscription ID del invoice (cast necesario por tipos de Stripe)
  const invoiceAny = invoice as any;
  const subscriptionId = invoiceAny.subscription as string;
  if (!subscriptionId) {
    logger.error('❌ No subscription ID in invoice');
    throw new Error('No subscription ID in invoice');
  }

  // Obtener la suscripción de Stripe para acceder al metadata
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = subscription.metadata?.userId;

  if (!userId) {
    logger.error('❌ No userId in subscription metadata');
    throw new Error('No userId in subscription metadata');
  }

  // CRÍTICO: Registrar pago - DEBE exitir o fallar el webhook
  // Obtener el ID de la suscripción en NUESTRA BD (no el de Stripe)
  const userSubscription = await prisma.subscription.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!userSubscription) {
    logger.error(`❌ CRITICAL: No subscription found in database for user ${userId}`);
    throw new Error(`No subscription found in database for user ${userId}`);
  }

  let paymentRecorded = false;
  try {
    await subscriptionService.recordPayment({
      userId,
      subscriptionId: userSubscription.id, // Usar ID de nuestra BD, NO el de Stripe
      amount: invoice.amount_paid / 100, // Convertir de centavos a dólares
      currency: invoice.currency,
      status: 'SUCCEEDED',
      stripePaymentIntentId: invoiceAny.payment_intent as string,
      stripeInvoiceId: invoice.id,
      description: `Payment for subscription`,
    });
    paymentRecorded = true;
    logger.log(`✅ Payment recorded in database for user ${userId}: $${invoice.amount_paid / 100} (subscriptionId: ${userSubscription.id})`);
  } catch (paymentError: any) {
    logger.error('❌ CRITICAL: Failed to record payment in database:', paymentError.message);
    throw new Error(`Payment recording failed for user ${userId}: ${paymentError.message}`);
  }

  // Solo continuar si el pago se registró exitosamente
  if (!paymentRecorded) {
    throw new Error('Payment was not recorded in database');
  }

  // Asegurar que la suscripción está activa
  try {
    await subscriptionService.updateSubscriptionStatus(userId, SubscriptionStatus.ACTIVE);
    logger.log(`✅ Subscription status updated to ACTIVE for user ${userId}`);
  } catch (statusError: any) {
    logger.error('❌ Warning: Failed to update subscription status:', statusError.message);
    // Este error no es crítico - el pago ya fue registrado
  }

  logger.log(`✅ Payment COMPLETE for user ${userId}: $${invoice.amount_paid / 100}`);

  // Procesar conversión de referido si aplica (no bloquear si falla)
  try {
    await ReferralService.handleRefereeConversion(userId, invoice.id);
  } catch (referralError) {
    logger.error('⚠️  Warning: Error processing referral conversion:', referralError);
    // No fallar el webhook por error de referido
  }
}

/**
 * Pago fallido
 */
async function handlePaymentFailed(invoice: Stripe.Invoice) {
  logger.log('❌ Payment failed:', invoice.id);

  // Obtener el subscription ID del invoice (cast necesario por tipos de Stripe)
  const invoiceAny = invoice as any;
  const subscriptionId = invoiceAny.subscription as string;
  if (!subscriptionId) {
    logger.error('❌ No subscription ID in invoice');
    throw new Error('No subscription ID in failed payment invoice');
  }

  // Obtener la suscripción de Stripe para acceder al metadata
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = subscription.metadata?.userId;

  if (!userId) {
    logger.error('❌ No userId in subscription metadata');
    throw new Error('No userId in failed payment subscription metadata');
  }

  // CRÍTICO: Registrar pago fallido - DEBE existir o fallar el webhook
  // Obtener el ID de la suscripción en NUESTRA BD (no el de Stripe)
  const userSubscription = await prisma.subscription.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!userSubscription) {
    logger.error(`❌ CRITICAL: No subscription found in database for user ${userId}`);
    throw new Error(`No subscription found in database for user ${userId}`);
  }

  try {
    await subscriptionService.recordPayment({
      userId,
      subscriptionId: userSubscription.id, // Usar ID de nuestra BD, NO el de Stripe
      amount: invoice.amount_due / 100,
      currency: invoice.currency,
      status: 'FAILED',
      stripeInvoiceId: invoice.id,
      description: `Failed payment for subscription`,
    });
    logger.log(`✅ Failed payment recorded in database for user ${userId}: $${invoice.amount_due / 100} (subscriptionId: ${userSubscription.id})`);
  } catch (paymentError: any) {
    logger.error('❌ CRITICAL: Failed to record failed payment in database:', paymentError.message);
    throw new Error(`Failed payment recording failed for user ${userId}: ${paymentError.message}`);
  }

  // Marcar suscripción como PAST_DUE
  try {
    await subscriptionService.updateSubscriptionStatus(userId, SubscriptionStatus.PAST_DUE);
    logger.log(`✅ Subscription marked as PAST_DUE for user ${userId}`);
  } catch (statusError: any) {
    logger.warn('⚠️  Warning: Failed to update subscription status to PAST_DUE:', statusError.message);
    // Este error no es crítico - el pago fallido ya fue registrado
  }

  logger.log(`❌ Failed payment RECORDED for user ${userId}: $${invoice.amount_due / 100}`);

  // TODO: Enviar email notificando pago fallido
}

/**
 * Trial va a terminar (3 días antes)
 */
async function handleTrialWillEnd(subscription: Stripe.Subscription) {
  logger.log('⏰ Trial will end:', subscription.id);

  const userId = subscription.metadata?.userId;
  if (!userId) {
    logger.error('❌ No userId in subscription metadata');
    return;
  }

  // TODO: Enviar email notificando que el trial termina pronto
  logger.log(`📧 Should send trial ending email to user ${userId}`);
}

/**
 * Helper: Actualizar suscripción en BD desde datos de Stripe
 */
async function updateSubscriptionFromStripe(
  userId: string,
  subscription: Stripe.Subscription
) {
  // Determinar el plan basado en el price ID usando el helper
  const priceId = subscription.items.data[0].price.id;
  let plan: SubscriptionPlan = SubscriptionPlan.FREE;

  const planInfo = getPlanFromPriceId(priceId);
  if (planInfo) {
    plan = planInfo.plan === 'PREMIUM' ? SubscriptionPlan.PREMIUM : SubscriptionPlan.PRO;
  }

  // Mapear status de Stripe a nuestro enum
  const statusMap: { [key: string]: SubscriptionStatus } = {
    'active': SubscriptionStatus.ACTIVE,
    'canceled': SubscriptionStatus.CANCELED,
    'past_due': SubscriptionStatus.PAST_DUE,
    'trialing': SubscriptionStatus.TRIALING,
    'incomplete': SubscriptionStatus.INCOMPLETE,
    'incomplete_expired': SubscriptionStatus.INCOMPLETE_EXPIRED,
    'unpaid': SubscriptionStatus.UNPAID,
  };

  const status = statusMap[subscription.status] || SubscriptionStatus.ACTIVE;

  // Actualizar en BD
  const sub = subscription as any;
  const currentPeriodStart = sub.current_period_start
    ? new Date(sub.current_period_start * 1000)
    : new Date();
  const currentPeriodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000)
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 días por defecto

  await subscriptionService.updateSubscriptionAfterPayment(userId, plan, {
    stripeCustomerId: subscription.customer as string,
    stripeSubscriptionId: subscription.id,
    stripePriceId: priceId,
    currentPeriodStart,
    currentPeriodEnd,
    trialEndsAt: subscription.trial_end
      ? new Date(subscription.trial_end * 1000)
      : null,
  });

  // Actualizar status si es necesario
  await subscriptionService.updateSubscriptionStatus(userId, status);

  logger.log(`✅ Subscription updated in DB: User ${userId} -> ${plan} (${status})`);
}
