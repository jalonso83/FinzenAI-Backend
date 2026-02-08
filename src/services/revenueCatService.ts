import axios from 'axios';
import { prisma } from '../lib/prisma';
import { SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { EmailSyncService } from './emailSyncService';
import {
  REVENUECAT_API_URL,
  REVENUECAT_API_KEY,
  ENTITLEMENT_TO_PLAN,
  PRODUCT_TO_PLAN,
} from '../config/revenueCat';
import { revenueCatLogger as logger } from '../utils/logger';

interface RCEntitlement {
  expires_date: string | null;
  purchase_date: string;
  product_identifier: string;
  is_sandbox: boolean;
}

interface RCSubscriberInfo {
  subscriber: {
    entitlements: Record<string, RCEntitlement>;
    subscriptions: Record<string, {
      expires_date: string | null;
      purchase_date: string;
      original_purchase_date: string;
      period_type: string;
      store: string;
      is_sandbox: boolean;
      unsubscribe_detected_at: string | null;
      billing_issues_detected_at: string | null;
    }>;
    original_app_user_id: string;
    first_seen: string;
  };
}

export class RevenueCatService {
  /**
   * Obtener info del suscriptor desde RevenueCat REST API
   */
  async getSubscriberInfo(appUserId: string): Promise<RCSubscriberInfo | null> {
    try {
      if (!REVENUECAT_API_KEY) {
        logger.warn('REVENUECAT_SECRET_KEY no configurado');
        return null;
      }

      const response = await axios.get(
        `${REVENUECAT_API_URL}/subscribers/${encodeURIComponent(appUserId)}`,
        {
          headers: {
            'Authorization': `Bearer ${REVENUECAT_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.log(`Suscriptor no encontrado en RC: ${appUserId}`);
        return null;
      }
      logger.error('Error obteniendo subscriber info de RC:', error.message);
      throw new Error('No se pudo obtener info del suscriptor de RevenueCat');
    }
  }

  /**
   * Determinar el plan más alto activo desde los entitlements de RC
   * PRO > PREMIUM > FREE
   */
  determinePlanFromEntitlements(
    entitlements: Record<string, RCEntitlement>
  ): { plan: SubscriptionPlan; productId: string | null; expiresDate: Date | null } {
    let highestPlan: SubscriptionPlan = SubscriptionPlan.FREE;
    let productId: string | null = null;
    let expiresDate: Date | null = null;

    const now = new Date();

    for (const [entitlementId, entitlement] of Object.entries(entitlements)) {
      // Verificar si el entitlement está activo (no expirado)
      if (entitlement.expires_date) {
        const expires = new Date(entitlement.expires_date);
        if (expires < now) continue; // Expirado, saltear
      }

      const mappedPlan = ENTITLEMENT_TO_PLAN[entitlementId];
      if (!mappedPlan) continue;

      // PRO tiene prioridad sobre PREMIUM
      if (mappedPlan === 'PRO' || (mappedPlan === 'PREMIUM' && highestPlan !== 'PRO')) {
        highestPlan = mappedPlan === 'PRO' ? SubscriptionPlan.PRO : SubscriptionPlan.PREMIUM;
        productId = entitlement.product_identifier;
        expiresDate = entitlement.expires_date ? new Date(entitlement.expires_date) : null;
      }
    }

    return { plan: highestPlan, productId, expiresDate };
  }

  /**
   * Sincronizar suscripción desde RevenueCat a la tabla Subscription
   */
  async syncSubscriptionFromRevenueCat(
    userId: string,
    subscriberData: RCSubscriberInfo
  ): Promise<any> {
    const { entitlements, subscriptions } = subscriberData.subscriber;
    const { plan, productId, expiresDate } = this.determinePlanFromEntitlements(entitlements);

    // Determinar periodo de facturación desde el productId
    const productInfo = productId ? PRODUCT_TO_PLAN[productId] : null;

    // Obtener info de la suscripción activa para el producto
    let currentPeriodStart: Date | null = null;
    let currentPeriodEnd: Date | null = null;
    let cancelAtPeriodEnd = false;
    let status: SubscriptionStatus = SubscriptionStatus.ACTIVE;
    let originalTransactionId: string | null = null;

    if (productId && subscriptions[productId]) {
      const sub = subscriptions[productId];
      currentPeriodStart = new Date(sub.purchase_date);
      currentPeriodEnd = sub.expires_date ? new Date(sub.expires_date) : null;
      cancelAtPeriodEnd = sub.unsubscribe_detected_at !== null;
      originalTransactionId = sub.original_purchase_date || null;

      if (sub.billing_issues_detected_at) {
        status = SubscriptionStatus.PAST_DUE;
      } else if (sub.period_type === 'trial') {
        status = SubscriptionStatus.TRIALING;
      }
    }

    // Si no hay plan activo, dejar en FREE
    if (plan === SubscriptionPlan.FREE) {
      return this.downgradeToFree(userId);
    }

    const appUserId = subscriberData.subscriber.original_app_user_id;

    const subscription = await prisma.subscription.upsert({
      where: { userId },
      create: {
        userId,
        plan,
        status,
        paymentProvider: 'APPLE',
        revenueCatAppUserId: appUserId,
        originalTransactionId,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd,
      },
      update: {
        plan,
        status,
        paymentProvider: 'APPLE',
        revenueCatAppUserId: appUserId,
        originalTransactionId,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd,
      },
    });

    logger.log(`Suscripción sincronizada para usuario ${userId}: ${plan} (${status})`);
    return subscription;
  }

  /**
   * Verificar y sincronizar compra desde RevenueCat
   * Llamado desde el controller después de una compra exitosa en el SDK
   */
  async verifyAndSyncPurchase(userId: string): Promise<any> {
    const subscriberInfo = await this.getSubscriberInfo(userId);

    if (!subscriberInfo) {
      logger.warn(`No se encontró info en RC para userId: ${userId}`);
      return null;
    }

    return this.syncSubscriptionFromRevenueCat(userId, subscriberInfo);
  }

  /**
   * Downgrade a FREE cuando expira la suscripción de Apple
   */
  async downgradeToFree(userId: string): Promise<any> {
    // Obtener plan actual para saber si necesitamos limpiar email connections
    const currentSub = await prisma.subscription.findUnique({
      where: { userId },
      select: { plan: true },
    });

    // Si baja de PRO, eliminar conexiones de email
    if (currentSub?.plan === 'PRO') {
      try {
        const deleted = await EmailSyncService.deleteAllUserEmailConnections(userId);
        if (deleted > 0) {
          logger.log(`Eliminadas ${deleted} conexiones de email al bajar de PRO`);
        }
      } catch (err) {
        logger.warn('Error eliminando conexiones de email:', err);
      }
    }

    const subscription = await prisma.subscription.upsert({
      where: { userId },
      create: {
        userId,
        plan: SubscriptionPlan.FREE,
        status: SubscriptionStatus.ACTIVE,
        paymentProvider: 'APPLE',
      },
      update: {
        plan: SubscriptionPlan.FREE,
        status: SubscriptionStatus.CANCELED,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      },
    });

    logger.log(`Usuario ${userId} degradado a FREE`);
    return subscription;
  }

  /**
   * Restaurar compras - re-sync desde RevenueCat
   */
  async restorePurchases(userId: string): Promise<any> {
    return this.verifyAndSyncPurchase(userId);
  }
}

export const revenueCatService = new RevenueCatService();
