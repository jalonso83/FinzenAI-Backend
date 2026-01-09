import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { logger } from '../utils/logger';

/**
 * Rate Limiting Configuration
 * Protege contra ataques de fuerza bruta, spam y abuso de recursos
 *
 * NOTA: Usamos validate: false para IPv6 ya que Railway/proxy maneja
 * las IPs correctamente con trust proxy habilitado en Express.
 */

// Handler personalizado cuando se excede el límite
const rateLimitHandler = (req: Request, res: Response) => {
  logger.warn(`[RateLimit] IP bloqueada: ${req.ip} en ${req.path}`);
  return res.status(429).json({
    error: 'Too Many Requests',
    message: 'Demasiadas solicitudes. Por favor, intenta más tarde.',
    retryAfter: res.getHeader('Retry-After'),
  });
};

// ============================================
// LIMITADORES ESPECÍFICOS POR FUNCIONALIDAD
// ============================================

/**
 * Login Limiter - Protege contra fuerza bruta de contraseñas
 * 5 intentos cada 15 minutos por IP
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // 5 intentos
  message: {
    error: 'Too Many Requests',
    message: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.',
  },
  standardHeaders: true, // Incluye `RateLimit-*` headers
  legacyHeaders: false, // Deshabilita `X-RateLimit-*` headers antiguos
  handler: rateLimitHandler,
  skipFailedRequests: false, // Cuenta todos los intentos, exitosos o no
});

/**
 * Register Limiter - Previene creación masiva de cuentas
 * 3 registros por hora por IP
 */
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 3, // 3 registros
  message: {
    error: 'Too Many Requests',
    message: 'Has creado demasiadas cuentas. Intenta de nuevo en 1 hora.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

/**
 * Password Reset Limiter - Previene spam de emails
 * 3 solicitudes cada 15 minutos por IP
 */
export const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 3, // 3 solicitudes
  message: {
    error: 'Too Many Requests',
    message: 'Demasiadas solicitudes de recuperación. Intenta en 15 minutos.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

/**
 * Email Verification Limiter - Previene abuso de reenvío
 * 5 solicitudes cada 15 minutos por IP
 */
export const emailVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // 5 solicitudes
  message: {
    error: 'Too Many Requests',
    message: 'Demasiadas solicitudes de verificación. Intenta en 15 minutos.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

/**
 * API General Limiter - Protección general para APIs autenticadas
 * 100 requests por minuto por IP
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 100, // 100 requests
  message: {
    error: 'Too Many Requests',
    message: 'Demasiadas solicitudes. Por favor, reduce la frecuencia.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  skip: (req: Request) => {
    // Skip para health checks
    return req.path === '/health' || req.path === '/api/health';
  },
});

/**
 * Strict API Limiter - Para endpoints costosos (IA, webhooks)
 * 30 requests por minuto por IP
 */
export const strictApiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 30, // 30 requests
  message: {
    error: 'Too Many Requests',
    message: 'Has excedido el límite de solicitudes para este servicio.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

/**
 * Webhook Limiter - Para webhooks externos (Stripe, etc.)
 * Más permisivo ya que son servicios confiables
 * 50 requests por minuto por IP
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 50, // 50 requests
  message: {
    error: 'Too Many Requests',
    message: 'Webhook rate limit exceeded.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});
