import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { AdminService } from '../services/adminService';
import { BroadcastService } from '../services/broadcastService';
import { AGENT_SEGMENTS, getAgentSegment } from '../config/agentSegments';

// ─────────────────────────────────────────────────────────────────────────
// Agent API — endpoints que consume el agente de crecimiento (proyecto
// externo). Auth por x-agent-key (middleware agentApiKeyAuth). Principios:
//  - Solo lecturas agregadas (KPIs, conteos de segmentos). Nunca PII.
//  - Escritura únicamente de borradores PENDING_APPROVAL: el agente jamás
//    puede enviar (sendBroadcast exige status DRAFT, que solo un admin pone
//    al aprobar).
// ─────────────────────────────────────────────────────────────────────────

/** Identificador del agente en Broadcast.createdBy (no es un userId). */
export const AGENT_CREATED_BY = 'growth-agent';

const TITLE_MAX = 100;
const BODY_MAX = 200;
const RATIONALE_MAX = 1000;

function agentMaxDraftsPerDay(): number {
  const n = parseInt(process.env.AGENT_MAX_DRAFTS_PER_DAY ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

// GET /api/agent/kpis?from&to — KPIs estructurados del negocio.
// Compone AdminService.getPulse + getAcquisition (misma fuente que el
// dashboard admin — nada se recalcula aquí) + resultados de campañas
// (lift vs holdout) de los broadcasts enviados en el período.
export const getAgentKpis = async (req: Request, res: Response) => {
  try {
    const query = { from: req.query.from as string | undefined, to: req.query.to as string | undefined };

    const [pulse, acquisition] = await Promise.all([
      AdminService.getPulse(query),
      AdminService.getAcquisition(query),
    ]);

    // Campañas enviadas dentro del período (últimas 20) con su medición causal.
    const sentBroadcasts = await prisma.broadcast.findMany({
      where: { status: 'SENT', sentAt: { gte: pulse.period.from, lte: pulse.period.to } },
      orderBy: { sentAt: 'desc' },
      take: 20,
      select: { id: true, title: true, surface: true, sentAt: true, holdoutPct: true },
    });
    const campaigns = await Promise.all(
      sentBroadcasts.map(async (b) => {
        const stats = await BroadcastService.campaignStats(b.id);
        return {
          id: b.id,
          title: b.title,
          surface: b.surface,
          sent_at: b.sentAt,
          holdout_pct: b.holdoutPct,
          exposed: stats.exposed,
          holdout: stats.holdout,
          impressions: stats.impressions,
          clicks: stats.clicks,
          exposed_tx_rate_pct: stats.exposedTxRate,
          holdout_tx_rate_pct: stats.holdoutTxRate,
          lift_pts: stats.liftPts,
        };
      }),
    );

    return res.json({
      period: pulse.period,
      users: {
        total: pulse.totalUsers,
        new_registrations: pulse.newRegistrations,
        registration_change_pct: pulse.registrationChange,
        activated: pulse.activatedUsers,
      },
      engagement: {
        dau: pulse.dau,
        mau: pulse.mau,
        retention_d1_pct: pulse.retentionD1,
        retention_d7_pct: pulse.retentionD7,
        retention_d30_pct: pulse.retentionD30,
      },
      revenue: {
        mrr_usd: pulse.mrrEstimated,
        plan_distribution: pulse.planDistribution,
        churn_rate_pct: pulse.churnRate,
        free_to_paid_rate_pct: pulse.freeToPaidRate,
        trials: {
          active: pulse.trialsActive,
          started: pulse.trialsStarted,
          conversion_rate_pct: pulse.trialConversionRate,
        },
      },
      acquisition: {
        totals: {
          visitors: acquisition.kpis.pageViews,
          leads: acquisition.kpis.leads,
          registrations: acquisition.kpis.registrations,
          subscriptions: acquisition.kpis.subscriptions,
        },
        by_source: acquisition.bySource.map((s) => ({
          source: s.source,
          campaign: s.campaign,
          visitors: s.visitors,
          leads: s.leads,
          registrations: s.registrations,
          subscriptions: s.subscriptions,
          revenue_usd: s.revenue,
          cost_usd: s.costUSD,
          conversion_rate_pct: s.conversionRate,
          cac_usd: s.costUSD > 0 && s.registrations > 0
            ? Math.round((s.costUSD / s.registrations) * 100) / 100
            : null,
        })),
      },
      campaigns,
    });
  } catch (error) {
    logger.error('[AgentAPI] Error en getAgentKpis:', error);
    return res.status(500).json({ message: 'Error calculando KPIs', error: 'Internal server error' });
  }
};

// GET /api/agent/segments — catálogo de segmentos curados (capa semántica).
export const listAgentSegments = (_req: Request, res: Response) => {
  return res.json({
    segments: AGENT_SEGMENTS.map((s) => ({
      slug: s.slug,
      name: s.name,
      description: s.description,
      params: s.params,
    })),
  });
};

// GET /api/agent/segments/:slug?days=&plans=&platforms=&country= — evalúa un
// segmento. Devuelve SOLO conteos (previewAudience), nunca datos de usuarios.
export const evaluateAgentSegment = async (req: Request, res: Response) => {
  try {
    const segment = getAgentSegment(req.params.slug);
    if (!segment) {
      return res.status(404).json({
        message: `Segmento "${req.params.slug}" no existe`,
        error: 'Not found',
        available_slugs: AGENT_SEGMENTS.map((s) => s.slug),
      });
    }

    const params: Record<string, string | undefined> = {};
    for (const spec of segment.params) {
      const raw = req.query[spec.name];
      if (typeof raw === 'string') params[spec.name] = raw;
    }

    const filters = segment.buildFilters(params);
    const { target, optedOut } = await BroadcastService.previewAudience(filters);

    return res.json({
      slug: segment.slug,
      count: target,
      opted_out: optedOut,
      params_used: params,
      evaluated_at: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[AgentAPI] Error evaluando segmento:', error);
    return res.status(500).json({ message: 'Error evaluando segmento', error: 'Internal server error' });
  }
};

// POST /api/agent/campaigns — crea un borrador PENDING_APPROVAL.
// El flujo de aprobación: PENDING_APPROVAL → (admin aprueba) → DRAFT →
// (admin envía con confirm) → SENDING/SENT. El agente solo puede llegar
// hasta PENDING_APPROVAL; el lock de sendBroadcast exige DRAFT.
export const createAgentCampaignDraft = async (req: Request, res: Response) => {
  try {
    const { title, message, segment_slug, segment_params, rationale, surface, holdout_pct } = req.body ?? {};

    // Validación de contenido (mismos límites que los broadcasts del panel).
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ message: 'title requerido', error: 'Bad request' });
    }
    if (title.length > TITLE_MAX) {
      return res.status(400).json({ message: `title excede ${TITLE_MAX} caracteres`, error: 'Bad request' });
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ message: 'message requerido', error: 'Bad request' });
    }
    if (message.length > BODY_MAX) {
      return res.status(400).json({ message: `message excede ${BODY_MAX} caracteres`, error: 'Bad request' });
    }
    if (!rationale || typeof rationale !== 'string' || rationale.trim().length < 10) {
      return res.status(400).json({
        message: 'rationale requerido (mínimo 10 caracteres): explica por qué propones esta campaña, con datos',
        error: 'Bad request',
      });
    }

    // Segmento del catálogo (nunca filtros libres).
    const segment = getAgentSegment(String(segment_slug ?? ''));
    if (!segment) {
      return res.status(400).json({
        message: `segment_slug inválido. Disponibles: ${AGENT_SEGMENTS.map((s) => s.slug).join(', ')}`,
        error: 'Bad request',
      });
    }
    const params: Record<string, string | undefined> = {};
    if (segment_params && typeof segment_params === 'object') {
      for (const spec of segment.params) {
        const raw = (segment_params as Record<string, unknown>)[spec.name];
        if (raw !== undefined && raw !== null) params[spec.name] = String(raw);
      }
    }
    const audience = segment.buildFilters(params);

    // Guardarraíl: límite de borradores del agente por día (backend-side,
    // no depende del cliente).
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const draftsLast24h = await prisma.broadcast.count({
      where: { createdBy: AGENT_CREATED_BY, createdAt: { gte: dayAgo } },
    });
    const maxPerDay = agentMaxDraftsPerDay();
    if (draftsLast24h >= maxPerDay) {
      return res.status(429).json({
        message: `Límite alcanzado: máximo ${maxPerDay} borradores por día. Intenta mañana o pide a FinZen subir el límite.`,
        error: 'Too many requests',
      });
    }

    const surfaceValue = ['push', 'slot', 'both'].includes(surface) ? surface : 'push';
    const holdoutRaw = Math.floor(Number(holdout_pct));
    const holdoutPct = Number.isFinite(holdoutRaw) ? Math.max(0, Math.min(100, holdoutRaw)) : 10;

    const broadcast = await prisma.broadcast.create({
      data: {
        title: title.trim(),
        body: message.trim(),
        type: 'MARKETING',
        surface: surfaceValue,
        holdoutPct,
        audience: audience as object,
        status: 'PENDING_APPROVAL',
        createdBy: AGENT_CREATED_BY,
        data: {
          rationale: rationale.trim().slice(0, RATIONALE_MAX),
          segment_slug: segment.slug,
          segment_params: params,
          proposed_by: AGENT_CREATED_BY,
        },
      },
    });

    logger.log(`[AgentAPI] Borrador creado por el agente: ${broadcast.id} (segmento ${segment.slug})`);
    return res.status(201).json({
      id: broadcast.id,
      status: 'PENDING_APPROVAL',
      message: 'Borrador creado. Un humano debe aprobarlo en el panel de FinZen antes de cualquier envío.',
    });
  } catch (error) {
    logger.error('[AgentAPI] Error creando borrador:', error);
    return res.status(500).json({ message: 'Error creando borrador', error: 'Internal server error' });
  }
};
