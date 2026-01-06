import { Request, Response } from 'express';
import { stripe, STRIPE_WEBHOOK_SECRET, PLANS } from '../config/stripe';
import { subscriptionService } from '../services/subscriptionService';
import { SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { getPlanFromPriceId } from '../config/stripe';
import { ReferralService } from '../services/referralService';
import Stripe from 'stripe';

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
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`📬 Webhook received: ${event.type}`);

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
        console.log(`⚠️  Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error: any) {
    console.error('❌ Error processing webhook:', error);
    res.status(500).json({
      error: 'Webhook processing failed',
      message: error.message
    });
  }
};

/**
 * Checkout completado - primera suscripción o cambio de plan
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  console.log('✅ Checkout completed:', session.id);

  const userId = session.metadata?.userId;
  if (!userId) {
    console.error('❌ No userId in session metadata');
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
  console.log('✅ Subscription created:', subscription.id);

  const userId = subscription.metadata?.userId;
  if (!userId) {
    console.error('❌ No userId in subscription metadata');
    return;
  }

  await updateSubscriptionFromStripe(userId, subscription);
}

/**
 * Suscripción actualizada (cambio de plan, renovación, etc)
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  console.log('✅ Subscription updated:', subscription.id);

  const userId = subscription.metadata?.userId;
  if (!userId) {
    console.error('❌ No userId in subscription metadata');
    return;
  }

  await updateSubscriptionFromStripe(userId, subscription);
}

/**
 * Suscripción eliminada/cancelada
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  console.log('✅ Subscription deleted:', subscription.id);

  const userId = subscription.metadata?.userId;
  if (!userId) {
    console.error('❌ No userId in subscription metadata');
    return;
  }

  // Downgrade a FREE
  await subscriptionService.downgradeToFree(userId);
}

/**
 * Pago exitoso
 */
async function handlePaymentSucceeded(invoice: Stripe.Invoice) {
  console.log('✅ Payment succeeded:', invoice.id);

  // Obtener el subscription ID del invoice (cast necesario por tipos de Stripe)
  const invoiceAny = invoice as any;
  const subscriptionId = invoiceAny.subscription as string;
  if (!subscriptionId) {
    console.error('❌ No subscription ID in invoice');
    return;
  }

  // Obtener la suscripción de Stripe para acceder al metadata
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = subscription.metadata?.userId;

  if (!userId) {
    console.error('❌ No userId in subscription metadata');
    return;
  }

  // Registrar pago
  await subscriptionService.recordPayment({
    userId,
    subscriptionId,
    amount: invoice.amount_paid / 100, // Convertir de centavos a dólares
    currency: invoice.currency,
    status: 'SUCCEEDED',
    stripePaymentIntentId: invoiceAny.payment_intent as string,
    stripeInvoiceId: invoice.id,
    description: `Payment for subscription`,
  });

  // Asegurar que la suscripción está activa
  await subscriptionService.updateSubscriptionStatus(userId, SubscriptionStatus.ACTIVE);

  console.log(`✅ Payment recorded for user ${userId}: $${invoice.amount_paid / 100}`);

  // Procesar conversión de referido si aplica (no bloquear si falla)
  try {
    await ReferralService.handleRefereeConversion(userId, invoice.id);
  } catch (referralError) {
    console.error('❌ Error processing referral conversion:', referralError);
    // No fallar el webhook por error de referido
  }
}

/**
 * Pago fallido
 */
async function handlePaymentFailed(invoice: Stripe.Invoice) {
  console.log('❌ Payment failed:', invoice.id);

  // Obtener el subscription ID del invoice (cast necesario por tipos de Stripe)
  const invoiceAny = invoice as any;
  const subscriptionId = invoiceAny.subscription as string;
  if (!subscriptionId) {
    console.error('❌ No subscription ID in invoice');
    return;
  }

  // Obtener la suscripción de Stripe para acceder al metadata
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = subscription.metadata?.userId;

  if (!userId) {
    console.error('❌ No userId in subscription metadata');
    return;
  }

  // Registrar pago fallido
  await subscriptionService.recordPayment({
    userId,
    subscriptionId,
    amount: invoice.amount_due / 100,
    currency: invoice.currency,
    status: 'FAILED',
    stripeInvoiceId: invoice.id,
    description: `Failed payment for subscription`,
  });

  // Marcar suscripción como PAST_DUE
  await subscriptionService.updateSubscriptionStatus(userId, SubscriptionStatus.PAST_DUE);

  console.log(`❌ Failed payment recorded for user ${userId}: $${invoice.amount_due / 100}`);

  // TODO: Enviar email notificando pago fallido
}

/**
 * Trial va a terminar (3 días antes)
 */
async function handleTrialWillEnd(subscription: Stripe.Subscription) {
  console.log('⏰ Trial will end:', subscription.id);

  const userId = subscription.metadata?.userId;
  if (!userId) {
    console.error('❌ No userId in subscription metadata');
    return;
  }

  // TODO: Enviar email notificando que el trial termina pronto
  console.log(`📧 Should send trial ending email to user ${userId}`);
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

  console.log(`✅ Subscription updated in DB: User ${userId} -> ${plan} (${status})`);
}
