import { stripe } from '../config/stripe';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { ReferralService } from './referralService';

const prisma = new PrismaClient();

export class StripeService {
  /**
   * Crear un customer en Stripe
   */
  async createCustomer(userId: string, email: string, name: string): Promise<Stripe.Customer> {
    try {
      const customer = await stripe.customers.create({
        email,
        name,
        metadata: { userId },
      });

      // Actualizar el usuario con el stripeCustomerId
      await prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customer.id },
      });

      console.log(`✅ Stripe customer creado: ${customer.id} para usuario ${userId}`);
      return customer;
    } catch (error) {
      console.error('Error creando customer en Stripe:', error);
      throw new Error('No se pudo crear el customer en Stripe');
    }
  }

  /**
   * Crear una sesión de checkout de Stripe
   */
  async createCheckoutSession(
    userId: string,
    priceId: string,
    successUrl: string,
    cancelUrl: string
  ): Promise<Stripe.Checkout.Session> {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });

      if (!user) {
        throw new Error('Usuario no encontrado');
      }

      let customerId = user.stripeCustomerId;

      // Crear customer si no existe
      if (!customerId) {
        const customer = await this.createCustomer(
          userId,
          user.email,
          `${user.name} ${user.lastName}`
        );
        customerId = customer.id;
      }

      // Verificar si el usuario tiene descuento de referido pendiente
      let refereeCoupon: string | null = null;
      try {
        refereeCoupon = await ReferralService.getRefereeCouponForCheckout(userId);
        if (refereeCoupon) {
          console.log(`[StripeService] Aplicando cupón de referido ${refereeCoupon} para usuario ${userId}`);
        }
      } catch (couponError) {
        console.error('[StripeService] Error obteniendo cupón de referido:', couponError);
        // Continuar sin cupón si hay error
      }

      // Configurar sesión de checkout
      const sessionConfig: Stripe.Checkout.SessionCreateParams = {
        customer: customerId,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: { userId, platform: 'mobile' },
        subscription_data: {
          trial_period_days: 7, // 7 días de prueba gratis
          metadata: { userId },
        },
        // Optimizaciones para móvil
        billing_address_collection: 'auto',
        phone_number_collection: { enabled: false },
      };

      // Aplicar descuento de referido si existe
      if (refereeCoupon) {
        sessionConfig.discounts = [{ coupon: refereeCoupon }];
        // No permitir otros códigos si ya tiene descuento de referido
        sessionConfig.allow_promotion_codes = false;
      } else {
        // Permitir códigos promocionales solo si no tiene referido
        sessionConfig.allow_promotion_codes = true;
      }

      // Crear sesión de checkout
      const session = await stripe.checkout.sessions.create(sessionConfig);

      console.log(`✅ Checkout session creada: ${session.id} para usuario ${userId}`);
      return session;
    } catch (error) {
      console.error('Error creando checkout session:', error);
      throw new Error('No se pudo crear la sesión de pago');
    }
  }

  /**
   * Cancelar una suscripción (al final del período)
   */
  async cancelSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    try {
      const subscription = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
      });

      console.log(`✅ Suscripción marcada para cancelación: ${subscriptionId}`);
      return subscription;
    } catch (error) {
      console.error('Error cancelando suscripción:', error);
      throw new Error('No se pudo cancelar la suscripción');
    }
  }

  /**
   * Reactivar una suscripción cancelada
   */
  async reactivateSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    try {
      const subscription = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: false,
      });

      console.log(`✅ Suscripción reactivada: ${subscriptionId}`);
      return subscription;
    } catch (error) {
      console.error('Error reactivando suscripción:', error);
      throw new Error('No se pudo reactivar la suscripción');
    }
  }

  /**
   * Cancelar suscripción inmediatamente
   */
  async cancelSubscriptionImmediately(subscriptionId: string): Promise<Stripe.Subscription> {
    try {
      const subscription = await stripe.subscriptions.cancel(subscriptionId);

      console.log(`✅ Suscripción cancelada inmediatamente: ${subscriptionId}`);
      return subscription;
    } catch (error) {
      console.error('Error cancelando suscripción inmediatamente:', error);
      throw new Error('No se pudo cancelar la suscripción');
    }
  }

  /**
   * Crear portal del cliente para gestionar suscripción
   */
  async createCustomerPortal(
    customerId: string,
    returnUrl: string
  ): Promise<Stripe.BillingPortal.Session> {
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });

      console.log(`✅ Portal de cliente creado para: ${customerId}`);
      return session;
    } catch (error) {
      console.error('Error creando portal de cliente:', error);
      throw new Error('No se pudo crear el portal de cliente');
    }
  }

  /**
   * Obtener detalles de una suscripción
   */
  async getSubscriptionDetails(subscriptionId: string): Promise<Stripe.Subscription> {
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      return subscription;
    } catch (error) {
      console.error('Error obteniendo detalles de suscripción:', error);
      throw new Error('No se pudo obtener la suscripción');
    }
  }

  /**
   * Cambiar plan de suscripción
   */
  async changeSubscriptionPlan(
    subscriptionId: string,
    newPriceId: string
  ): Promise<Stripe.Subscription> {
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);

      const updatedSubscription = await stripe.subscriptions.update(subscriptionId, {
        items: [{
          id: subscription.items.data[0].id,
          price: newPriceId,
        }],
        proration_behavior: 'create_prorations', // Prorratear el cambio
      });

      console.log(`✅ Plan de suscripción cambiado: ${subscriptionId}`);
      return updatedSubscription;
    } catch (error) {
      console.error('Error cambiando plan de suscripción:', error);
      throw new Error('No se pudo cambiar el plan');
    }
  }

  /**
   * Obtener facturas de un cliente
   */
  async getCustomerInvoices(customerId: string, limit: number = 10): Promise<Stripe.Invoice[]> {
    try {
      const invoices = await stripe.invoices.list({
        customer: customerId,
        limit,
      });

      return invoices.data;
    } catch (error) {
      console.error('Error obteniendo facturas:', error);
      throw new Error('No se pudieron obtener las facturas');
    }
  }
}

export const stripeService = new StripeService();
