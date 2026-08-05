import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { NotificationService } from './notificationService';
import { NotificationType } from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────────
// Avisos de cobro fallido — compartidos entre Stripe (web) y RevenueCat (IAP).
//
// Los dos canales tienen la misma ventana de recuperación (~2 semanas en Stripe,
// 16 días de periodo de gracia en Apple) y el mismo desenlace: si nunca se cobra,
// la suscripción se cancela y el usuario baja a FREE. Lo único que cambia es
// cuántas veces avisa cada proveedor:
//   - Stripe dispara el webhook en CADA reintento (hasta 8). De ahí el registro
//     en subscriptions.pastDueNotificationsSent, que evita 8 pushes idénticos.
//   - RevenueCat manda un único BILLING_ISSUE_DETECTED. El registro igual sirve,
//     porque el webhook se puede reentregar.
// ─────────────────────────────────────────────────────────────────────────

export type PastDueNotice = 'FIRST' | 'FINAL';

/**
 * Envía el aviso una sola vez por ciclo de impago. Best-effort: si falla el push
 * no se rompe el webhook — lo importante (registrar el pago y marcar el estado)
 * ya ocurrió antes de llegar aquí.
 */
export async function sendPastDueNotice(
  userId: string,
  notice: PastDueNotice,
  title: string,
  body: string,
): Promise<void> {
  try {
    const sub = await prisma.subscription.findUnique({
      where: { userId },
      select: { pastDueNotificationsSent: true },
    });
    const sent = (sub?.pastDueNotificationsSent as string[]) ?? [];
    if (sent.includes(notice)) return;

    await NotificationService.sendToUser(userId, NotificationType.SUBSCRIPTION_PAST_DUE, {
      title,
      body,
      data: { screen: 'Subscriptions' },
    });

    await prisma.subscription.update({
      where: { userId },
      data: { pastDueNotificationsSent: [...sent, notice] },
    });
    logger.log(`[PastDue] Aviso ${notice} enviado a ${userId}`);
  } catch (err) {
    logger.error(`[PastDue] No se pudo enviar el aviso ${notice} a ${userId}:`, err);
  }
}

/** Avisa que el plan ya cambió a Gratis. Sin registro: es un evento único. */
export async function notifyDowngradedToFree(userId: string): Promise<void> {
  try {
    await NotificationService.sendToUser(userId, NotificationType.SUBSCRIPTION_PAST_DUE, {
      title: 'Tu plan cambió a Gratis',
      body: 'Tu suscripción terminó. Puedes reactivarla cuando quieras desde la app.',
      data: { screen: 'Subscriptions' },
    });
  } catch (err) {
    logger.error(`[PastDue] No se pudo avisar el cambio a Gratis a ${userId}:`, err);
  }
}

/** El pago se recuperó: limpia los avisos para que un impago futuro vuelva a avisar. */
export async function clearPastDueNotices(userId: string): Promise<void> {
  try {
    await prisma.subscription.update({
      where: { userId },
      data: { pastDueNotificationsSent: [] },
    });
  } catch { /* best-effort: no romper el webhook por limpiar un contador */ }
}
