/**
 * Configuración del Sistema de Referidos - FinZen AI
 *
 * =====================================================
 * PARA CAMBIAR LA ESTRATEGIA DE REFERIDOS:
 * =====================================================
 *
 * Opción 1: Editar este archivo directamente
 *   - Cambiar los valores por defecto
 *   - Reiniciar el servidor
 *
 * Opción 2: Variables de entorno (.env)
 *   - Agregar las variables correspondientes
 *   - Reiniciar el servidor
 *
 * Opción 3: Deshabilitar temporalmente
 *   - REFERRAL_ENABLED=false en .env
 *   - El sistema no procesará nuevos referidos
 *
 * =====================================================
 */

export interface ReferralConfigType {
  // Recompensas
  REFEREE_DISCOUNT_PERCENT: number;
  REFERRER_FREE_MONTHS: number;

  // Tiempos
  EXPIRY_DAYS: number;

  // Anti-fraude
  MAX_REFERRALS_PER_DAY: number;
  COMMON_EMAIL_DOMAINS: string[];

  // Stripe
  STRIPE_COUPON_ID: string;

  // Código de referido
  CODE_PREFIX: string;
  CODE_RANDOM_LENGTH: number;

  // Scheduler
  EXPIRY_CRON_SCHEDULE: string;

  // Feature flags
  ENABLED: boolean;
  FRAUD_CHECK_ENABLED: boolean;
}

export const REFERRAL_CONFIG: ReferralConfigType = {
  // ===================================================================
  // RECOMPENSAS
  // ===================================================================

  /**
   * Descuento para el REFERIDO (amigo nuevo)
   * El nuevo usuario obtiene este % de descuento en su primer mes
   *
   * Valores recomendados: 30-50%
   * Default: 50%
   */
  REFEREE_DISCOUNT_PERCENT: Number(process.env.REFERRAL_REFEREE_DISCOUNT) || 50,

  /**
   * Meses gratis para el REFERIDOR (quien invita)
   * Por cada amigo que pague, el referidor recibe este número de meses gratis
   *
   * Valores recomendados: 1-2 meses
   * Default: 1 mes
   */
  REFERRER_FREE_MONTHS: Number(process.env.REFERRAL_REFERRER_MONTHS) || 1,

  // ===================================================================
  // TIEMPOS
  // ===================================================================

  /**
   * Días para que el referido complete su primer pago
   * Si pasan estos días sin pago, el referido expira y no se da recompensa
   *
   * Valores recomendados: 14-30 días
   * Default: 30 días
   */
  EXPIRY_DAYS: Number(process.env.REFERRAL_EXPIRY_DAYS) || 30,

  // ===================================================================
  // ANTI-FRAUDE
  // ===================================================================

  /**
   * Máximo número de referidos que un usuario puede hacer en 24 horas
   * Previene abuso masivo del sistema
   *
   * Valores recomendados: 5-15
   * Default: 10
   */
  MAX_REFERRALS_PER_DAY: Number(process.env.REFERRAL_MAX_PER_DAY) || 10,

  /**
   * Dominios de email comunes que NO se consideran sospechosos
   * Si dos usuarios tienen emails del mismo dominio que NO está en esta lista,
   * se considera un indicador de posible fraude (emails corporativos iguales)
   */
  COMMON_EMAIL_DOMAINS: [
    'gmail.com',
    'yahoo.com',
    'hotmail.com',
    'outlook.com',
    'icloud.com',
    'live.com',
    'msn.com',
    'aol.com',
    'protonmail.com',
    'mail.com',
    'zoho.com',
    'yandex.com'
  ],

  // ===================================================================
  // STRIPE
  // ===================================================================

  /**
   * ID del cupón en Stripe para el descuento del referido
   * Se crea automáticamente si no existe
   *
   * Si cambias el porcentaje de descuento:
   * 1. Elimina el cupón existente en Stripe Dashboard
   * 2. El sistema creará uno nuevo con el nuevo porcentaje
   *
   * O simplemente cambia este ID para crear uno nuevo
   */
  STRIPE_COUPON_ID: process.env.REFERRAL_STRIPE_COUPON_ID || 'FINZEN_REFEREE_DISCOUNT',

  // ===================================================================
  // CÓDIGO DE REFERIDO
  // ===================================================================

  /**
   * Prefijo del código de referido
   * Ejemplo: FINZEN-JUAN-X7K9
   */
  CODE_PREFIX: process.env.REFERRAL_CODE_PREFIX || 'FINZEN',

  /**
   * Longitud de la parte aleatoria del código
   * Ejemplo con 4: FINZEN-JUAN-X7K9 (X7K9 = 4 caracteres)
   */
  CODE_RANDOM_LENGTH: 4,

  // ===================================================================
  // SCHEDULER
  // ===================================================================

  /**
   * Cron schedule para ejecutar expiración de referidos pendientes
   * Formato cron: "minuto hora día mes díaSemana"
   *
   * Default: "0 2 * * *" = Todos los días a las 2:00 AM UTC
   */
  EXPIRY_CRON_SCHEDULE: process.env.REFERRAL_EXPIRY_CRON || '0 2 * * *',

  // ===================================================================
  // FEATURE FLAGS
  // ===================================================================

  /**
   * Habilitar/deshabilitar el sistema de referidos completamente
   * Si está en false, las APIs retornan error y no se procesan referidos
   *
   * Útil para:
   * - Pausar promociones temporalmente
   * - Desactivar en ciertos entornos
   */
  ENABLED: process.env.REFERRAL_ENABLED !== 'false',

  /**
   * Habilitar/deshabilitar verificación anti-fraude
   * Si está en false, se permite cualquier referido sin verificación
   *
   * ⚠️ CUIDADO: Solo deshabilitar para testing
   */
  FRAUD_CHECK_ENABLED: process.env.REFERRAL_FRAUD_CHECK !== 'false',
};

/**
 * Obtiene la configuración actual de referidos
 * Usar esta función permite actualizaciones en tiempo real si se implementa
 * un sistema de configuración dinámica en el futuro
 */
export function getReferralConfig(): ReferralConfigType {
  return REFERRAL_CONFIG;
}

/**
 * Valida la configuración al iniciar el servidor
 * Lanza error si hay valores inválidos
 */
export function validateReferralConfig(): void {
  const config = REFERRAL_CONFIG;

  // Validar porcentaje de descuento
  if (config.REFEREE_DISCOUNT_PERCENT < 0 || config.REFEREE_DISCOUNT_PERCENT > 100) {
    throw new Error('[ReferralConfig] REFEREE_DISCOUNT_PERCENT debe estar entre 0 y 100');
  }

  // Validar meses gratis
  if (config.REFERRER_FREE_MONTHS < 0) {
    throw new Error('[ReferralConfig] REFERRER_FREE_MONTHS debe ser >= 0');
  }

  // Validar días de expiración
  if (config.EXPIRY_DAYS < 1) {
    throw new Error('[ReferralConfig] EXPIRY_DAYS debe ser >= 1');
  }

  // Validar máximo referidos por día
  if (config.MAX_REFERRALS_PER_DAY < 1) {
    throw new Error('[ReferralConfig] MAX_REFERRALS_PER_DAY debe ser >= 1');
  }

  // Validar longitud de código
  if (config.CODE_RANDOM_LENGTH < 2 || config.CODE_RANDOM_LENGTH > 10) {
    throw new Error('[ReferralConfig] CODE_RANDOM_LENGTH debe estar entre 2 y 10');
  }

  // Log de configuración
  console.log('[ReferralConfig] ✅ Configuración validada correctamente:');
  console.log(`  📊 Sistema habilitado: ${config.ENABLED ? 'Sí' : 'No'}`);
  console.log(`  🎁 Descuento referido: ${config.REFEREE_DISCOUNT_PERCENT}%`);
  console.log(`  🏆 Meses gratis referidor: ${config.REFERRER_FREE_MONTHS}`);
  console.log(`  ⏰ Días para expirar: ${config.EXPIRY_DAYS}`);
  console.log(`  🛡️ Anti-fraude: ${config.FRAUD_CHECK_ENABLED ? 'Activo' : 'Inactivo'}`);
  console.log(`  📝 Max referidos/día: ${config.MAX_REFERRALS_PER_DAY}`);
}

/**
 * Ejemplo de variables de entorno para .env:
 *
 * # Sistema de Referidos
 * REFERRAL_ENABLED=true
 * REFERRAL_REFEREE_DISCOUNT=50
 * REFERRAL_REFERRER_MONTHS=1
 * REFERRAL_EXPIRY_DAYS=30
 * REFERRAL_MAX_PER_DAY=10
 * REFERRAL_FRAUD_CHECK=true
 * REFERRAL_STRIPE_COUPON_ID=FINZEN_REFEREE_DISCOUNT
 * REFERRAL_CODE_PREFIX=FINZEN
 * REFERRAL_EXPIRY_CRON=0 2 * * *
 */
