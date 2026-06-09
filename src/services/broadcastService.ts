import { NotificationType, NotificationStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { NotificationService, NotificationPayload } from './notificationService';

// ─────────────────────────────────────────────────────────────────────────
// Broadcast service — notificaciones masivas (re-engagement / anuncios).
// Reutiliza NotificationService.sendBroadcastChunk (motor Expo Push).
// ─────────────────────────────────────────────────────────────────────────

export type LifecycleSegment = 'never_activated' | 'dormant' | 'active';

export interface AudienceFilters {
  plans: string[];               // ['FREE','PREMIUM','PRO']
  platforms: string[];           // ['IOS','ANDROID'] (plataforma del DISPOSITIVO)
  country?: string;              // undefined o 'Todos' = todos los países
  segments: LifecycleSegment[];  // combinados con OR
  dormantDays?: number;          // umbral "dormido", default 14
  type: string;                  // NotificationType (para opt-out)
}

interface AudienceRow {
  userId: string;
  token: string;
  qhStart: number | null;
  qhEnd: number | null;
}

// Quiet hours: misma lógica que NotificationService.isInQuietHours.
function isInQuietHours(qhStart: number | null, qhEnd: number | null): boolean {
  if (qhStart == null || qhEnd == null) return false;
  const currentHour = new Date().getHours();
  if (qhStart > qhEnd) return currentHour >= qhStart || currentHour < qhEnd; // cruza medianoche
  return currentHour >= qhStart && currentHour < qhEnd;
}

export class BroadcastService {
  /**
   * Construye el FROM...WHERE compartido entre preview y resolve.
   * `applyOptOut=false` ignora los opt-outs (sirve para contar cuántos se excluyen).
   *
   * Segmentos (combinados con OR):
   *  - never_activated: 0 transacciones de por vida.
   *  - dormant: tiene ≥1 tx, pero su última actividad (gamification_events) es
   *    anterior al umbral, o nunca registró actividad.
   *  - active: tiene ≥1 tx y actividad dentro del umbral.
   */
  private static audienceBody(f: AudienceFilters, applyOptOut: boolean): { sql: string; params: any[] } {
    const country = !f.country || f.country === 'Todos' ? 'ALL' : f.country;
    const params = [
      f.plans,                                // $1
      f.platforms,                            // $2
      country,                                // $3
      f.segments.includes('never_activated'), // $4
      f.segments.includes('dormant'),         // $5
      f.segments.includes('active'),          // $6
      f.dormantDays ?? 14,                    // $7
      f.type,                                 // $8
      applyOptOut,                            // $9
    ];
    const sql = `
      FROM users u
      JOIN user_devices d ON d."userId" = u.id AND d."isActive" = true
      LEFT JOIN subscriptions s ON s."userId" = u.id
      LEFT JOIN notification_preferences np ON np."userId" = u.id
      LEFT JOIN (SELECT "userId", COUNT(*) AS tx_count FROM transactions GROUP BY "userId") tc
        ON tc."userId" = u.id
      LEFT JOIN (SELECT "userId", MAX("createdAt") AS last_at FROM gamification_events GROUP BY "userId") la
        ON la."userId" = u.id
      WHERE COALESCE(s.plan::text, 'FREE') = ANY($1::text[])
        AND d.platform::text = ANY($2::text[])
        AND ($3 = 'ALL' OR u.country = $3)
        AND (
          ($4::boolean AND COALESCE(tc.tx_count, 0) = 0)
          OR ($5::boolean AND COALESCE(tc.tx_count, 0) > 0
              AND (la.last_at IS NULL OR la.last_at < NOW() - make_interval(days => $7::int)))
          OR ($6::boolean AND COALESCE(tc.tx_count, 0) > 0
              AND la.last_at >= NOW() - make_interval(days => $7::int))
        )
        AND (
          NOT $9::boolean
          OR $8 = 'SYSTEM'
          OR ($8 = 'MARKETING' AND COALESCE(np."marketingEnabled", true))
          OR ($8 = 'ANNOUNCEMENT' AND COALESCE(np."announcementsEnabled", true))
        )
    `;
    return { sql, params };
  }

  /** Cuenta sin enviar: usuarios alcanzados + cuántos se excluyen por opt-out. */
  static async previewAudience(f: AudienceFilters): Promise<{ target: number; optedOut: number }> {
    if (!f.segments || f.segments.length === 0 || f.plans.length === 0 || f.platforms.length === 0) {
      return { target: 0, optedOut: 0 };
    }
    const withOptOut = this.audienceBody(f, true);
    const withoutOptOut = this.audienceBody(f, false);

    const [targetRows, allRows] = await Promise.all([
      prisma.$queryRawUnsafe<{ cnt: number }[]>(
        `SELECT COUNT(DISTINCT u.id)::int AS cnt ${withOptOut.sql}`, ...withOptOut.params,
      ),
      prisma.$queryRawUnsafe<{ cnt: number }[]>(
        `SELECT COUNT(DISTINCT u.id)::int AS cnt ${withoutOptOut.sql}`, ...withoutOptOut.params,
      ),
    ]);

    const target = Number(targetRows[0]?.cnt ?? 0);
    const all = Number(allRows[0]?.cnt ?? 0);
    return { target, optedOut: Math.max(0, all - target) };
  }

  /** Resuelve la audiencia real a enviar: una fila por (usuario, dispositivo activo). */
  private static async resolveAudience(f: AudienceFilters): Promise<AudienceRow[]> {
    const body = this.audienceBody(f, true);
    return prisma.$queryRawUnsafe<AudienceRow[]>(
      `SELECT u.id AS "userId", d."fcmToken" AS token,
              np."quietHoursStart" AS "qhStart", np."quietHoursEnd" AS "qhEnd"
       ${body.sql}`,
      ...body.params,
    );
  }

  /**
   * Envía un broadcast. Síncrono. Lock por status para evitar doble envío.
   * Respeta quiet hours (suprime el push pero igual deja la notificación en la
   * campanita). Badge real por usuario vía un solo groupBy.
   */
  static async sendBroadcast(broadcastId: string): Promise<{
    targetCount: number; successCount: number; failureCount: number; suppressed: number;
  }> {
    const broadcast = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
    if (!broadcast) throw new Error('Broadcast no encontrado');

    // Lock atómico: solo se puede enviar desde DRAFT.
    const lock = await prisma.broadcast.updateMany({
      where: { id: broadcastId, status: 'DRAFT' },
      data: { status: 'SENDING' },
    });
    if (lock.count === 0) {
      throw new Error('El broadcast no está en estado DRAFT (ya se envió o se está enviando)');
    }

    try {
      const filters: AudienceFilters = {
        ...(broadcast.audience as unknown as AudienceFilters),
        type: broadcast.type,
      };
      const rows = await this.resolveAudience(filters);

      // Agrupar por usuario → tokens + quiet hours.
      const byUser = new Map<string, { tokens: string[]; qhStart: number | null; qhEnd: number | null }>();
      for (const r of rows) {
        const u = byUser.get(r.userId) ?? { tokens: [], qhStart: r.qhStart, qhEnd: r.qhEnd };
        u.tokens.push(r.token);
        byUser.set(r.userId, u);
      }
      const userIds = [...byUser.keys()];

      if (userIds.length === 0) {
        await prisma.broadcast.update({
          where: { id: broadcastId },
          data: { status: 'SENT', targetCount: 0, successCount: 0, failureCount: 0, sentAt: new Date() },
        });
        return { targetCount: 0, successCount: 0, failureCount: 0, suppressed: 0 };
      }

      // Badge real: 1 sola consulta para toda la audiencia (no una por usuario).
      const unread = await prisma.notificationLog.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, status: { not: 'READ' } },
        _count: true,
      });
      const unreadMap = new Map<string, number>();
      for (const r of unread) unreadMap.set(r.userId, typeof r._count === 'number' ? r._count : 0);

      const payload: NotificationPayload = {
        title: broadcast.title,
        body: broadcast.body,
        data: (broadcast.data as Record<string, string> | null) ?? undefined,
      };

      // Separar push vs suprimidos por quiet hours, y agrupar tokens por badge.
      const suppressed = new Set<string>();
      const tokensByBadge = new Map<number, string[]>();
      for (const [userId, info] of byUser) {
        if (isInQuietHours(info.qhStart, info.qhEnd)) {
          suppressed.add(userId);
          continue;
        }
        const badge = (unreadMap.get(userId) ?? 0) + 1;
        const arr = tokensByBadge.get(badge) ?? [];
        arr.push(...info.tokens);
        tokensByBadge.set(badge, arr);
      }

      // Enviar: una llamada por valor de badge (reutiliza el batch de Expo).
      let successCount = 0;
      let failureCount = 0;
      for (const [badge, tokens] of tokensByBadge) {
        const res = await NotificationService.sendBroadcastChunk(tokens, payload, badge);
        successCount += res.successCount;
        failureCount += res.failureCount;
      }

      // Campanita: una fila por usuario (pusheado = SENT; suprimido = PENDING).
      const now = new Date();
      await prisma.notificationLog.createMany({
        data: userIds.map((uid) => ({
          userId: uid,
          type: broadcast.type,
          title: broadcast.title,
          body: broadcast.body,
          data: broadcast.data === null ? undefined : (broadcast.data as any),
          status: suppressed.has(uid) ? NotificationStatus.PENDING : NotificationStatus.SENT,
          sentAt: suppressed.has(uid) ? null : now,
          broadcastId: broadcast.id,
        })),
      });

      const finalStatus = successCount === 0 && failureCount > 0 ? 'FAILED' : 'SENT';
      await prisma.broadcast.update({
        where: { id: broadcastId },
        data: {
          status: finalStatus,
          targetCount: userIds.length,
          successCount,
          failureCount,
          sentAt: now,
        },
      });

      logger.log(
        `[Broadcast] ${broadcastId}: ${userIds.length} usuarios, ${successCount} ok, ${failureCount} fallos, ${suppressed.size} suprimidos por quiet hours`,
      );
      return { targetCount: userIds.length, successCount, failureCount, suppressed: suppressed.size };
    } catch (error) {
      // Si algo explota a mitad, dejamos rastro y marcamos FAILED para no dejarlo colgado en SENDING.
      logger.error(`[Broadcast] Error enviando ${broadcastId}:`, error);
      await prisma.broadcast.update({ where: { id: broadcastId }, data: { status: 'FAILED' } });
      throw error;
    }
  }
}
