import * as cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { TipEngineService } from './tipEngineService';
import { logger } from '../utils/logger';
import { isTargetLocalTime, isInQuietHours, getCurrentLocalTime, getTimezoneByCountry } from '../utils/timezone';

/**
 * Scheduler para tips financieros
 *
 * TIMEZONE-AWARE: Los usuarios reciben tips a las 10:00 AM
 * de su hora local, los martes y viernes de SU zona horaria.
 */
export class TipScheduler {
  private static isRunning: boolean = false;
  private static cronTask: cron.ScheduledTask | null = null;

  // Hora objetivo para enviar tips (10:00 AM hora local del usuario)
  private static readonly TARGET_HOUR = 10;
  private static readonly TARGET_MINUTE = 0;
  // Días de la semana para enviar tips (0=Domingo, 2=Martes, 5=Viernes)
  private static readonly TARGET_DAYS = [2, 5]; // Martes y Viernes

  /**
   * Inicia el scheduler de tips financieros
   * Se ejecuta cada hora para capturar usuarios cuyo martes/viernes local sea a las 10 AM
   */
  static startScheduler(): void {
    if (this.isRunning) {
      logger.log('[TipScheduler] Scheduler ya está ejecutándose');
      return;
    }

    logger.log('[TipScheduler] 💡 Iniciando scheduler de tips financieros...');
    logger.log('[TipScheduler] 📅 Se ejecutará cada hora - Timezone-aware: Martes y Viernes 10:00 AM hora local');

    // Ejecutar cada hora para capturar martes/viernes 10 AM en diferentes zonas horarias
    this.cronTask = cron.schedule('0 * * * *', async () => {
      logger.log('[TipScheduler] 🔄 Ejecutando envío de tips financieros (timezone-aware)...');

      try {
        await this.sendTipsToAllEligibleUsers(this.TARGET_HOUR, this.TARGET_MINUTE, this.TARGET_DAYS);
      } catch (error) {
        logger.error('[TipScheduler] ❌ Error en ejecución del scheduler:', error);
      }
    });

    this.isRunning = true;
    logger.log('[TipScheduler] ✅ Scheduler iniciado correctamente');

    // Opcional: Ejecutar una vez al inicio para testing (solo en desarrollo)
    if (process.env.NODE_ENV === 'development' && process.env.TEST_TIP_SCHEDULER === 'true') {
      logger.log('[TipScheduler] 🧪 Ejecutando envío inicial (desarrollo - sin filtro de hora/día)...');
      setTimeout(async () => {
        try {
          await this.sendTipsToAllEligibleUsers(-1, 0, []); // Sin filtros
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
   * Obtiene el día de la semana local para un país
   * @returns 0=Domingo, 1=Lunes, ..., 6=Sábado
   */
  private static getLocalDayOfWeek(country: string | null | undefined): number {
    const timezone = getTimezoneByCountry(country);
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
      });
      const dayStr = formatter.format(new Date());
      const dayMap: Record<string, number> = {
        'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6
      };
      return dayMap[dayStr] ?? new Date().getDay();
    } catch {
      return new Date().getDay();
    }
  }

  /**
   * Envía tips a todos los usuarios elegibles
   * Solo procesa usuarios cuya hora local y día de semana coincidan con los objetivos
   *
   * @param targetHour - Hora objetivo (0-23). -1 para ignorar filtro
   * @param targetMinute - Minuto objetivo (0-59)
   * @param targetDays - Días de la semana (0=Dom, 2=Mar, 5=Vie). Array vacío para ignorar filtro
   */
  static async sendTipsToAllEligibleUsers(
    targetHour: number = 10,
    targetMinute: number = 0,
    targetDays: number[] = [2, 5]
  ): Promise<void> {
    const skipTimeFilter = targetHour === -1;
    const skipDayFilter = targetDays.length === 0;

    logger.log(`[TipScheduler] 🔍 Buscando usuarios PRO elegibles para tips ${skipTimeFilter && skipDayFilter ? '(sin filtros)' : `en ${targetHour}:${targetMinute.toString().padStart(2, '0')} hora local, días ${targetDays.join(',')}`}...`);

    try {
      // Obtener usuarios PRO con:
      // - Dispositivos activos
      // - Tips habilitados en preferencias
      // - Suscripción PRO activa
      // - Incluir país y preferencias para timezone
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
        select: {
          id: true,
          email: true,
          country: true,
          notificationPreferences: {
            select: {
              quietHoursStart: true,
              quietHoursEnd: true
            }
          }
        }
      });

      logger.log(`[TipScheduler] 👥 ${eligibleUsers.length} usuarios PRO con tips habilitados`);

      let tipsSent = 0;
      let tipsSkipped = 0;
      let tipsError = 0;
      let usersInTargetTime = 0;

      // Procesar usuarios con delay para no saturar la API
      for (const user of eligibleUsers) {
        try {
          // Verificar día de la semana local del usuario
          if (!skipDayFilter) {
            const localDay = this.getLocalDayOfWeek(user.country);
            if (!targetDays.includes(localDay)) {
              continue; // No es martes ni viernes en la zona horaria del usuario
            }
          }

          // Verificar si es la hora correcta en la zona horaria del usuario
          if (!skipTimeFilter && !isTargetLocalTime(user.country, targetHour, targetMinute)) {
            continue; // No es la hora correcta para este usuario
          }

          usersInTargetTime++;

          // Verificar horario silencioso
          const prefs = user.notificationPreferences;
          if (prefs && isInQuietHours(user.country, prefs.quietHoursStart, prefs.quietHoursEnd)) {
            tipsSkipped++;
            continue;
          }

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
      logger.log(`   - Usuarios en hora/día objetivo: ${usersInTargetTime}`);
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
      nextExecution: this.isRunning ? 'Cada hora - Martes y Viernes 10:00 AM hora local del usuario' : 'Detenido',
      schedule: 'Timezone-aware: Martes y Viernes 10:00 AM hora local'
    };
  }
}
