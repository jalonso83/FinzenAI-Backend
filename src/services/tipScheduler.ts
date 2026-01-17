import * as cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { TipEngineService } from './tipEngineService';

import { logger } from '../utils/logger';

export class TipScheduler {
  private static isRunning: boolean = false;
  private static cronTask: cron.ScheduledTask | null = null;

  /**
   * Inicia el scheduler de tips financieros
   * Se ejecuta Martes y Viernes a las 10 AM UTC
   */
  static startScheduler(): void {
    if (this.isRunning) {
      logger.log('[TipScheduler] Scheduler ya está ejecutándose');
      return;
    }

    logger.log('[TipScheduler] 💡 Iniciando scheduler de tips financieros...');
    logger.log('[TipScheduler] 📅 Se ejecutará Martes y Viernes a las 10:00 AM UTC');

    // Ejecutar Martes (2) y Viernes (5) a las 10 AM UTC
    // Formato cron: minuto hora día-del-mes mes día-de-la-semana
    // 0 10 * * 2,5 = A las 10:00 AM, cualquier día del mes, cualquier mes, solo Martes y Viernes
    this.cronTask = cron.schedule('0 10 * * 2,5', async () => {
      logger.log('[TipScheduler] 🔄 Ejecutando envío de tips financieros...');

      try {
        await this.sendTipsToAllEligibleUsers();
      } catch (error) {
        logger.error('[TipScheduler] ❌ Error en ejecución del scheduler:', error);
      }
    });

    this.isRunning = true;
    logger.log('[TipScheduler] ✅ Scheduler iniciado correctamente');

    // Opcional: Ejecutar una vez al inicio para testing (solo en desarrollo)
    if (process.env.NODE_ENV === 'development' && process.env.TEST_TIP_SCHEDULER === 'true') {
      logger.log('[TipScheduler] 🧪 Ejecutando envío inicial (desarrollo)...');
      setTimeout(async () => {
        try {
          await this.sendTipsToAllEligibleUsers();
        } catch (error) {
          logger.error('[TipScheduler] ❌ Error en envío inicial:', error);
        }
      }, 20000); // Esperar 20 segundos después del inicio
    }
  }

  /**
   * Detiene el scheduler
   */
  static stopScheduler(): void {
    if (!this.isRunning || !this.cronTask) {
      logger.log('[TipScheduler] Scheduler no está ejecutándose');
      return;
    }

    this.cronTask.stop();
    this.cronTask = null;
    this.isRunning = false;
    logger.log('[TipScheduler] ⏹️ Scheduler detenido');
  }

  /**
   * Envía tips a todos los usuarios elegibles
   */
  static async sendTipsToAllEligibleUsers(): Promise<void> {
    logger.log('[TipScheduler] 🔍 Buscando usuarios PRO elegibles para tips...');

    try {
      // Obtener usuarios PRO con:
      // - Dispositivos activos
      // - Tips habilitados en preferencias
      // - Suscripción PRO activa
      const eligibleUsers = await prisma.user.findMany({
        where: {
          devices: {
            some: { isActive: true }
          },
          notificationPreferences: {
            tipsEnabled: true
          },
          subscription: {
            plan: 'PRO',
            status: { in: ['ACTIVE', 'TRIALING'] }
          }
        },
        select: { id: true, email: true }
      });

      logger.log(`[TipScheduler] 👥 ${eligibleUsers.length} usuarios PRO elegibles encontrados`);

      let tipsSent = 0;
      let tipsSkipped = 0;
      let tipsError = 0;

      // Procesar usuarios con delay para no saturar la API
      for (const user of eligibleUsers) {
        try {
          const result = await TipEngineService.generateAndSendTip(user.id);

          if (result.sent) {
            tipsSent++;
            logger.log(`[TipScheduler] ✅ Tip enviado a ${user.email}`);
          } else {
            tipsSkipped++;
            logger.log(`[TipScheduler] ⏭️ Tip omitido para ${user.email}: ${result.reason}`);
          }

          // Delay de 2 segundos entre usuarios para no saturar OpenAI
          await this.delay(2000);

        } catch (userError) {
          tipsError++;
          logger.error(`[TipScheduler] ❌ Error procesando usuario ${user.id}:`, userError);
        }
      }

      logger.log('[TipScheduler] ✅ Envío de tips completado:');
      logger.log(`   - Tips enviados: ${tipsSent}`);
      logger.log(`   - Tips omitidos: ${tipsSkipped}`);
      logger.log(`   - Errores: ${tipsError}`);

    } catch (error) {
      logger.error('[TipScheduler] ❌ Error obteniendo usuarios elegibles:', error);
      throw error;
    }
  }

  /**
   * Ejecuta manualmente el envío de tips (útil para testing)
   */
  static async runManual(): Promise<void> {
    logger.log('[TipScheduler] 🔧 Ejecutando envío manual de tips...');

    try {
      await this.sendTipsToAllEligibleUsers();
      logger.log('[TipScheduler] ✅ Envío manual completado');
    } catch (error) {
      logger.error('[TipScheduler] ❌ Error en envío manual:', error);
      throw error;
    }
  }

  /**
   * Envía tip a un usuario específico (útil para testing)
   */
  static async sendToUser(userId: string): Promise<{
    sent: boolean;
    reason: string;
    tip?: { title: string; content: string; category: string };
  }> {
    logger.log(`[TipScheduler] 🔍 Enviando tip a usuario ${userId}...`);
    return TipEngineService.generateAndSendTip(userId);
  }

  /**
   * Genera un tip de prueba sin enviarlo (útil para testing)
   */
  static async testTipGeneration(userId: string) {
    return TipEngineService.testForUser(userId);
  }

  /**
   * Helper para delay
   */
  private static delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Obtiene el estado del scheduler
   */
  static getStatus(): { isRunning: boolean; nextExecution: string; schedule: string } {
    return {
      isRunning: this.isRunning,
      nextExecution: this.isRunning ? 'Próximo Martes o Viernes a las 10:00 AM UTC' : 'Detenido',
      schedule: 'Martes y Viernes 10:00 AM UTC'
    };
  }
}
