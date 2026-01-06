import { PrismaClient, ReferralStatus, RewardStatus, RewardType } from '@prisma/client';
import { stripe } from '../config/stripe';
import { REFERRAL_CONFIG } from '../config/referralConfig';
import Stripe from 'stripe';

const prisma = new PrismaClient();

// Tipos para respuestas
interface FraudCheckResult {
  suspicious: boolean;
  reasons: string[];
}

interface ReferralCodeInfo {
  valid: boolean;
  referrerId?: string;
  referrerName?: string;
  discount?: number;
  reason?: string;
}

interface ApplyReferralResult {
  success: boolean;
  reason?: string;
  discountPercent?: number;
}

interface ReferralStats {
  referralCode: string;
  shareUrl: string;
  totalReferrals: number;
  pendingReferrals: number;
  convertedReferrals: number;
  rewardedReferrals: number;
  expiredReferrals: number;
  totalRewardsEarned: number;
  pendingRewards: number;
  referralsList: Array<{
    id: string;
    refereeName: string;
    refereeEmail: string;
    status: ReferralStatus;
    createdAt: Date;
    convertedAt: Date | null;
  }>;
}

export class ReferralService {
  /**
   * Genera un código de referido único para un usuario
   * Formato: FINZEN-{NOMBRE}-{RANDOM}
   */
  static async generateReferralCode(userId: string): Promise<string> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, referralCode: true }
    });

    if (!user) {
      throw new Error('Usuario no encontrado');
    }

    // Si ya tiene código, retornarlo
    if (user.referralCode) {
      return user.referralCode.code;
    }

    // Generar código único
    const nameClean = (user.name || 'USER')
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .substring(0, 8);

    let code: string;
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 10) {
      const randomPart = this.generateRandomString(REFERRAL_CONFIG.CODE_RANDOM_LENGTH);
      code = `${REFERRAL_CONFIG.CODE_PREFIX}-${nameClean}-${randomPart}`;

      const existing = await prisma.referralCode.findUnique({ where: { code } });
      if (!existing) {
        isUnique = true;
      }
      attempts++;
    }

    if (!isUnique) {
      throw new Error('No se pudo generar un código único');
    }

    // Crear el código en la base de datos
    await prisma.referralCode.create({
      data: {
        userId,
        code: code!,
        isActive: true,
        usageCount: 0
      }
    });

    console.log(`[ReferralService] Código generado: ${code} para usuario ${userId}`);
    return code!;
  }

  /**
   * Obtiene o genera el código de referido de un usuario
   */
  static async getOrCreateReferralCode(userId: string): Promise<{ code: string; shareUrl: string }> {
    let referralCode = await prisma.referralCode.findUnique({
      where: { userId }
    });

    if (!referralCode) {
      const code = await this.generateReferralCode(userId);
      referralCode = await prisma.referralCode.findUnique({ where: { code } });
    }

    const shareUrl = `${process.env.APP_URL || 'https://finzenai.com'}/join?ref=${referralCode!.code}`;

    return {
      code: referralCode!.code,
      shareUrl
    };
  }

  /**
   * Valida un código de referido
   */
  static async validateReferralCode(code: string): Promise<ReferralCodeInfo> {
    if (!REFERRAL_CONFIG.ENABLED) {
      return { valid: false, reason: 'REFERRAL_SYSTEM_DISABLED' };
    }

    const referralCode = await prisma.referralCode.findUnique({
      where: { code: code.toUpperCase() },
      include: {
        user: { select: { id: true, name: true } }
      }
    });

    if (!referralCode) {
      return { valid: false, reason: 'CODE_NOT_FOUND' };
    }

    if (!referralCode.isActive) {
      return { valid: false, reason: 'CODE_INACTIVE' };
    }

    if (referralCode.maxUsages && referralCode.usageCount >= referralCode.maxUsages) {
      return { valid: false, reason: 'CODE_MAX_USAGES_REACHED' };
    }

    return {
      valid: true,
      referrerId: referralCode.user.id,
      referrerName: referralCode.user.name || 'Un amigo',
      discount: REFERRAL_CONFIG.REFEREE_DISCOUNT_PERCENT
    };
  }

  /**
   * Aplica un código de referido a un nuevo usuario durante el registro
   */
  static async applyReferralCode(
    refereeId: string,
    refereeEmail: string,
    code: string
  ): Promise<ApplyReferralResult> {
    if (!REFERRAL_CONFIG.ENABLED) {
      return { success: false, reason: 'REFERRAL_SYSTEM_DISABLED' };
    }

    // Validar código
    const codeInfo = await this.validateReferralCode(code);
    if (!codeInfo.valid) {
      return { success: false, reason: codeInfo.reason };
    }

    // Verificar que no sea auto-referido
    if (codeInfo.referrerId === refereeId) {
      return { success: false, reason: 'SELF_REFERRAL_NOT_ALLOWED' };
    }

    // Verificar que el usuario no ya tenga un referido
    const existingReferral = await prisma.referral.findUnique({
      where: { refereeId }
    });

    if (existingReferral) {
      return { success: false, reason: 'USER_ALREADY_REFERRED' };
    }

    // Verificar anti-fraude si está habilitado
    if (REFERRAL_CONFIG.FRAUD_CHECK_ENABLED) {
      const fraudCheck = await this.checkFraudIndicators(codeInfo.referrerId!, refereeEmail);
      if (fraudCheck.suspicious) {
        console.warn(`[ReferralService] Referido sospechoso detectado: ${fraudCheck.reasons.join(', ')}`);
        return { success: false, reason: 'SUSPICIOUS_REFERRAL' };
      }
    }

    // Obtener el código de referido completo
    const referralCode = await prisma.referralCode.findFirst({
      where: { code: code.toUpperCase() }
    });

    if (!referralCode) {
      return { success: false, reason: 'CODE_NOT_FOUND' };
    }

    // Crear el referido
    const referral = await prisma.referral.create({
      data: {
        referralCodeId: referralCode.id,
        referrerId: codeInfo.referrerId!,
        refereeId,
        refereeEmail,
        status: 'PENDING'
      }
    });

    // Crear la recompensa pendiente para el referee (descuento)
    await prisma.referralReward.create({
      data: {
        userId: refereeId,
        referralId: referral.id,
        type: 'REFEREE_DISCOUNT',
        status: 'PENDING',
        value: REFERRAL_CONFIG.REFEREE_DISCOUNT_PERCENT,
        description: `${REFERRAL_CONFIG.REFEREE_DISCOUNT_PERCENT}% descuento en primer mes`
      }
    });

    // Incrementar contador de uso
    await prisma.referralCode.update({
      where: { id: referralCode.id },
      data: { usageCount: { increment: 1 } }
    });

    console.log(`[ReferralService] Referido aplicado: ${refereeId} referido por ${codeInfo.referrerId}`);

    return {
      success: true,
      discountPercent: REFERRAL_CONFIG.REFEREE_DISCOUNT_PERCENT
    };
  }

  /**
   * Obtiene o crea el cupón de descuento para referidos en Stripe
   */
  static async getOrCreateRefereeCoupon(): Promise<string> {
    const couponId = REFERRAL_CONFIG.STRIPE_COUPON_ID;

    try {
      // Intentar obtener cupón existente
      await stripe.coupons.retrieve(couponId);
      return couponId;
    } catch (error: any) {
      // Si no existe, crearlo
      if (error.code === 'resource_missing') {
        await stripe.coupons.create({
          id: couponId,
          percent_off: REFERRAL_CONFIG.REFEREE_DISCOUNT_PERCENT,
          duration: 'once',
          name: `Referido FinZen: ${REFERRAL_CONFIG.REFEREE_DISCOUNT_PERCENT}% descuento`,
          metadata: {
            type: 'referral_referee_discount'
          }
        });

        console.log(`[ReferralService] Cupón creado en Stripe: ${couponId}`);
        return couponId;
      }
      throw error;
    }
  }

  /**
   * Obtiene el cupón de descuento si el usuario tiene un referido pendiente
   * Se usa en createCheckoutSession para auto-aplicar el descuento
   */
  static async getRefereeCouponForCheckout(userId: string): Promise<string | null> {
    if (!REFERRAL_CONFIG.ENABLED) {
      return null;
    }

    // Buscar si el usuario tiene un referido pendiente con recompensa pendiente
    const pendingReward = await prisma.referralReward.findFirst({
      where: {
        userId,
        type: 'REFEREE_DISCOUNT',
        status: 'PENDING'
      }
    });

    if (!pendingReward) {
      return null;
    }

    // Obtener o crear el cupón
    const couponId = await this.getOrCreateRefereeCoupon();
    return couponId;
  }

  /**
   * Maneja la conversión cuando un referee realiza su primer pago
   */
  static async handleRefereeConversion(refereeId: string, stripeInvoiceId: string): Promise<void> {
    if (!REFERRAL_CONFIG.ENABLED) {
      return;
    }

    // Buscar referido pendiente para este usuario
    const referral = await prisma.referral.findUnique({
      where: { refereeId },
      include: {
        rewards: true
      }
    });

    if (!referral || referral.status !== 'PENDING') {
      // No tiene referido pendiente o ya fue procesado
      return;
    }

    const now = new Date();

    // Marcar referido como convertido
    await prisma.referral.update({
      where: { id: referral.id },
      data: {
        status: 'CONVERTED',
        convertedAt: now,
        stripeInvoiceId
      }
    });

    // Marcar la recompensa del referee como aplicada
    const refereeReward = referral.rewards.find(r => r.type === 'REFEREE_DISCOUNT');
    if (refereeReward) {
      await prisma.referralReward.update({
        where: { id: refereeReward.id },
        data: {
          status: 'APPLIED',
          appliedAt: now
        }
      });
    }

    // Aplicar recompensa al referidor (meses gratis)
    await this.applyReferrerReward(referral.referrerId, referral.id);

    // Marcar referido como recompensado
    await prisma.referral.update({
      where: { id: referral.id },
      data: {
        status: 'REWARDED',
        rewardedAt: new Date()
      }
    });

    console.log(`[ReferralService] Conversión procesada: referee ${refereeId}, referrer ${referral.referrerId}`);
  }

  /**
   * Aplica la recompensa de meses gratis al referidor
   */
  static async applyReferrerReward(referrerId: string, referralId: string): Promise<void> {
    const freeMonths = REFERRAL_CONFIG.REFERRER_FREE_MONTHS;

    if (freeMonths <= 0) {
      return;
    }

    // Crear registro de recompensa
    const reward = await prisma.referralReward.create({
      data: {
        userId: referrerId,
        referralId,
        type: 'REFERRER_FREE_MONTH',
        status: 'PENDING',
        value: freeMonths,
        description: `${freeMonths} mes(es) gratis por referir un amigo`
      }
    });

    // Obtener la suscripción del referidor
    const subscription = await prisma.subscription.findUnique({
      where: { userId: referrerId },
      include: { user: true }
    });

    if (!subscription || !subscription.stripeSubscriptionId) {
      console.log(`[ReferralService] Referidor ${referrerId} no tiene suscripción activa - recompensa guardada para después`);
      return;
    }

    try {
      // Aplicar crédito en Stripe usando invoice credit
      // Calculamos el valor del crédito basado en el precio mensual
      const stripeSubscription = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
      const currentPrice = stripeSubscription.items.data[0]?.price;

      if (currentPrice && currentPrice.unit_amount) {
        const creditAmount = currentPrice.unit_amount * freeMonths; // En centavos

        // Crear un crédito de factura para el cliente
        await stripe.customers.createBalanceTransaction(subscription.user.stripeCustomerId!, {
          amount: -creditAmount, // Negativo = crédito
          currency: currentPrice.currency,
          description: `Crédito por referir amigo - ${freeMonths} mes(es) gratis`,
          metadata: {
            referralId,
            rewardId: reward.id,
            type: 'referral_reward'
          }
        });

        // Marcar recompensa como aplicada
        await prisma.referralReward.update({
          where: { id: reward.id },
          data: {
            status: 'APPLIED',
            appliedAt: new Date(),
            stripeCouponId: 'credit_balance'
          }
        });

        console.log(`[ReferralService] Crédito de ${creditAmount / 100} ${currentPrice.currency} aplicado a ${referrerId}`);
      }
    } catch (error) {
      console.error(`[ReferralService] Error aplicando crédito a referidor:`, error);
      // La recompensa queda pendiente para aplicar manualmente o en siguiente intento
    }
  }

  /**
   * Obtiene las estadísticas de referidos de un usuario
   */
  static async getUserReferralStats(userId: string): Promise<ReferralStats> {
    const { code, shareUrl } = await this.getOrCreateReferralCode(userId);

    const referrals = await prisma.referral.findMany({
      where: { referrerId: userId },
      include: {
        referee: { select: { name: true, email: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const rewards = await prisma.referralReward.findMany({
      where: {
        userId,
        type: 'REFERRER_FREE_MONTH'
      }
    });

    const statusCounts = {
      pending: 0,
      converted: 0,
      rewarded: 0,
      expired: 0
    };

    referrals.forEach(r => {
      switch (r.status) {
        case 'PENDING':
          statusCounts.pending++;
          break;
        case 'CONVERTED':
          statusCounts.converted++;
          break;
        case 'REWARDED':
          statusCounts.rewarded++;
          break;
        case 'EXPIRED':
        case 'CANCELLED':
          statusCounts.expired++;
          break;
      }
    });

    return {
      referralCode: code,
      shareUrl,
      totalReferrals: referrals.length,
      pendingReferrals: statusCounts.pending,
      convertedReferrals: statusCounts.converted,
      rewardedReferrals: statusCounts.rewarded,
      expiredReferrals: statusCounts.expired,
      totalRewardsEarned: rewards.filter(r => r.status === 'APPLIED').length,
      pendingRewards: rewards.filter(r => r.status === 'PENDING').length,
      referralsList: referrals.map(r => ({
        id: r.id,
        refereeName: r.referee.name || 'Usuario',
        refereeEmail: this.maskEmail(r.referee.email),
        status: r.status,
        createdAt: r.createdAt,
        convertedAt: r.convertedAt
      }))
    };
  }

  /**
   * Obtiene las recompensas pendientes de un usuario
   */
  static async getPendingRewards(userId: string): Promise<Array<{
    id: string;
    type: RewardType;
    value: number;
    description: string;
    createdAt: Date;
  }>> {
    const rewards = await prisma.referralReward.findMany({
      where: {
        userId,
        status: 'PENDING'
      },
      orderBy: { createdAt: 'desc' }
    });

    return rewards.map(r => ({
      id: r.id,
      type: r.type,
      value: r.value,
      description: r.description,
      createdAt: r.createdAt
    }));
  }

  /**
   * Expira los referidos pendientes que han pasado el tiempo límite
   */
  static async expirePendingReferrals(): Promise<{ expired: number }> {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() - REFERRAL_CONFIG.EXPIRY_DAYS);

    const result = await prisma.referral.updateMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: expiryDate }
      },
      data: {
        status: 'EXPIRED',
        expiredAt: new Date()
      }
    });

    // También expirar las recompensas asociadas
    await prisma.referralReward.updateMany({
      where: {
        status: 'PENDING',
        referral: {
          status: 'EXPIRED'
        }
      },
      data: {
        status: 'EXPIRED',
        expiresAt: new Date()
      }
    });

    if (result.count > 0) {
      console.log(`[ReferralService] ${result.count} referidos expirados`);
    }

    return { expired: result.count };
  }

  /**
   * Verifica indicadores de fraude potencial
   */
  static async checkFraudIndicators(referrerId: string, refereeEmail: string): Promise<FraudCheckResult> {
    const reasons: string[] = [];

    // 1. Verificar tasa de referidos (más de X en 24 horas)
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const recentReferrals = await prisma.referral.count({
      where: {
        referrerId,
        createdAt: { gte: oneDayAgo }
      }
    });

    if (recentReferrals >= REFERRAL_CONFIG.MAX_REFERRALS_PER_DAY) {
      reasons.push('TOO_MANY_REFERRALS_IN_24H');
    }

    // 2. Verificar dominio de email similar (excepto dominios comunes)
    const referrerUser = await prisma.user.findUnique({
      where: { id: referrerId },
      select: { email: true }
    });

    if (referrerUser) {
      const referrerDomain = referrerUser.email.split('@')[1]?.toLowerCase();
      const refereeDomain = refereeEmail.split('@')[1]?.toLowerCase();

      if (referrerDomain && refereeDomain && referrerDomain === refereeDomain) {
        // Solo es sospechoso si NO es un dominio común
        const isCommonDomain = REFERRAL_CONFIG.COMMON_EMAIL_DOMAINS.includes(referrerDomain);
        if (!isCommonDomain) {
          reasons.push('SAME_CORPORATE_EMAIL_DOMAIN');
        }
      }
    }

    // 3. Verificar patrón de emails secuenciales (user1@, user2@, user3@)
    const emailPrefix = refereeEmail.split('@')[0]?.toLowerCase();
    if (/^[a-z]+\d+$/.test(emailPrefix)) {
      // Verificar si hay otros referidos con patrón similar
      const referrerReferrals = await prisma.referral.findMany({
        where: { referrerId },
        select: { refereeEmail: true },
        take: 10
      });

      const sequentialPatternCount = referrerReferrals.filter(r => {
        const prefix = r.refereeEmail.split('@')[0]?.toLowerCase();
        return /^[a-z]+\d+$/.test(prefix);
      }).length;

      if (sequentialPatternCount >= 3) {
        reasons.push('SEQUENTIAL_EMAIL_PATTERN');
      }
    }

    return {
      suspicious: reasons.length > 0,
      reasons
    };
  }

  /**
   * Genera una cadena aleatoria
   */
  private static generateRandomString(length: number): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Sin I, O, 0, 1 para evitar confusión
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Enmascara un email para privacidad
   */
  private static maskEmail(email: string): string {
    const [user, domain] = email.split('@');
    if (!user || !domain) return '***@***.***';

    const maskedUser = user.charAt(0) + '***';
    const domainParts = domain.split('.');
    const maskedDomain = domainParts[0].charAt(0) + '***.' + domainParts.slice(1).join('.');

    return `${maskedUser}@${maskedDomain}`;
  }
}

export const referralService = new ReferralService();
