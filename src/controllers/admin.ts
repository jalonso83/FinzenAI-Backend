import { Request, Response } from 'express';
import { AdminService } from '../services/adminService';
import { prisma } from '../lib/prisma';
import { sendVerificationEmailSafe } from './auth';
import { logger } from '../utils/logger';
import { generateDashboardPdf as generateDashboardPdfService, PdfBusyError, PdfInvalidRangeError } from '../services/pdfReportService';

// Helper para sleep entre sends (throttling)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function handleError(res: Response, context: string, error: unknown) {
  const msg = error instanceof Error ? error.message : '';
  if (msg.startsWith('Invalid') || msg.includes('must be before')) {
    return res.status(400).json({ message: msg, error: 'Bad request' });
  }
  logger.error(`[Admin] Error in ${context}:`, error);
  return res.status(500).json({ message: `Error retrieving ${context}`, error: 'Internal server error' });
}

export const getPulse = async (req: Request, res: Response) => {
  try {
    const data = await AdminService.getPulse(req.query as any);
    return res.json({ message: 'Pulse data retrieved', data });
  } catch (error) {
    return handleError(res, 'pulse', error);
  }
};

export const getUsersAnalytics = async (req: Request, res: Response) => {
  try {
    const data = await AdminService.getUsersAnalytics(req.query as any);
    return res.json({ message: 'Users analytics retrieved', data });
  } catch (error) {
    return handleError(res, 'users analytics', error);
  }
};

export const getRevenueAnalytics = async (req: Request, res: Response) => {
  try {
    const data = await AdminService.getRevenueAnalytics(req.query as any);
    return res.json({ message: 'Revenue analytics retrieved', data });
  } catch (error) {
    return handleError(res, 'revenue analytics', error);
  }
};

export const getEngagement = async (req: Request, res: Response) => {
  try {
    const data = await AdminService.getEngagement(req.query as any);
    return res.json({ message: 'Engagement data retrieved', data });
  } catch (error) {
    return handleError(res, 'engagement', error);
  }
};

export const getAcquisition = async (req: Request, res: Response) => {
  try {
    const data = await AdminService.getAcquisition(req.query as any);
    return res.json({ message: 'Acquisition data retrieved', data });
  } catch (error) {
    return handleError(res, 'acquisition', error);
  }
};

export const getUnitEconomics = async (req: Request, res: Response) => {
  try {
    const data = await AdminService.getUnitEconomics(req.query as any);
    return res.json({ message: 'Unit economics retrieved', data });
  } catch (error) {
    return handleError(res, 'unit economics', error);
  }
};

export const getFinancialHealth = async (_req: Request, res: Response) => {
  try {
    const data = await AdminService.getFinancialHealth();
    return res.json({ message: 'Financial health retrieved', data });
  } catch (error) {
    return handleError(res, 'financial health', error);
  }
};

/**
 * Bulk resend de verification email a usuarios no verificados.
 *
 * Body opcional:
 *   - daysBack?: number — solo users registrados en los últimos N días (default: todos)
 *   - userIds?: string[] — lista específica de userIds a re-enviar
 *   - excludeBouncedDomains?: boolean — excluye dominios sospechosos (default: true)
 *   - throttleMs?: number — milisegundos entre sends (default: 500)
 *
 * Retorna:
 *   { totalCandidates, sent, failed, skipped, durationMs, failedEmails: [] }
 */
export const bulkResendVerification = async (req: Request, res: Response) => {
  try {
    const {
      daysBack,
      userIds,
      excludeBouncedDomains = true,
      throttleMs = 500,
    } = req.body || {};

    // Construir filtro
    const where: any = { verified: false };

    if (daysBack && typeof daysBack === 'number' && daysBack > 0) {
      const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
      where.createdAt = { gte: cutoff };
    }

    if (userIds && Array.isArray(userIds) && userIds.length > 0) {
      where.id = { in: userIds };
    }

    if (excludeBouncedDomains) {
      // Excluir dominios genéricos sospechosos (email.com, mail.com son reales pero
      // suelen rebotar porque la gente los usa como dummy)
      where.AND = [
        { email: { not: { endsWith: '@email.com' } } },
        { email: { not: { endsWith: '@mail.com' } } },
      ];
    }

    const candidates = await prisma.user.findMany({
      where,
      select: { id: true, email: true, name: true },
      orderBy: { createdAt: 'desc' },
    });

    if (candidates.length === 0) {
      return res.json({
        message: 'No unverified users found matching criteria',
        data: { totalCandidates: 0, sent: 0, failed: 0, skipped: 0, durationMs: 0, failedEmails: [] },
      });
    }

    const startTime = Date.now();
    let sent = 0;
    let failed = 0;
    const failedEmails: string[] = [];

    for (const user of candidates) {
      const ok = await sendVerificationEmailSafe(user.email, user.id, user.name || 'Usuario');
      if (ok) {
        sent++;
      } else {
        failed++;
        failedEmails.push(user.email);
      }
      // Throttle entre sends para no saturar Resend ni triggear rate limits
      if (throttleMs > 0) {
        await sleep(throttleMs);
      }
    }

    const durationMs = Date.now() - startTime;

    logger.log(`[Admin] Bulk resend verification completed: ${sent}/${candidates.length} sent in ${durationMs}ms`);

    return res.json({
      message: 'Bulk resend verification completed',
      data: {
        totalCandidates: candidates.length,
        sent,
        failed,
        skipped: 0,
        durationMs,
        failedEmails,
      },
    });
  } catch (error) {
    return handleError(res, 'bulk resend verification', error);
  }
};

export const getUsersList = async (req: Request, res: Response) => {
  try {
    const data = await AdminService.getUsersList(req.query as any);
    return res.json({ message: 'Users list retrieved', data });
  } catch (error) {
    return handleError(res, 'users list', error);
  }
};

export const getDistinctCountries = async (req: Request, res: Response) => {
  try {
    const data = await AdminService.getDistinctCountries();
    return res.json({ message: 'Countries retrieved', data });
  } catch (error) {
    return handleError(res, 'countries', error);
  }
};

/**
 * POST /api/admin/dashboard/pdf
 * Genera el PDF ejecutivo del dashboard. Lanza Puppeteer que renderiza la
 * landing en modo PDF, espera a que esté listo, y retorna el PDF binario.
 *
 * Query params:
 *  - range: '7d' | '14d' | '30d' | '90d' (default: '30d')
 *
 * Defensa: NO acepta pdfToken como auth (evita recursión accidental). Solo
 * admin con cookie/JWT puede gatillar la generación.
 */
export const generateDashboardPdf = async (req: Request, res: Response) => {
  try {
    // Defensa: este endpoint solo se invoca via auth admin normal, NO con pdfToken.
    if (req.query.pdfToken) {
      return res.status(403).json({
        message: 'Esta acción requiere auth admin directa, no pdfToken',
        error: 'Forbidden',
      });
    }

    const adminUser = req.user;
    if (!adminUser) {
      return res.status(401).json({ message: 'Unauthorized', error: 'Missing user' });
    }

    const range = (typeof req.query.range === 'string' ? req.query.range : '30d');

    const pdf = await generateDashboardPdfService({
      adminUserId: adminUser.id,
      adminEmail: adminUser.email,
      range,
    });

    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `finzen-reporte-${dateStr}-${range}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdf.length.toString());
    return res.end(pdf);
  } catch (error) {
    if (error instanceof PdfBusyError) {
      return res.status(429).json({
        message: 'Otro PDF se está generando. Intenta en 30 segundos.',
        error: 'PDF generation busy',
      });
    }
    if (error instanceof PdfInvalidRangeError) {
      return res.status(400).json({
        message: `Range inválido: ${(error as Error).message}. Valores válidos: 7d, 14d, 30d, 90d`,
        error: 'Bad request',
      });
    }
    return handleError(res, 'dashboard pdf', error);
  }
};

// ─── Campaign Costs ─────────────────────────────────────

export const getCampaignCosts = async (_req: Request, res: Response) => {
  try {
    const data = await AdminService.getCampaignCosts();
    return res.json({ message: 'Campaign costs retrieved', data });
  } catch (error) {
    return handleError(res, 'campaign costs', error);
  }
};

export const upsertCampaignCost = async (req: Request, res: Response) => {
  try {
    const { source, campaign, costUSD, notes } = req.body ?? {};
    if (typeof source !== 'string' || !source.trim()) {
      return res.status(400).json({ message: 'source es requerido', error: 'Bad request' });
    }
    if (typeof costUSD !== 'number' && typeof costUSD !== 'string') {
      return res.status(400).json({ message: 'costUSD es requerido', error: 'Bad request' });
    }
    const cost = typeof costUSD === 'string' ? parseFloat(costUSD) : costUSD;
    const data = await AdminService.upsertCampaignCost({
      source,
      campaign: campaign ?? '',
      costUSD: cost,
      notes,
    });
    return res.json({ message: 'Campaign cost saved', data });
  } catch (error) {
    return handleError(res, 'upsert campaign cost', error);
  }
};

export const deleteCampaignCost = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ message: 'id es requerido', error: 'Bad request' });
    }
    await AdminService.deleteCampaignCost(id);
    return res.json({ message: 'Campaign cost deleted' });
  } catch (error) {
    return handleError(res, 'delete campaign cost', error);
  }
};
