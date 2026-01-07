/**
 * Logger Utility
 *
 * Reemplaza console.log/error/warn para controlar output en produccion.
 * En produccion solo se muestran errores criticos.
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
   */
  error(...args: any[]): void {
    console.error(...this.formatMessage('error', args));
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

export default logger;
