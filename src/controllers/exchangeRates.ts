import { Request, Response } from 'express';
import { ExchangeRateService } from '../services/exchangeRateService';
import { logger } from '../utils/logger';

export const getAllExchangeRates = async (req: Request, res: Response) => {
  try {
    const rates = await ExchangeRateService.getAllRates();

    return res.json({
      success: true,
      rates,
      count: rates.length,
    });
  } catch (error) {
    logger.error('[ExchangeRates] Error getting exchange rates:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al obtener las tasas de cambio',
    });
  }
};

export const getExchangeRate = async (req: Request, res: Response) => {
  try {
    const { currency } = req.params;

    if (!currency) {
      return res.status(400).json({
        success: false,
        error: 'Moneda requerida',
      });
    }

    const rate = await ExchangeRateService.getRate(currency.toUpperCase());

    if (!rate) {
      return res.status(404).json({
        success: false,
        error: `No se encontró tasa para ${currency.toUpperCase()}`,
      });
    }

    return res.json({
      success: true,
      rate,
    });
  } catch (error) {
    logger.error('[ExchangeRates] Error getting exchange rate:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al obtener la tasa de cambio',
    });
  }
};
