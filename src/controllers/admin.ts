import { Request, Response } from 'express';
import { AdminService } from '../services/adminService';
import { logger } from '../utils/logger';

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
