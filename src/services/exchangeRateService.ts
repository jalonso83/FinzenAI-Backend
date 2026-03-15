import axios from 'axios';
import { prisma } from '../lib/prisma';

import { logger } from '../utils/logger';
// URL del Banco Central de República Dominicana
const BCRD_URL = 'https://www.bancentral.gov.do';

export interface ExchangeRate {
  buy: number;      // Tasa de compra
  sell: number;     // Tasa de venta
  date: Date;
  source: string;
}

export class ExchangeRateService {

  /**
   * Obtiene la tasa de cambio USD/DOP del Banco Central RD
   * Hace web scraping de la página principal
   */
  static async getCurrentRate(): Promise<ExchangeRate> {
    try {
      logger.log('[ExchangeRate] Fetching rate from BCRD...');

      const response = await axios.get(BCRD_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 10000
      });

      const html = response.data;

      // Buscar los valores de compra y venta usando regex
      // Los valores están cerca de "Compra" y "Venta" en el HTML
      const buyMatch = html.match(/Compra[\s\S]*?(\d{2}\.\d{4})/i);
      const sellMatch = html.match(/Venta[\s\S]*?(\d{2}\.\d{4})/i);

      if (!buyMatch || !sellMatch) {
        throw new Error('Could not extract exchange rates from BCRD page');
      }

      const rate: ExchangeRate = {
        buy: parseFloat(buyMatch[1]),
        sell: parseFloat(sellMatch[1]),
        date: new Date(),
        source: 'Banco Central de la República Dominicana'
      };

      logger.log(`[ExchangeRate] USD/DOP - Buy: ${rate.buy}, Sell: ${rate.sell}`);

      // Guardar en cache/DB para no hacer muchas peticiones
      await this.cacheRate(rate);

      return rate;

    } catch (error: any) {
      logger.error('[ExchangeRate] Error fetching rate:', error.message);

      // Intentar obtener la última tasa cacheada
      const cachedRate = await this.getCachedRate();
      if (cachedRate) {
        logger.log('[ExchangeRate] Using cached rate');
        return cachedRate;
      }

      // Si no hay cache, usar una tasa por defecto (última conocida)
      return {
        buy: 62.75,
        sell: 63.59,
        date: new Date(),
        source: 'Default fallback rate'
      };
    }
  }

  /**
   * Convierte un monto de USD a DOP
   * Usa la tasa de venta (lo que pagarías por dólares)
   */
  static async convertUsdToDop(amountUsd: number): Promise<{
    amountDop: number;
    rate: number;
    rateDate: Date;
  }> {
    const exchangeRate = await this.getCurrentRate();

    return {
      amountDop: Math.round(amountUsd * exchangeRate.sell * 100) / 100,
      rate: exchangeRate.sell,
      rateDate: exchangeRate.date
    };
  }

  /**
   * Convierte un monto de DOP a USD
   * Usa la tasa de compra
   */
  static async convertDopToUsd(amountDop: number): Promise<{
    amountUsd: number;
    rate: number;
    rateDate: Date;
  }> {
    const exchangeRate = await this.getCurrentRate();

    return {
      amountUsd: Math.round((amountDop / exchangeRate.buy) * 100) / 100,
      rate: exchangeRate.buy,
      rateDate: exchangeRate.date
    };
  }

  /**
   * Guarda la tasa en cache (tabla de configuración o memoria)
   */
  private static async cacheRate(rate: ExchangeRate): Promise<void> {
    try {
      // Usar una tabla simple de configuración si existe, o guardar en memoria
      // Por ahora guardamos en una variable estática con TTL
      ExchangeRateService.cachedRate = rate;
      ExchangeRateService.cacheTime = Date.now();
    } catch (error) {
      logger.error('[ExchangeRate] Error caching rate:', error);
    }
  }

  /**
   * Obtiene la tasa cacheada si no ha expirado (1 hora)
   */
  private static async getCachedRate(): Promise<ExchangeRate | null> {
    const CACHE_TTL = 60 * 60 * 1000; // 1 hora

    if (
      ExchangeRateService.cachedRate &&
      ExchangeRateService.cacheTime &&
      Date.now() - ExchangeRateService.cacheTime < CACHE_TTL
    ) {
      return ExchangeRateService.cachedRate;
    }

    return null;
  }

  // Cache en memoria
  private static cachedRate: ExchangeRate | null = null;
  private static cacheTime: number | null = null;

  /**
   * Obtiene la tasa para una fecha específica (del histórico)
   * Para transacciones pasadas
   */
  static async getRateForDate(date: Date): Promise<ExchangeRate> {
    // Por ahora retornamos la tasa actual
    // TODO: Implementar consulta al histórico si es necesario
    return this.getCurrentRate();
  }

  // =============================================================
  // MÉTODOS MULTI-MONEDA (consultan tabla exchange_rates)
  // =============================================================

  /**
   * Mapeo de variantes de moneda a código ISO estándar.
   * Los emails bancarios pueden traer: "EUR$", "US$", "Euro", "USD", etc.
   */
  private static readonly CURRENCY_ALIASES: Record<string, string> = {
    'US$': 'USD',
    'USD': 'USD',
    'RD$': 'DOP',
    'DOP': 'DOP',
    'EUR$': 'EUR',
    'EUR': 'EUR',
    'EURO': 'EUR',
    'GBP': 'GBP',
    '£': 'GBP',
    'CAD': 'CAD',
    'CA$': 'CAD',
    'MXN': 'MXN',
    'MX$': 'MXN',
    'COP': 'COP',
    'CO$': 'COP',
    'BRL': 'BRL',
    'R$': 'BRL',
    'CHF': 'CHF',
    'JPY': 'JPY',
    '¥': 'JPY',
  };

  /**
   * Normaliza una cadena de moneda a su código ISO (3 letras).
   * Ej: "EUR$" → "EUR", "US$" → "USD", "RD$" → "DOP"
   */
  static normalizeCurrency(raw: string): string {
    if (!raw) return 'DOP';
    const upper = raw.trim().toUpperCase();
    return this.CURRENCY_ALIASES[upper] || upper;
  }

  /**
   * Convierte un monto de cualquier moneda a cualquier otra moneda.
   * Consulta la tabla exchange_rates (poblada por el cron nocturno).
   *
   * @param amount - Monto en la moneda de origen
   * @param fromCurrency - Código ISO de la moneda de origen (ej: "EUR")
   * @param toCurrency - Código ISO de la moneda destino (ej: "DOP")
   * @returns { amount, rate, from, to }
   */
  static async convert(
    amount: number,
    fromCurrency: string,
    toCurrency: string
  ): Promise<{ amount: number; rate: number; from: string; to: string }> {
    const from = this.normalizeCurrency(fromCurrency);
    const to = this.normalizeCurrency(toCurrency);

    // Misma moneda → no convertir
    if (from === to) {
      return { amount, rate: 1, from, to };
    }

    try {
      // Buscar la tasa más reciente de la moneda origen
      const fromRate = await prisma.exchangeRate.findFirst({
        where: { currency: from },
        orderBy: { date: 'desc' }
      });

      if (!fromRate) {
        // No hay tasa en BD → intentar fallback BCRD solo para USD→DOP
        if (from === 'USD' && to === 'DOP') {
          const bcrd = await this.convertUsdToDop(amount);
          return { amount: bcrd.amountDop, rate: bcrd.rate, from, to };
        }
        logger.error(`[ExchangeRate] No rate found for ${from}, returning unconverted`);
        return { amount, rate: 1, from, to };
      }

      // Si destino es DOP → directo
      if (to === 'DOP') {
        const converted = Math.round(amount * fromRate.rateToDop * 100) / 100;
        return { amount: converted, rate: fromRate.rateToDop, from, to };
      }

      // Si destino NO es DOP → necesitamos cross-rate
      const toRate = await prisma.exchangeRate.findFirst({
        where: { currency: to },
        orderBy: { date: 'desc' }
      });

      if (!toRate) {
        logger.error(`[ExchangeRate] No rate found for ${to}, returning unconverted`);
        return { amount, rate: 1, from, to };
      }

      // Cross-rate: fromCurrency → DOP → toCurrency
      // amount * (fromRate.rateToDop / toRate.rateToDop)
      const crossRate = fromRate.rateToDop / toRate.rateToDop;
      const converted = Math.round(amount * crossRate * 100) / 100;
      return { amount: converted, rate: Math.round(crossRate * 10000) / 10000, from, to };

    } catch (error: any) {
      logger.error(`[ExchangeRate] Convert error (${from}→${to}):`, error.message);

      // Fallback: si es USD→DOP, usar BCRD scraping
      if (from === 'USD' && to === 'DOP') {
        const bcrd = await this.convertUsdToDop(amount);
        return { amount: bcrd.amountDop, rate: bcrd.rate, from, to };
      }

      return { amount, rate: 1, from, to };
    }
  }

  /**
   * Obtiene la última tasa conocida de una moneda (vs DOP).
   */
  static async getRate(currency: string): Promise<{ rateToDop: number; rateToUsd: number; date: Date; source: string } | null> {
    const code = this.normalizeCurrency(currency);
    const rate = await prisma.exchangeRate.findFirst({
      where: { currency: code },
      orderBy: { date: 'desc' }
    });
    if (!rate) return null;
    return {
      rateToDop: rate.rateToDop,
      rateToUsd: rate.rateToUsd,
      date: rate.date,
      source: rate.source
    };
  }

  /**
   * Devuelve todas las tasas actuales (para admin/debug).
   */
  static async getAllRates(): Promise<Array<{ currency: string; rateToDop: number; rateToUsd: number; date: Date; source: string }>> {
    // Obtener la fecha más reciente
    const latest = await prisma.exchangeRate.findFirst({
      orderBy: { date: 'desc' },
      select: { date: true }
    });

    if (!latest) return [];

    const rates = await prisma.exchangeRate.findMany({
      where: { date: latest.date },
      orderBy: { currency: 'asc' },
      select: { currency: true, rateToDop: true, rateToUsd: true, date: true, source: true }
    });

    return rates;
  }
}

export default ExchangeRateService;
