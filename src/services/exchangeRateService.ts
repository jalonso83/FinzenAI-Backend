import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
      console.log('[ExchangeRate] Fetching rate from BCRD...');

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

      console.log(`[ExchangeRate] USD/DOP - Buy: ${rate.buy}, Sell: ${rate.sell}`);

      // Guardar en cache/DB para no hacer muchas peticiones
      await this.cacheRate(rate);

      return rate;

    } catch (error: any) {
      console.error('[ExchangeRate] Error fetching rate:', error.message);

      // Intentar obtener la última tasa cacheada
      const cachedRate = await this.getCachedRate();
      if (cachedRate) {
        console.log('[ExchangeRate] Using cached rate');
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
      console.error('[ExchangeRate] Error caching rate:', error);
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
}

export default ExchangeRateService;
