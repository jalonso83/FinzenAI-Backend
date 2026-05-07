import { Request, Response, NextFunction } from 'express';
import { authenticateToken } from './auth';
import { authenticatePdfToken } from './pdfTokenAuth';
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

/**
 * Auth compuesta: si la request trae `?pdfToken=XYZ`, valida vía PDF token
 * (Puppeteer durante generación de PDF). En cualquier otro caso usa la auth
 * admin normal (cookie/JWT + whitelist).
 *
 * Esto permite que el dashboard interactivo siga usando su auth normal Y que
 * Puppeteer (sin cookies de sesión) pueda acceder a los endpoints admin con
 * un token efímero generado al iniciar la generación del PDF.
 */
export const authenticateAdminOrPdfToken = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const pdfToken = req.query.pdfToken;
  if (typeof pdfToken === 'string' && pdfToken.length > 0) {
    return authenticatePdfToken(req, res, next);
  }
  return authenticateAdmin(req, res, next);
};
