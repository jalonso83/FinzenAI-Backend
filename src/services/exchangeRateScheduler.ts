import cron from 'node-cron';
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { ENV } from '../config/env';
import { logger } from '../utils/logger';
import { ExchangeRateService } from './exchangeRateService';

/**
 * Exchange Rate Scheduler
 * Descarga tasas de cambio de ExchangeRate-API una vez al día a medianoche.
 * Almacena todas las tasas en la tabla exchange_rates para consulta local.
 *
 * El dólar NO se guarda a tasa de mercado: se usa la venta del Banco Central más
 * EXCHANGE_RATE_MARGIN_PCT (1% por defecto), que es como los bancos dominicanos
 * cobran los consumos con tarjeta. Con la de mercado los montos no cuadraban con
 * el estado de cuenta (nov-2026: mercado 60.52, BCRD venta 60.76, BHD 61.40).
 *
 * API: https://v6.exchangerate-api.com/v6/{API_KEY}/latest/USD
 * Plan gratis: 1,500 req/mes — usamos ~30/mes (1/día)
 */

interface ExchangeRateAPIResponse {
  result: string;
  base_code: string;
  time_last_update_utc: string;
  conversion_rates: Record<string, number>;
}

// Tasas hardcodeadas de fallback (aproximadas, actualizadas manualmente)
const FALLBACK_RATES: Record<string, number> = {
  DOP: 1.0,       // Base
  USD: 60.50,     // 1 USD = ~60.50 DOP
  EUR: 65.80,     // 1 EUR = ~65.80 DOP
  GBP: 76.50,     // 1 GBP = ~76.50 DOP
  CAD: 44.20,     // 1 CAD = ~44.20 DOP
  MXN: 3.55,      // 1 MXN = ~3.55 DOP
  COP: 0.0145,    // 1 COP = ~0.0145 DOP
  BRL: 11.80,     // 1 BRL = ~11.80 DOP
  CHF: 69.50,     // 1 CHF = ~69.50 DOP
  JPY: 0.41,      // 1 JPY = ~0.41 DOP
};

let schedulerTask: cron.ScheduledTask | null = null;

export class ExchangeRateScheduler {

  /**
   * Inicia el cron que descarga tasas a medianoche (hora Santo Domingo)
   */
  static startScheduler(): void {
    if (!ENV.EXCHANGE_RATE_API_KEY) {
      logger.log('[ExchangeRateScheduler] No API key configured, scheduler disabled');
      return;
    }

    // Cron: 0 0 * * * = medianoche todos los días
    schedulerTask = cron.schedule('0 0 * * *', async () => {
      logger.log('[ExchangeRateScheduler] Running nightly exchange rate sync...');
      await this.syncRates();
    }, {
      timezone: 'America/Santo_Domingo'
    });

    logger.log('[ExchangeRateScheduler] Scheduled for midnight (America/Santo_Domingo)');

    // Verificar si hay tasas en la BD; si no, hacer sync inicial
    this.checkAndSeedRates();
  }

  /**
   * Detiene el scheduler
   */
  static stopScheduler(): void {
    if (schedulerTask) {
      schedulerTask.stop();
      schedulerTask = null;
      logger.log('[ExchangeRateScheduler] Stopped');
    }
  }

  /**
   * Descarga y almacena todas las tasas de cambio
   * Retorna el número de tasas actualizadas
   */
  static async syncRates(): Promise<number> {
    const apiKey = ENV.EXCHANGE_RATE_API_KEY;
    if (!apiKey) {
      logger.error('[ExchangeRateScheduler] No EXCHANGE_RATE_API_KEY configured');
      return 0;
    }

    try {
      const url = `https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`;
      logger.log('[ExchangeRateScheduler] Fetching rates from ExchangeRate-API...');

      const response = await axios.get<ExchangeRateAPIResponse>(url, { timeout: 15000 });

      if (response.data.result !== 'success') {
        throw new Error(`API returned: ${response.data.result}`);
      }

      const apiRates = response.data.conversion_rates;
      const midDopPerUsd = apiRates['DOP'];

      if (!midDopPerUsd) {
        throw new Error('DOP rate not found in API response');
      }

      // El peso se ancla a lo que cobra la tarjeta, no al mercado: las demás monedas
      // salen de su cruce con el dólar, así que todas quedan con el mismo ajuste.
      const { dopPerUsd, source } = await this.cardDopPerUsd(midDopPerUsd);
      const rates = { ...apiRates, DOP: dopPerUsd };

      // Fecha de hoy (sin hora) para el campo date
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      let updated = 0;

      // Para cada moneda: calcular rateToDop
      // rateToDop = dopPerUsd / currencyPerUsd
      // Ejemplo: EUR rate = 0.92, DOP rate = 61.35
      //   1 EUR = 61.35 / 0.92 = 66.68 DOP
      for (const [currency, ratePerUsd] of Object.entries(rates)) {
        if (ratePerUsd <= 0) continue;

        const rateToDop = dopPerUsd / ratePerUsd;
        const rateToUsd = 1 / ratePerUsd;

        await prisma.exchangeRate.upsert({
          where: {
            currency_date: { currency, date: today }
          },
          update: {
            rateToDop,
            rateToUsd,
            source
          },
          create: {
            currency,
            rateToDop,
            rateToUsd,
            source,
            date: today
          }
        });

        updated++;
      }

      logger.log(`[ExchangeRateScheduler] Updated ${updated} exchange rates`);
      return updated;

    } catch (error: any) {
      logger.error('[ExchangeRateScheduler] Sync failed:', error.message);

      // Si la BD está vacía, insertar fallback rates
      const count = await prisma.exchangeRate.count();
      if (count === 0) {
        logger.log('[ExchangeRateScheduler] No rates in DB, inserting fallback rates...');
        await this.insertFallbackRates();
      }

      return 0;
    }
  }

  /**
   * Pesos por dólar que cobra una tarjeta: venta del BCRD + margen del banco.
   * Si el BCRD no responde o da un número raro, cae a la tasa de mercado + margen
   * (queda ~0.4% por debajo, pero mejor que dejar el día sin tasa).
   */
  private static async cardDopPerUsd(midDopPerUsd: number): Promise<{ dopPerUsd: number; source: string }> {
    const parsed = parseFloat(ENV.EXCHANGE_RATE_MARGIN_PCT);
    const marginPct = Number.isFinite(parsed) && parsed >= 0 && parsed <= 10 ? parsed : 1;
    const factor = 1 + marginPct / 100;

    try {
      const bcrd = await ExchangeRateService.fetchBcrdRate();
      // La venta del BCRD y el mercado no se separan más de ~1%; un 5% es la página rota
      if (Math.abs(bcrd.sell / midDopPerUsd - 1) > 0.05) {
        throw new Error(`BCRD sell ${bcrd.sell} too far from market ${midDopPerUsd}`);
      }
      logger.log(`[ExchangeRateScheduler] BCRD venta ${bcrd.sell} (${bcrd.publishedLabel ?? 's/f'}) +${marginPct}%`);
      return { dopPerUsd: bcrd.sell * factor, source: `BCRD venta +${marginPct}%` };
    } catch (error: any) {
      logger.error('[ExchangeRateScheduler] BCRD rate unavailable, using market rate:', error.message);
      return { dopPerUsd: midDopPerUsd * factor, source: `ExchangeRate-API +${marginPct}%` };
    }
  }

  /**
   * Trigger manual para forzar la descarga de tasas (admin/debug)
   */
  static async triggerManualSync(): Promise<{ updated: number; message: string }> {
    const updated = await this.syncRates();
    return {
      updated,
      message: updated > 0
        ? `Successfully updated ${updated} exchange rates`
        : 'Sync failed or no API key configured. Check logs.'
    };
  }

  /**
   * Verifica si hay tasas en la BD al iniciar. Si no, hace sync.
   */
  private static async checkAndSeedRates(): Promise<void> {
    try {
      const count = await prisma.exchangeRate.count();
      if (count === 0) {
        logger.log('[ExchangeRateScheduler] No rates in DB, running initial sync...');
        const updated = await this.syncRates();
        if (updated === 0) {
          logger.log('[ExchangeRateScheduler] API sync failed, using fallback rates');
          await this.insertFallbackRates();
        }
      } else {
        logger.log(`[ExchangeRateScheduler] ${count} rates found in DB`);

        // La última tasa es de antes del ancla al BCRD (fuente vieja): se rehace al
        // arrancar en vez de esperar a medianoche. Solo pasa una vez tras el deploy.
        const latestUsd = await prisma.exchangeRate.findFirst({
          where: { currency: 'USD' },
          orderBy: { date: 'desc' },
          select: { source: true }
        });
        if (latestUsd?.source === 'ExchangeRate-API') {
          logger.log('[ExchangeRateScheduler] Latest rates are market-only, re-syncing...');
          await this.syncRates();
        }
      }
    } catch (error: any) {
      logger.error('[ExchangeRateScheduler] Error checking rates:', error.message);
    }
  }

  /**
   * Inserta tasas hardcodeadas como fallback si la API no está disponible
   */
  private static async insertFallbackRates(): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Necesitamos saber cuántos DOP por USD para calcular rateToUsd
    const dopPerUsd = FALLBACK_RATES['USD']; // 60.50

    for (const [currency, rateToDop] of Object.entries(FALLBACK_RATES)) {
      if (currency === 'DOP') continue;

      const rateToUsd = rateToDop / dopPerUsd;

      await prisma.exchangeRate.upsert({
        where: {
          currency_date: { currency, date: today }
        },
        update: { rateToDop, rateToUsd, source: 'fallback' },
        create: {
          currency,
          rateToDop,
          rateToUsd,
          source: 'fallback',
          date: today
        }
      });
    }

    // DOP a sí mismo
    await prisma.exchangeRate.upsert({
      where: {
        currency_date: { currency: 'DOP', date: today }
      },
      update: { rateToDop: 1, rateToUsd: 1 / dopPerUsd, source: 'fallback' },
      create: {
        currency: 'DOP',
        rateToDop: 1,
        rateToUsd: 1 / dopPerUsd,
        source: 'fallback',
        date: today
      }
    });

    logger.log(`[ExchangeRateScheduler] Inserted ${Object.keys(FALLBACK_RATES).length} fallback rates`);
  }
}

export default ExchangeRateScheduler;
