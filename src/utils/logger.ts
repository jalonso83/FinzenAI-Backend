/**
 * Logger Utility
 *
 * Reemplaza console.log/error/warn para controlar output en produccion.
 * En produccion solo se muestran errores criticos.
 *
 * SEGURIDAD: Sanitiza automáticamente datos sensibles (tokens, secrets, passwords)
 *
 * USO:
 * import { logger } from '../utils/logger';
 * logger.log('mensaje');      // Solo en desarrollo
 * logger.error('error');      // Siempre (errores criticos)
 * logger.warn('advertencia'); // Solo en desarrollo
 * logger.info('info');        // Solo en desarrollo
 * logger.debug('debug');      // Solo en desarrollo
 */

const isDev = process.env.NODE_ENV !== 'production';

// Campos sensibles que deben ser ocultados en logs
const SENSITIVE_FIELDS = [
  'password',
  'client_secret',
  'refresh_token',
  'access_token',
  'authorization',
  'api_key',
  'apikey',
  'secret',
  'token',
  'credential',
  'private_key',
  'jwt',
  'bearer',
];

/**
 * Sanitiza un objeto removiendo/ocultando datos sensibles
 */
function sanitizeValue(value: any, depth: number = 0): any {
  // Prevenir recursión infinita
  if (depth > 5) return '[MAX_DEPTH]';

  if (value === null || value === undefined) return value;

  // Strings - verificar si parece ser un token/secret
  if (typeof value === 'string') {
    // Ocultar strings que parecen tokens (más de 20 chars con mezcla)
    if (value.length > 20 && /^[A-Za-z0-9_\-/.]+$/.test(value)) {
      return `[REDACTED:${value.substring(0, 4)}...${value.length}chars]`;
    }
    return value;
  }

  // Arrays
  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item, depth + 1));
  }

  // Objetos
  if (typeof value === 'object') {
    // Axios errors - extraer solo info útil
    if (value.isAxiosError || value.config?.url) {
      return {
        message: value.message,
        status: value.response?.status,
        statusText: value.response?.statusText,
        url: value.config?.url,
        method: value.config?.method,
        responseData: sanitizeValue(value.response?.data, depth + 1),
      };
    }

    // Error estándar
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: isDev ? value.stack : undefined,
      };
    }

    // Objeto genérico - sanitizar cada campo
    const sanitized: any = {};
    for (const key of Object.keys(value)) {
      const lowerKey = key.toLowerCase();
      // Verificar si es un campo sensible
      if (SENSITIVE_FIELDS.some(field => lowerKey.includes(field))) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeValue(value[key], depth + 1);
      }
    }
    return sanitized;
  }

  return value;
}

/**
 * Sanitiza los argumentos del logger
 */
function sanitizeArgs(args: any[]): any[] {
  return args.map(arg => sanitizeValue(arg));
}

type LogLevel = 'debug' | 'info' | 'log' | 'warn' | 'error';

interface LoggerOptions {
  prefix?: string;
  timestamp?: boolean;
}

class Logger {
  private prefix: string;
  private showTimestamp: boolean;

  constructor(options: LoggerOptions = {}) {
    this.prefix = options.prefix || '';
    this.showTimestamp = options.timestamp ?? isDev;
  }

  private formatMessage(level: LogLevel, args: any[]): any[] {
    const parts: any[] = [];

    if (this.showTimestamp) {
      parts.push(`[${new Date().toISOString()}]`);
    }

    if (this.prefix) {
      parts.push(`[${this.prefix}]`);
    }

    parts.push(`[${level.toUpperCase()}]`);

    return [...parts, ...args];
  }

  /**
   * Log general - solo en desarrollo
   */
  log(...args: any[]): void {
    if (isDev) {
      console.log(...this.formatMessage('log', args));
    }
  }

  /**
   * Info - solo en desarrollo
   */
  info(...args: any[]): void {
    if (isDev) {
      console.info(...this.formatMessage('info', args));
    }
  }

  /**
   * Debug - solo en desarrollo
   */
  debug(...args: any[]): void {
    if (isDev) {
      console.debug(...this.formatMessage('debug', args));
    }
  }

  /**
   * Warn - solo en desarrollo
   */
  warn(...args: any[]): void {
    if (isDev) {
      console.warn(...this.formatMessage('warn', args));
    }
  }

  /**
   * Error - SIEMPRE se muestra (errores criticos)
   * SEGURIDAD: Sanitiza datos sensibles automáticamente
   */
  error(...args: any[]): void {
    const sanitizedArgs = sanitizeArgs(args);
    console.error(...this.formatMessage('error', sanitizedArgs));
  }

  /**
   * Crear un logger con prefijo personalizado
   */
  createChild(prefix: string): Logger {
    return new Logger({
      prefix: this.prefix ? `${this.prefix}:${prefix}` : prefix,
      timestamp: this.showTimestamp
    });
  }
}

// Instancia principal del logger
export const logger = new Logger();

// Loggers especializados para diferentes modulos
export const authLogger = new Logger({ prefix: 'Auth' });
export const stripeLogger = new Logger({ prefix: 'Stripe' });
export const emailLogger = new Logger({ prefix: 'Email' });
export const gamificationLogger = new Logger({ prefix: 'Gamification' });
export const zenioLogger = new Logger({ prefix: 'Zenio' });
export const dbLogger = new Logger({ prefix: 'Database' });
export const revenueCatLogger = new Logger({ prefix: 'RevenueCat' });

export default logger;
