import * as cron from 'node-cron';
import { ReferralService } from './referralService';
import { REFERRAL_CONFIG } from '../config/referralConfig';

/**
 * Scheduler para procesar expiración de referidos pendientes
 *
 * Se ejecuta diariamente para:
 * - Expirar referidos que no se convirtieron dentro del tiempo límite
 * - Limpiar recompensas asociadas a referidos expirados
 */
export class ReferralScheduler {
  private static isRunning: boolean = false;
  private static cronTask: cron.ScheduledTask | null = null;

  /**
   * Inicia el scheduler de expiración de referidos
   * Se ejecuta según la configuración (default: diariamente a las 2:00 AM UTC)
   */
  static startScheduler(): void {
    if (!REFERRAL_CONFIG.ENABLED) {
      console.log('[ReferralScheduler] Sistema de referidos deshabilitado - scheduler no iniciado');
      return;
    }

    if (this.isRunning) {
      console.log('[ReferralScheduler] Scheduler ya está ejecutándose');
      return;
    }

    console.log('[ReferralScheduler] Iniciando scheduler de expiración de referidos...');
    console.log(`[ReferralScheduler] Cron schedule: ${REFERRAL_CONFIG.EXPIRY_CRON_SCHEDULE}`);
    console.log(`[ReferralScheduler] Referidos expiran después de ${REFERRAL_CONFIG.EXPIRY_DAYS} días`);

    // Ejecutar según configuración
    this.cronTask = cron.schedule(REFERRAL_CONFIG.EXPIRY_CRON_SCHEDULE, async () => {
      console.log('[ReferralScheduler] Ejecutando procesamiento de expiración...');

      try {
        const result = await ReferralService.expirePendingReferrals();
        console.log(`[ReferralScheduler] Procesamiento completado: ${result.expired} referidos expirados`);
      } catch (error) {
        console.error('[ReferralScheduler] Error en ejecución del scheduler:', error);
      }
    });

    this.isRunning = true;
    console.log('[ReferralScheduler] Scheduler iniciado correctamente');

    // Opcional: Ejecutar una vez al inicio en desarrollo
    if (process.env.NODE_ENV === 'development') {
      console.log('[ReferralScheduler] Ejecutando verificación inicial (desarrollo)...');
      setTimeout(async () => {
        try {
          const result = await ReferralService.expirePendingReferrals();
          console.log(`[ReferralScheduler] Verificación inicial: ${result.expired} referidos expirados`);
        } catch (error) {
          console.error('[ReferralScheduler] Error en verificación inicial:', error);
        }
      }, 10000); // Esperar 10 segundos después del inicio
    }
  }

  /**
   * Detiene el scheduler
   */
  static stopScheduler(): void {
    if (!this.isRunning || !this.cronTask) {
      console.log('[ReferralScheduler] Scheduler no está ejecutándose');
      return;
    }

    this.cronTask.stop();
    this.cronTask = null;
    this.isRunning = false;
    console.log('[ReferralScheduler] Scheduler detenido');
  }

  /**
   * Ejecuta manualmente el procesamiento de expiración
   */
  static async runManual(): Promise<{ expired: number }> {
    console.log('[ReferralScheduler] Ejecutando procesamiento manual...');

    if (!REFERRAL_CONFIG.ENABLED) {
      console.log('[ReferralScheduler] Sistema de referidos deshabilitado');
      return { expired: 0 };
    }

    try {
      const result = await ReferralService.expirePendingReferrals();
      console.log(`[ReferralScheduler] Procesamiento manual completado: ${result.expired} referidos expirados`);
      return result;
    } catch (error) {
      console.error('[ReferralScheduler] Error en procesamiento manual:', error);
      throw error;
    }
  }

  /**
   * Obtiene el estado del scheduler
   */
  static getStatus(): {
    isRunning: boolean;
    enabled: boolean;
    nextExecution: string;
    schedule: string;
    expiryDays: number;
  } {
    return {
      isRunning: this.isRunning,
      enabled: REFERRAL_CONFIG.ENABLED,
      nextExecution: this.isRunning ? `Según cron: ${REFERRAL_CONFIG.EXPIRY_CRON_SCHEDULE}` : 'Detenido',
      schedule: REFERRAL_CONFIG.EXPIRY_CRON_SCHEDULE,
      expiryDays: REFERRAL_CONFIG.EXPIRY_DAYS
    };
  }
}

export default ReferralScheduler;
