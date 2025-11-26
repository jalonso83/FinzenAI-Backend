import { prisma } from '../lib/prisma';
import { PLANS, PlanType } from '../config/stripe';
import { SubscriptionPlan, SubscriptionStatus } from '@prisma/client';

export class SubscriptionService {
  /**
   * Obtener suscripción de un usuario
   */
  async getUserSubscription(userId: string) {
    try {
      let subscription = await prisma.subscription.findUnique({
        where: { userId },
      });

      // Si no tiene suscripción, crear una FREE por defecto
      if (!subscription) {
        subscription = await this.createFreeSubscription(userId);
      }

      const plan = subscription.plan as PlanType;
      const limits = PLANS[plan].limits;
      const features = PLANS[plan].features;

      return {
        ...subscription,
        limits,
        features,
        planDetails: PLANS[plan],
      };
    } catch (error) {
      console.error('Error obteniendo suscripción:', error);
      throw new Error('No se pudo obtener la suscripción');
    }
  }

  /**
   * Crear suscripción FREE por defecto
   */
  async createFreeSubscription(userId: string) {
    try {
      const subscription = await prisma.subscription.create({
        data: {
          userId,
          plan: SubscriptionPlan.FREE,
          status: SubscriptionStatus.ACTIVE,
        },
      });

      console.log(`✅ Suscripción FREE creada para usuario ${userId}`);
      return subscription;
    } catch (error) {
      console.error('Error creando suscripción FREE:', error);
      throw new Error('No se pudo crear la suscripción');
    }
  }

  /**
   * Verificar si el usuario puede usar una feature
   */
  async canUseFeature(userId: string, feature: string): Promise<boolean> {
    try {
      const subscription = await this.getUserSubscription(userId);
      const limits = subscription.limits as any;

      return limits[feature] === true || limits[feature] === -1;
    } catch (error) {
      console.error('Error verificando feature:', error);
      return false;
    }
  }

  /**
   * Verificar límite de un recurso (presupuestos, metas, etc)
   */
  async checkResourceLimit(
    userId: string,
    resourceType: 'budgets' | 'goals' | 'zenioQueries',
    currentCount: number
  ): Promise<{ allowed: boolean; limit: number; remaining: number }> {
    try {
      const subscription = await this.getUserSubscription(userId);
      const limits = subscription.limits as any;
      const limit = limits[resourceType];

      // -1 significa ilimitado
      if (limit === -1) {
        return {
          allowed: true,
          limit: -1,
          remaining: -1,
        };
      }

      const allowed = currentCount < limit;
      const remaining = Math.max(0, limit - currentCount);

      return {
        allowed,
        limit,
        remaining,
      };
    } catch (error) {
      console.error('Error verificando límite de recurso:', error);
      return { allowed: false, limit: 0, remaining: 0 };
    }
  }

  /**
   * Actualizar suscripción después de un pago exitoso
   */
  async updateSubscriptionAfterPayment(
    userId: string,
    plan: SubscriptionPlan,
    stripeData: {
      stripeCustomerId: string;
      stripeSubscriptionId: string;
      stripePriceId: string;
      currentPeriodStart: Date;
      currentPeriodEnd: Date;
      trialEndsAt?: Date | null;
    }
  ) {
    try {
      const subscription = await prisma.subscription.upsert({
        where: { userId },
        create: {
          userId,
          plan,
          status: SubscriptionStatus.ACTIVE,
          ...stripeData,
        },
        update: {
          plan,
          status: SubscriptionStatus.ACTIVE,
          ...stripeData,
          cancelAtPeriodEnd: false,
        },
      });

      console.log(`✅ Suscripción actualizada a ${plan} para usuario ${userId}`);
      return subscription;
    } catch (error) {
      console.error('Error actualizando suscripción:', error);
      throw new Error('No se pudo actualizar la suscripción');
    }
  }

  /**
   * Cancelar suscripción (marcar para cancelar al final del período)
   */
  async cancelSubscription(userId: string) {
    try {
      const subscription = await prisma.subscription.update({
        where: { userId },
        data: {
          cancelAtPeriodEnd: true,
        },
      });

      console.log(`✅ Suscripción marcada para cancelación: usuario ${userId}`);
      return subscription;
    } catch (error) {
      console.error('Error cancelando suscripción:', error);
      throw new Error('No se pudo cancelar la suscripción');
    }
  }

  /**
   * Reactivar suscripción cancelada
   */
  async reactivateSubscription(userId: string) {
    try {
      const subscription = await prisma.subscription.update({
        where: { userId },
        data: {
          cancelAtPeriodEnd: false,
        },
      });

      console.log(`✅ Suscripción reactivada: usuario ${userId}`);
      return subscription;
    } catch (error) {
      console.error('Error reactivando suscripción:', error);
      throw new Error('No se pudo reactivar la suscripción');
    }
  }

  /**
   * Downgrade a FREE después de cancelación
   */
  async downgradeToFree(userId: string) {
    try {
      const subscription = await prisma.subscription.update({
        where: { userId },
        data: {
          plan: SubscriptionPlan.FREE,
          status: SubscriptionStatus.CANCELED,
          stripeSubscriptionId: null,
          stripePriceId: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        },
      });

      console.log(`✅ Usuario ${userId} degradado a plan FREE`);
      return subscription;
    } catch (error) {
      console.error('Error degradando a FREE:', error);
      throw new Error('No se pudo degradar el plan');
    }
  }

  /**
   * Actualizar estado de suscripción
   */
  async updateSubscriptionStatus(userId: string, status: SubscriptionStatus) {
    try {
      const subscription = await prisma.subscription.update({
        where: { userId },
        data: { status },
      });

      console.log(`✅ Estado de suscripción actualizado: usuario ${userId} -> ${status}`);
      return subscription;
    } catch (error) {
      console.error('Error actualizando estado de suscripción:', error);
      throw new Error('No se pudo actualizar el estado');
    }
  }

  /**
   * Registrar pago
   */
  async recordPayment(data: {
    userId: string;
    subscriptionId?: string;
    amount: number;
    currency: string;
    status: 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'REFUNDED' | 'CANCELED';
    stripePaymentIntentId?: string;
    stripeInvoiceId?: string;
    description?: string;
  }) {
    try {
      const payment = await prisma.payment.create({
        data,
      });

      console.log(`✅ Pago registrado: ${payment.id} - ${data.status}`);
      return payment;
    } catch (error) {
      console.error('Error registrando pago:', error);
      throw new Error('No se pudo registrar el pago');
    }
  }

  /**
   * Obtener historial de pagos
   */
  async getPaymentHistory(userId: string, limit: number = 10) {
    try {
      const payments = await prisma.payment.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      return payments;
    } catch (error) {
      console.error('Error obteniendo historial de pagos:', error);
      throw new Error('No se pudo obtener el historial');
    }
  }

  /**
   * Obtener estadísticas de suscripciones (para admin)
   */
  async getSubscriptionStats() {
    try {
      const stats = await prisma.subscription.groupBy({
        by: ['plan'],
        _count: true,
      });

      const activeByPlan = await prisma.subscription.groupBy({
        by: ['plan'],
        where: { status: SubscriptionStatus.ACTIVE },
        _count: true,
      });

      return {
        totalByPlan: stats,
        activeByPlan,
      };
    } catch (error) {
      console.error('Error obteniendo estadísticas:', error);
      throw new Error('No se pudieron obtener las estadísticas');
    }
  }
}

export const subscriptionService = new SubscriptionService();
