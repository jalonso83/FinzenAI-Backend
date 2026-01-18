import { prisma } from '../lib/prisma';
import { NotificationService } from './notificationService';
import { subscriptionService } from './subscriptionService';
import { PLANS } from '../config/stripe';
import { logger } from '../utils/logger';

/**
 * Servicio de recordatorios diarios de presupuesto
 *
 * NIVEL 2 de alertas: Revisa todos los presupuestos y envía recordatorios
 * si están por encima del umbral configurado en las preferencias del usuario.
 *
 * Este es diferente al NIVEL 1 (checkBudgetAlerts) que se dispara
 * inmediatamente cuando una transacción cruza el umbral del presupuesto.
 */
export class BudgetReminderService {

  /**
   * Ejecuta el job diario de recordatorios de presupuesto
   * Debe ejecutarse una vez al día (ej: 9am)
   */
  static async runDailyReminders(): Promise<{
    usersProcessed: number;
    remindersSent: number;
    errors: string[];
  }> {
    const results = {
      usersProcessed: 0,
      remindersSent: 0,
      errors: [] as string[]
    };

    try {
      logger.log('[BudgetReminder] Iniciando job de recordatorios diarios...');

      // Obtener todos los usuarios con dispositivos activos y alertas habilitadas
      const usersWithPreferences = await prisma.notificationPreferences.findMany({
        where: {
          budgetAlertsEnabled: true,
          user: {
            devices: {
              some: {
                isActive: true
              }
            }
          }
        },
        include: {
          user: {
            select: {
              id: true,
              currency: true
            }
          }
        }
      });

      logger.log(`[BudgetReminder] Encontrados ${usersWithPreferences.length} usuarios con alertas habilitadas`);

      for (const prefs of usersWithPreferences) {
        try {
          const userId = prefs.userId;
          results.usersProcessed++;

          // Verificar que el usuario tenga acceso a alertas de presupuesto (PLUS o PRO)
          const subscription = await subscriptionService.getUserSubscription(userId);
          const planLimits = subscription.limits as { budgetAlerts?: boolean };
          const hasBudgetAlerts = planLimits.budgetAlerts ?? PLANS.FREE.limits.budgetAlerts;

          if (!hasBudgetAlerts) {
            continue; // Usuario FREE, saltar
          }

          // Verificar horario silencioso
          if (this.isInQuietHours(prefs)) {
            continue;
          }

          // Obtener presupuestos activos del usuario
          const now = new Date();
          const budgets = await prisma.budget.findMany({
            where: {
              user_id: userId,
              is_active: true,
              start_date: { lte: now },
              end_date: { gte: now }
            }
          });

          // Verificar cada presupuesto contra el umbral de preferencias
          const threshold = prefs.budgetAlertThreshold || 80;

          for (const budget of budgets) {
            const budgetAmount = Number(budget.amount);
            const spent = Number(budget.spent) || 0;
            const percentage = (spent / budgetAmount) * 100;

            // Si está por encima del umbral de preferencias
            if (percentage >= threshold) {
              // Verificar que no hayamos enviado recordatorio en las últimas 24h
              const recentReminder = await prisma.notificationLog.findFirst({
                where: {
                  userId,
                  type: 'BUDGET_ALERT',
                  createdAt: {
                    gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // últimas 24h
                  },
                  title: {
                    contains: budget.name
                  }
                }
              });

              if (recentReminder) {
                continue; // Ya enviamos recordatorio hoy
              }

              // Enviar recordatorio
              const currency = prefs.user?.currency || 'RD$';
              const remaining = budgetAmount - spent;

              await NotificationService.sendToUser(userId, 'BUDGET_ALERT', {
                title: `📊 Recordatorio: ${budget.name}`,
                body: percentage >= 100
                  ? `Tu presupuesto "${budget.name}" está excedido por ${currency}${Math.abs(remaining).toFixed(2)}`
                  : `Tu presupuesto "${budget.name}" está al ${Math.round(percentage)}%. Te quedan ${currency}${remaining.toFixed(2)}`,
                data: {
                  type: 'BUDGET_REMINDER',
                  budgetId: budget.id,
                  budgetName: budget.name,
                  percentage: Math.round(percentage).toString(),
                  screen: 'Budgets'
                }
              });

              results.remindersSent++;
              logger.log(`[BudgetReminder] Recordatorio enviado para ${budget.name} (${Math.round(percentage)}%)`);
            }
          }

        } catch (userError: any) {
          results.errors.push(`Usuario ${prefs.userId}: ${userError.message}`);
          logger.error(`[BudgetReminder] Error procesando usuario ${prefs.userId}:`, userError);
        }
      }

      logger.log(`[BudgetReminder] Job completado. Usuarios: ${results.usersProcessed}, Recordatorios: ${results.remindersSent}`);

    } catch (error: any) {
      results.errors.push(`Error general: ${error.message}`);
      logger.error('[BudgetReminder] Error en job diario:', error);
    }

    return results;
  }

  /**
   * Verifica si el usuario está en horario silencioso
   */
  private static isInQuietHours(preferences: any): boolean {
    if (!preferences.quietHoursStart || !preferences.quietHoursEnd) {
      return false;
    }

    const now = new Date();
    const currentHour = now.getHours();
    const start = preferences.quietHoursStart;
    const end = preferences.quietHoursEnd;

    // Maneja el caso cuando el período cruza la medianoche
    if (start > end) {
      return currentHour >= start || currentHour < end;
    }
    return currentHour >= start && currentHour < end;
  }
}

export default BudgetReminderService;
