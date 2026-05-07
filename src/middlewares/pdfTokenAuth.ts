import { Request, Response, NextFunction } from 'express';
import { ADMIN_EMAILS } from '../config/adminConfig';
import { validatePdfToken } from '../services/pdfTokenService';
import { logger } from '../utils/logger';

/**
 * Middleware de autenticación específica para rutas que Puppeteer consume
 * durante la generación del PDF.
 *
 * Lee `pdfToken` del query string. Si es válido y el email sigue en la
 * whitelist de admins, setea `req.user` con el shape estándar.
 *
 * Este middleware NO se aplica a las rutas admin normales — solo a las
 * rutas internas que el headless browser navega para renderizar el dashboard.
 */
export const authenticatePdfToken = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const token = req.query.pdfToken;

  if (typeof token !== 'string' || token.length === 0) {
    return res.status(401).json({
      error: 'Access denied',
      message: 'PDF token required',
    });
  }

  const data = validatePdfToken(token);
  if (!data) {
    return res.status(401).json({
      error: 'Access denied',
      message: 'Invalid or expired PDF token',
    });
  }

  // Sanity check: el email del token todavía es admin (por si lo removieron
  // de la whitelist entre que generó el token y lo está usando).
  if (!ADMIN_EMAILS.includes(data.adminEmail.toLowerCase())) {
    logger.warn(`[PdfTokenAuth] Token válido pero email ya no es admin: ${data.adminEmail}`);
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Admin access required',
    });
  }

  req.user = {
    id: data.adminUserId,
    email: data.adminEmail,
  };

  return next();
};
