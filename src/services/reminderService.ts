import { PaymentType, PaymentReminder } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { NotificationService, NotificationPayload } from './notificationService';

import { logger } from '../utils/logger';
// Tipos para el servicio
export interface CreateReminderInput {
  name: string;
  type: PaymentType;
  dueDay: number;
  cutoffDay?: number;
  amount?: number;
  currency?: string;
  creditLimit?: number;
  isDualCurrency?: boolean;
  creditLimitUSD?: number;
  reminderDays?: number[];
  notifyOnCutoff?: boolean;
  notes?: string;
}

export interface UpdateReminderInput {
  name?: string;
  type?: PaymentType;
  dueDay?: number;
  cutoffDay?: number | null;
  amount?: number | null;
  currency?: string;
  creditLimit?: number | null;
  isDualCurrency?: boolean;
  creditLimitUSD?: number | null;
  reminderDays?: number[];
  notifyOnCutoff?: boolean;
  notes?: string | null;
  isActive?: boolean;
}

export interface UpcomingPayment {
  id: string;
  name: string;
  type: PaymentType;
  dueDate: Date;
  daysUntilDue: number;
  amount: number | null;
  currency: string;
  isOverdue: boolean;
  cutoffDate?: Date;
  daysUntilCutoff?: number;
}

// Mapeo de tipos de pago a iconos/labels
export const PAYMENT_TYPE_INFO: Record<PaymentType, { label: string; icon: string }> = {
  CREDIT_CARD: { label: 'Tarjeta de Crédito', icon: '💳' },
  LOAN: { label: 'Préstamo', icon: '🏦' },
  MORTGAGE: { label: 'Hipoteca', icon: '🏠' },
  UTILITY: { label: 'Servicios', icon: '💡' },
  INSURANCE: { label: 'Seguro', icon: '🛡️' },
  SUBSCRIPTION: { label: 'Suscripción', icon: '📱' },
  OTHER: { label: 'Otro', icon: '📋' }
};

export class ReminderService {

  /**
   * Crea un nuevo recordatorio de pago
   */
  static async createReminder(
    userId: string,
    input: CreateReminderInput
  ): Promise<PaymentReminder> {
    // Validar día del mes
    if (input.dueDay < 1 || input.dueDay > 31) {
      throw new Error('El día de pago debe estar entre 1 y 31');
    }

    if (input.cutoffDay !== undefined && (input.cutoffDay < 1 || input.cutoffDay > 31)) {
      throw new Error('El día de corte debe estar entre 1 y 31');
    }

    // Validar reminderDays
    if (input.reminderDays) {
      for (const day of input.reminderDays) {
        if (day < 0 || day > 30) {
          throw new Error('Los días de recordatorio deben estar entre 0 y 30');
        }
      }
    }

    const reminder = await prisma.paymentReminder.create({
      data: {
        userId,
        name: input.name,
        type: input.type,
        dueDay: input.dueDay,
        cutoffDay: input.cutoffDay,
        amount: input.amount,
        currency: input.currency || 'DOP',
        creditLimit: input.creditLimit,
        isDualCurrency: input.isDualCurrency || false,
        creditLimitUSD: input.creditLimitUSD,
        reminderDays: input.reminderDays || [3, 1, 0],
        notifyOnCutoff: input.notifyOnCutoff || false,
        notes: input.notes
      }
    });

    logger.log(`[ReminderService] Created reminder "${reminder.name}" for user ${userId}`);
    return reminder;
  }

  /**
   * Actualiza un recordatorio existente
   */
  static async updateReminder(
    reminderId: string,
    userId: string,
    input: UpdateReminderInput
  ): Promise<PaymentReminder> {
    // Verificar que el recordatorio pertenece al usuario
    const existing = await prisma.paymentReminder.findFirst({
      where: { id: reminderId, userId }
    });

    if (!existing) {
      throw new Error('Recordatorio no encontrado');
    }

    // Validaciones
    if (input.dueDay !== undefined && (input.dueDay < 1 || input.dueDay > 31)) {
      throw new Error('El día de pago debe estar entre 1 y 31');
    }

    if (input.cutoffDay !== undefined && input.cutoffDay !== null && (input.cutoffDay < 1 || input.cutoffDay > 31)) {
      throw new Error('El día de corte debe estar entre 1 y 31');
    }

    const reminder = await prisma.paymentReminder.update({
      where: { id: reminderId },
      data: input
    });

    logger.log(`[ReminderService] Updated reminder "${reminder.name}"`);
    return reminder;
  }

  /**
   * Elimina un recordatorio
   */
  static async deleteReminder(reminderId: string, userId: string): Promise<boolean> {
    const existing = await prisma.paymentReminder.findFirst({
      where: { id: reminderId, userId }
    });

    if (!existing) {
      throw new Error('Recordatorio no encontrado');
    }

    await prisma.paymentReminder.delete({
      where: { id: reminderId }
    });

    logger.log(`[ReminderService] Deleted reminder "${existing.name}"`);
    return true;
  }

  /**
   * Obtiene todos los recordatorios de un usuario
   */
  static async getReminders(
    userId: string,
    activeOnly: boolean = true
  ): Promise<PaymentReminder[]> {
    return prisma.paymentReminder.findMany({
      where: {
        userId,
        ...(activeOnly && { isActive: true })
      },
      orderBy: { dueDay: 'asc' }
    });
  }

  /**
   * Obtiene un recordatorio por ID
   */
  static async getReminderById(
    reminderId: string,
    userId: string
  ): Promise<PaymentReminder | null> {
    return prisma.paymentReminder.findFirst({
      where: { id: reminderId, userId }
    });
  }

  /**
   * Cuenta los recordatorios activos de un usuario
   * Usado para validar límites de plan
   */
  static async countActiveReminders(userId: string): Promise<number> {
    return prisma.paymentReminder.count({
      where: {
        userId,
        isActive: true
      }
    });
  }

  /**
   * Calcula la próxima fecha de vencimiento para un día dado
   */
  static getNextDueDate(dueDay: number, referenceDate: Date = new Date()): Date {
    const today = new Date(referenceDate);
    today.setHours(0, 0, 0, 0);

    const currentDay = today.getDate();
    const currentMonth = today.getMonth();
    const currentYear = today.getFullYear();

    let nextDueDate: Date;

    if (currentDay <= dueDay) {
      // El día de pago está en este mes
      nextDueDate = new Date(currentYear, currentMonth, dueDay);
    } else {
      // El día de pago ya pasó, calcular para el próximo mes
      nextDueDate = new Date(currentYear, currentMonth + 1, dueDay);
    }

    // Ajustar para meses con menos días (ej: febrero 30 -> febrero 28)
    const lastDayOfMonth = new Date(nextDueDate.getFullYear(), nextDueDate.getMonth() + 1, 0).getDate();
    if (dueDay > lastDayOfMonth) {
      nextDueDate.setDate(lastDayOfMonth);
    }

    return nextDueDate;
  }

  /**
   * Calcula los días hasta una fecha
   */
  static getDaysUntil(targetDate: Date, referenceDate: Date = new Date()): number {
    const today = new Date(referenceDate);
    today.setHours(0, 0, 0, 0);

    const target = new Date(targetDate);
    target.setHours(0, 0, 0, 0);

    const diffTime = target.getTime() - today.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  /**
   * Obtiene los próximos pagos de un usuario
   */
  static async getUpcomingPayments(
    userId: string,
    daysAhead: number = 30
  ): Promise<UpcomingPayment[]> {
    const reminders = await this.getReminders(userId, true);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const upcoming: UpcomingPayment[] = [];

    for (const reminder of reminders) {
      const dueDate = this.getNextDueDate(reminder.dueDay, today);
      const daysUntilDue = this.getDaysUntil(dueDate, today);

      // Solo incluir si está dentro del rango solicitado
      if (daysUntilDue <= daysAhead) {
        const payment: UpcomingPayment = {
          id: reminder.id,
          name: reminder.name,
          type: reminder.type,
          dueDate,
          daysUntilDue,
          amount: reminder.amount ? Number(reminder.amount) : null,
          currency: reminder.currency,
          isOverdue: daysUntilDue < 0
        };

        // Calcular fecha de corte si aplica
        if (reminder.cutoffDay) {
          const cutoffDate = this.getNextDueDate(reminder.cutoffDay, today);
          payment.cutoffDate = cutoffDate;
          payment.daysUntilCutoff = this.getDaysUntil(cutoffDate, today);
        }

        upcoming.push(payment);
      }
    }

    // Ordenar por días hasta vencimiento (vencidos primero, luego más cercanos)
    return upcoming.sort((a, b) => a.daysUntilDue - b.daysUntilDue);
  }

  /**
   * Procesa y envía notificaciones de recordatorios de pago
   * Este método debe ser llamado por el scheduler diariamente
   */
  static async processPaymentReminders(): Promise<{
    processed: number;
    notificationsSent: number;
    errors: string[];
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentDay = today.getDate();

    logger.log(`[ReminderService] Processing payment reminders for day ${currentDay}`);

    // Obtener todos los recordatorios activos
    const reminders = await prisma.paymentReminder.findMany({
      where: { isActive: true },
      include: {
        user: {
          select: { id: true, currency: true }
        }
      }
    });

    let processed = 0;
    let notificationsSent = 0;
    const errors: string[] = [];

    for (const reminder of reminders) {
      try {
        processed++;
        const dueDate = this.getNextDueDate(reminder.dueDay, today);
        const daysUntilDue = this.getDaysUntil(dueDate, today);

        // Verificar si hoy corresponde enviar notificación
        const shouldNotify = reminder.reminderDays.includes(daysUntilDue);

        // Verificar si ya se notificó hoy
        const alreadyNotifiedToday = reminder.lastNotifiedAt &&
          reminder.lastNotifiedAt.toDateString() === today.toDateString();

        if (shouldNotify && !alreadyNotifiedToday) {
          const sent = await this.sendPaymentReminder(reminder, daysUntilDue, dueDate);
          if (sent) {
            notificationsSent++;

            // Actualizar fecha de última notificación
            await prisma.paymentReminder.update({
              where: { id: reminder.id },
              data: {
                lastNotifiedAt: today,
                lastDueDate: dueDate
              }
            });
          }
        }

        // Notificar en día de corte si está habilitado
        if (reminder.notifyOnCutoff && reminder.cutoffDay) {
          const cutoffDate = this.getNextDueDate(reminder.cutoffDay, today);
          const daysUntilCutoff = this.getDaysUntil(cutoffDate, today);

          if (daysUntilCutoff === 0) {
            await this.sendCutoffReminder(reminder, cutoffDate);
            notificationsSent++;
          }
        }

      } catch (error: any) {
        logger.error(`[ReminderService] Error processing reminder ${reminder.id}:`, error);
        errors.push(`Reminder ${reminder.id}: ${error.message}`);
      }
    }

    logger.log(`[ReminderService] Processed ${processed} reminders, sent ${notificationsSent} notifications`);
    return { processed, notificationsSent, errors };
  }

  /**
   * Envía notificación de recordatorio de pago
   */
  private static async sendPaymentReminder(
    reminder: PaymentReminder,
    daysUntilDue: number,
    dueDate: Date
  ): Promise<boolean> {
    const typeInfo = PAYMENT_TYPE_INFO[reminder.type];
    const formattedDate = dueDate.toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'long'
    });

    let title: string;
    let body: string;
    let notificationType: 'PAYMENT_REMINDER' | 'PAYMENT_DUE_TODAY' | 'PAYMENT_OVERDUE';

    if (daysUntilDue < 0) {
      // Pago vencido
      notificationType = 'PAYMENT_OVERDUE';
      title = `🚨 Pago vencido: ${reminder.name}`;
      body = `Tu pago de ${typeInfo.label.toLowerCase()} venció hace ${Math.abs(daysUntilDue) === 1 ? '1 día' : `${Math.abs(daysUntilDue)} días`}`;
    } else if (daysUntilDue === 0) {
      // Vence hoy
      notificationType = 'PAYMENT_DUE_TODAY';
      title = `⏰ ¡Hoy vence! ${reminder.name}`;
      body = reminder.amount
        ? `Recuerda pagar ${reminder.currency}${Number(reminder.amount).toLocaleString()} hoy`
        : `No olvides realizar tu pago de ${typeInfo.label.toLowerCase()} hoy`;
    } else {
      // Recordatorio anticipado
      notificationType = 'PAYMENT_REMINDER';
      title = `${typeInfo.icon} Recordatorio: ${reminder.name}`;
      body = daysUntilDue === 1
        ? `Tu pago vence mañana (${formattedDate})`
        : `Tu pago vence en ${daysUntilDue} días (${formattedDate})`;

      if (reminder.amount) {
        body += ` - ${reminder.currency}${Number(reminder.amount).toLocaleString()}`;
      }
    }

    const payload: NotificationPayload = {
      title,
      body,
      data: {
        type: notificationType,
        reminderId: reminder.id,
        reminderName: reminder.name,
        daysUntilDue: daysUntilDue.toString(),
        screen: 'Reminders'
      }
    };

    const result = await NotificationService.sendToUser(
      reminder.userId,
      notificationType,
      payload
    );

    return result.success;
  }

  /**
   * Envía notificación de día de corte
   */
  private static async sendCutoffReminder(
    reminder: PaymentReminder,
    cutoffDate: Date
  ): Promise<boolean> {
    const typeInfo = PAYMENT_TYPE_INFO[reminder.type];

    const payload: NotificationPayload = {
      title: `📅 Día de corte: ${reminder.name}`,
      body: `Hoy es el día de corte de tu ${typeInfo.label.toLowerCase()}. Los gastos de hoy contarán para el próximo período.`,
      data: {
        type: 'PAYMENT_REMINDER',
        reminderId: reminder.id,
        reminderName: reminder.name,
        isCutoffDay: 'true',
        screen: 'Reminders'
      }
    };

    const result = await NotificationService.sendToUser(
      reminder.userId,
      'PAYMENT_REMINDER',
      payload
    );

    return result.success;
  }

  /**
   * Obtiene estadísticas de recordatorios de un usuario
   */
  static async getReminderStats(userId: string): Promise<{
    totalReminders: number;
    activeReminders: number;
    totalMonthlyAmount: number;
    upcomingThisWeek: number;
    byType: Record<PaymentType, number>;
  }> {
    // Obtener todos los recordatorios del usuario
    const allReminders = await prisma.paymentReminder.findMany({
      where: { userId }
    });

    // Obtener recordatorios activos
    const activeReminders = allReminders.filter(r => r.isActive);

    // Calcular total mensual (suma de montos de recordatorios activos)
    const totalMonthlyAmount = activeReminders.reduce((sum, reminder) => {
      return sum + (reminder.amount ? Number(reminder.amount) : 0);
    }, 0);

    // Obtener pagos próximos esta semana
    const upcomingPayments = await this.getUpcomingPayments(userId, 7);
    const upcomingThisWeek = upcomingPayments.filter(p => !p.isOverdue).length;

    // Contar por tipo
    const byType: Record<PaymentType, number> = {
      CREDIT_CARD: 0,
      LOAN: 0,
      MORTGAGE: 0,
      UTILITY: 0,
      INSURANCE: 0,
      SUBSCRIPTION: 0,
      OTHER: 0
    };

    for (const reminder of activeReminders) {
      byType[reminder.type]++;
    }

    return {
      totalReminders: allReminders.length,
      activeReminders: activeReminders.length,
      totalMonthlyAmount,
      upcomingThisWeek,
      byType
    };
  }
}

export default ReminderService;
