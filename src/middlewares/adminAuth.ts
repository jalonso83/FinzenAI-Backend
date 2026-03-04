import { Request, Response, NextFunction } from 'express';
import { authenticateToken } from './auth';
import { ADMIN_EMAILS } from '../config/adminConfig';
import { logger } from '../utils/logger';

/**
 * Admin authentication middleware
 * Chains authenticateToken then checks email against ADMIN_EMAILS whitelist
 */
export const authenticateAdmin = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  authenticateToken(req, res, () => {
    if (res.headersSent) return;

    const email = req.user?.email?.toLowerCase();
    if (!email || !ADMIN_EMAILS.includes(email)) {
      logger.warn(`Admin access denied for: ${email || 'unknown'}`);
      return res.status(403).json({
        message: 'Forbidden',
        error: 'Admin access required',
      });
    }

    return next();
  });
};
