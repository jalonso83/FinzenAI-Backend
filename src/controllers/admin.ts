import { Request, Response } from 'express';
import { AdminService } from '../services/adminService';
import { prisma } from '../lib/prisma';
import { sendVerificationEmailSafe } from './auth';
import { logger } from '../utils/logger';

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
