import { NotificationType, NotificationStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { userBucket } from '../lib/userBucket';
import { NotificationService, NotificationPayload } from './notificationService';

// ─────────────────────────────────────────────────────────────────────────
// Broadcast service — notificaciones masivas (re-engagement / anuncios).
// Reutiliza NotificationService.sendBroadcastChunk (motor Expo Push).
// ─────────────────────────────────────────────────────────────────────────

export type LifecycleSegment = 'never_activated' | 'dormant' | 'active';
// Segmentos de comportamiento adicionales (Agent API / capa semántica):
//  - budget_exceeded: ≥1 presupuesto vigente con spent > amount.
//  - trial_ending: suscripción TRIALING que vence dentro de trialEndingDays.
export type AudienceSegment = LifecycleSegment | 'budget_exceeded' | 'trial_ending';

export interface AudienceFilters {
  plans: string[];               // ['FREE','PREMIUM','PRO']
  platforms: string[];           // ['IOS','ANDROID'] (plataforma del DISPOSITIVO)
  country?: string;              // undefined o 'Todos' = todos los países
  segments: AudienceSegment[];   // combinados con OR
  dormantDays?: number;          // umbral "dormido", default 14
  trialEndingDays?: number;      // ventana de trial_ending, default 3
  type: string;                  // NotificationType (para opt-out)
  // Modo prueba / envío dirigido a un solo usuario. Ignora la segmentación y
  // envía SOLO a testUserId. testUserId lo inyecta el controller (admin o el
  // usuario resuelto desde targetEmail) — nunca lo manda crudo el cliente.
  test?: boolean;
  testUserId?: string;
  targetEmail?: string; // envío dirigido a un usuario específico por email
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
   *  - budget_exceeded: ≥1 presupuesto vigente (is_active, en período) con spent > amount.
   *  - trial_ending: suscripción TRIALING que vence dentro de trialEndingDays.
   */
  private static audienceBody(f: AudienceFilters, applyOptOut: boolean): { sql: string; params: any[] } {
    // Modo prueba: solo el admin. Ignora segmentos, planes, opt-out y país.
    // (Incluye el LEFT JOIN a preferences para que el SELECT de resolveAudience
    // pueda leer quietHours, aunque en test las ignoramos al enviar.)
    if (f.test && f.testUserId) {
      return {
        sql: `
          FROM users u
          JOIN user_devices d ON d."userId" = u.id AND d."isActive" = true
          LEFT JOIN notification_preferences np ON np."userId" = u.id
          WHERE u.id = $1
        `,
        params: [f.testUserId],
      };
    }

    const country = !f.country || f.country === 'Todos' ? 'ALL' : f.country;
    const params = [
      f.plans,                                 // $1
      f.platforms,                             // $2
      country,                                 // $3
      f.segments.includes('never_activated'),  // $4
      f.segments.includes('dormant'),          // $5
      f.segments.includes('active'),           // $6
      f.dormantDays ?? 14,                     // $7
      f.type,                                  // $8
      applyOptOut,                             // $9
      f.segments.includes('budget_exceeded'),  // $10
      f.segments.includes('trial_ending'),     // $11
      f.trialEndingDays ?? 3,                  // $12
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
          OR ($10::boolean AND EXISTS (
              SELECT 1 FROM budgets b
              WHERE b.user_id = u.id
                AND b.is_active = true
                AND b.start_date <= NOW() AND b.end_date >= NOW()
                AND b.spent > b.amount))
          OR ($11::boolean AND s.status::text = 'TRIALING'
              AND s."trialEndsAt" IS NOT NULL
              AND s."trialEndsAt" > NOW()
              AND s."trialEndsAt" <= NOW() + make_interval(days => $12::int))
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

  /**
   * Métricas de una campaña para medir su EFECTO:
   *  - Funnel descriptivo: expuestos → impresión → click.
   *  - Causal: % con ≥1 transacción en los 7 días posteriores al envío,
   *    comparando EXPUESTOS vs HOLDOUT (control que NO recibió el mensaje).
   * liftPts = puntos porcentuales que el mensaje sumó sobre el control.
   */
  static async campaignStats(broadcastId: string): Promise<{
    exposed: number; holdout: number; impressions: number; clicks: number;
    exposedTx: number; holdoutTx: number;
    exposedTxRate: number; holdoutTxRate: number; liftPts: number;
  }> {
    const rows = await prisma.$queryRawUnsafe<{
      exposed: number; holdout: number; impressions: number; clicks: number;
      exposed_tx: number; holdout_tx: number;
    }[]>(
      `
      WITH b AS (SELECT "sentAt" FROM broadcasts WHERE id = $1),
      cohort AS (
        SELECT nl."userId", nl.holdout, nl."impressedAt", nl."clickedAt"
        FROM notification_logs nl
        WHERE nl."broadcastId" = $1
      ),
      tx AS (
        SELECT DISTINCT c."userId"
        FROM cohort c
        JOIN transactions t ON t."userId" = c."userId"
        JOIN b ON true
        WHERE b."sentAt" IS NOT NULL
          AND t.date >= b."sentAt"
          AND t.date <= b."sentAt" + interval '7 days'
      )
      SELECT
        COUNT(*) FILTER (WHERE NOT holdout)::int AS exposed,
        COUNT(*) FILTER (WHERE holdout)::int AS holdout,
        COUNT(*) FILTER (WHERE NOT holdout AND "impressedAt" IS NOT NULL)::int AS impressions,
        COUNT(*) FILTER (WHERE NOT holdout AND "clickedAt" IS NOT NULL)::int AS clicks,
        COUNT(*) FILTER (WHERE NOT holdout AND "userId" IN (SELECT "userId" FROM tx))::int AS exposed_tx,
        COUNT(*) FILTER (WHERE holdout AND "userId" IN (SELECT "userId" FROM tx))::int AS holdout_tx
      FROM cohort
      `,
      broadcastId,
    );

    const r = rows[0] ?? { exposed: 0, holdout: 0, impressions: 0, clicks: 0, exposed_tx: 0, holdout_tx: 0 };
    const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0);
    const exposedTxRate = rate(Number(r.exposed_tx), Number(r.exposed));
    const holdoutTxRate = rate(Number(r.holdout_tx), Number(r.holdout));
    return {
      exposed: Number(r.exposed), holdout: Number(r.holdout),
      impressions: Number(r.impressions), clicks: Number(r.clicks),
      exposedTx: Number(r.exposed_tx), holdoutTx: Number(r.holdout_tx),
      exposedTxRate, holdoutTxRate,
      liftPts: Math.round((exposedTxRate - holdoutTxRate) * 100) / 100,
    };
  }

  /** Cuenta sin enviar: usuarios alcanzados + cuántos se excluyen por opt-out. */
  static async previewAudience(f: AudienceFilters): Promise<{ target: number; optedOut: number }> {
    if (!f.test && (!f.segments || f.segments.length === 0 || f.plans.length === 0 || f.platforms.length === 0)) {
      return { target: 0, optedOut: 0 };
    }
    if (f.test && !f.testUserId) {
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
    targetCount: number; holdoutCount: number; successCount: number; failureCount: number; suppressed: number;
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
      const isTest = filters.test === true;
      const surface = broadcast.surface ?? 'push';
      const holdoutPct = Math.max(0, Math.min(100, broadcast.holdoutPct ?? 0));
      const shouldPush = surface === 'push' || surface === 'both';
      const rows = await this.resolveAudience(filters);

      // Agrupar por usuario → tokens + quiet hours.
      const byUser = new Map<string, { tokens: string[]; qhStart: number | null; qhEnd: number | null }>();
      for (const r of rows) {
        const u = byUser.get(r.userId) ?? { tokens: [], qhStart: r.qhStart, qhEnd: r.qhEnd };
        u.tokens.push(r.token);
        byUser.set(r.userId, u);
      }
      const allUserIds = [...byUser.keys()];

      if (allUserIds.length === 0) {
        await prisma.broadcast.update({
          where: { id: broadcastId },
          data: { status: 'SENT', targetCount: 0, holdoutCount: 0, successCount: 0, failureCount: 0, sentAt: new Date() },
        });
        return { targetCount: 0, holdoutCount: 0, successCount: 0, failureCount: 0, suppressed: 0 };
      }

      // Split EXPUESTOS / HOLDOUT. El holdout (control) reusa userBucket namespaced
      // por broadcastId: NUNCA recibe el mensaje (ni push, ni slot, ni campanita);
      // existe solo como fila de medición para comparar el efecto. En modo prueba o
      // holdoutPct=0 no hay holdout.
      const exposedIds: string[] = [];
      const holdoutIds: string[] = [];
      for (const uid of allUserIds) {
        const inHoldout = !isTest && holdoutPct > 0 && userBucket(uid, broadcast.id) >= (100 - holdoutPct);
        (inHoldout ? holdoutIds : exposedIds).push(uid);
      }

      // Badge real (solo expuestos; excluye holdout/slot): 1 sola consulta.
      const unread = exposedIds.length > 0
        ? await prisma.notificationLog.groupBy({
            by: ['userId'],
            where: { userId: { in: exposedIds }, status: { not: 'READ' }, holdout: false, surface: { not: 'slot' } },
            _count: true,
          })
        : [];
      const unreadMap = new Map<string, number>();
      for (const r of unread) unreadMap.set(r.userId, typeof r._count === 'number' ? r._count : 0);

      const payload: NotificationPayload = {
        title: broadcast.title,
        body: broadcast.body,
        data: (broadcast.data as Record<string, string> | null) ?? undefined,
      };

      // Push solo a EXPUESTOS y solo si la superficie lo incluye. Quiet hours suprime
      // el push (el slot/campanita igual queda registrado).
      const suppressed = new Set<string>();
      let successCount = 0;
      let failureCount = 0;
      if (shouldPush) {
        const tokensByBadge = new Map<number, string[]>();
        for (const userId of exposedIds) {
          const info = byUser.get(userId)!;
          // En modo prueba ignoramos quiet hours para que el test siempre llegue.
          if (!isTest && isInQuietHours(info.qhStart, info.qhEnd)) {
            suppressed.add(userId);
            continue;
          }
          const badge = (unreadMap.get(userId) ?? 0) + 1;
          const arr = tokensByBadge.get(badge) ?? [];
          arr.push(...info.tokens);
          tokensByBadge.set(badge, arr);
        }
        for (const [badge, tokens] of tokensByBadge) {
          const res = await NotificationService.sendBroadcastChunk(tokens, payload, badge);
          successCount += res.successCount;
          failureCount += res.failureCount;
        }
      }

      // NotificationLog: una fila por usuario (medición + entrega).
      //  - Expuestos: surface de la campaña, holdout=false. SENT salvo push suprimido
      //    por quiet hours (PENDING). En 'slot' el row queda SENT (activo para el slot).
      //  - Holdout: surface de la campaña, holdout=true, PENDING, sin entrega.
      const now = new Date();
      const logRows = [
        ...exposedIds.map((uid) => ({
          userId: uid,
          type: broadcast.type,
          title: broadcast.title,
          body: broadcast.body,
          data: broadcast.data === null ? undefined : (broadcast.data as any),
          status: suppressed.has(uid) ? NotificationStatus.PENDING : NotificationStatus.SENT,
          sentAt: suppressed.has(uid) ? null : now,
          surface,
          holdout: false,
          broadcastId: broadcast.id,
        })),
        ...holdoutIds.map((uid) => ({
          userId: uid,
          type: broadcast.type,
          title: broadcast.title,
          body: broadcast.body,
          data: broadcast.data === null ? undefined : (broadcast.data as any),
          status: NotificationStatus.PENDING,
          sentAt: null,
          surface,
          holdout: true,
          broadcastId: broadcast.id,
        })),
      ];
      await prisma.notificationLog.createMany({ data: logRows });

      const finalStatus = shouldPush && successCount === 0 && failureCount > 0 ? 'FAILED' : 'SENT';
      await prisma.broadcast.update({
        where: { id: broadcastId },
        data: {
          status: finalStatus,
          targetCount: exposedIds.length,
          holdoutCount: holdoutIds.length,
          successCount,
          failureCount,
          sentAt: now,
        },
      });

      logger.log(
        `[Broadcast] ${broadcastId} (${surface}, holdout ${holdoutPct}%): ${exposedIds.length} expuestos, ${holdoutIds.length} holdout, ${successCount} ok, ${failureCount} fallos, ${suppressed.size} suprimidos por quiet hours`,
      );
      return { targetCount: exposedIds.length, holdoutCount: holdoutIds.length, successCount, failureCount, suppressed: suppressed.size };
    } catch (error) {
      // Si algo explota a mitad, dejamos rastro y marcamos FAILED para no dejarlo colgado en SENDING.
      logger.error(`[Broadcast] Error enviando ${broadcastId}:`, error);
      await prisma.broadcast.update({ where: { id: broadcastId }, data: { status: 'FAILED' } });
      throw error;
    }
  }
}
