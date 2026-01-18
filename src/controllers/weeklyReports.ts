import { Request, Response } from 'express';
import { WeeklyReportService } from '../services/weeklyReportService';
import { WeeklyReportScheduler } from '../services/weeklyReportScheduler';
import { subscriptionService } from '../services/subscriptionService';
import { logger } from '../utils/logger';

/**
 * Obtiene el historial de reportes semanales del usuario
 */
export const getReportHistory = async (req: Request, res: Response): Promise<Response> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Usuario no autenticado' });
    }

    // Verificar que es usuario PRO
    const subscription = await subscriptionService.getUserSubscription(userId);
    if (subscription.plan !== 'PRO') {
      return res.status(403).json({
        message: 'Esta funcionalidad requiere suscripción PRO',
        isPro: false
      });
    }

    const reports = await WeeklyReportService.getReportHistory(userId);

    return res.json({
      success: true,
      reports,
      unviewedCount: reports.filter(r => r.isNew).length
    });

  } catch (error) {
    logger.error('Error obteniendo historial de reportes:', error);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * Obtiene un reporte específico por ID
 */
export const getReportById = async (req: Request, res: Response): Promise<Response> => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Usuario no autenticado' });
    }

    // Verificar que es usuario PRO
    const subscription = await subscriptionService.getUserSubscription(userId);
    if (subscription.plan !== 'PRO') {
      return res.status(403).json({
        message: 'Esta funcionalidad requiere suscripción PRO',
        isPro: false
      });
    }

    const report = await WeeklyReportService.getReportById(id, userId);

    if (!report) {
      return res.status(404).json({ message: 'Reporte no encontrado' });
    }

    // Marcar como visto
    await WeeklyReportService.markReportAsViewed(id, userId);

    return res.json({
      success: true,
      report
    });

  } catch (error) {
    logger.error('Error obteniendo reporte:', error);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * Marca un reporte como visto
 */
export const markAsViewed = async (req: Request, res: Response): Promise<Response> => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Usuario no autenticado' });
    }

    const success = await WeeklyReportService.markReportAsViewed(id, userId);

    return res.json({ success });

  } catch (error) {
    logger.error('Error marcando reporte como visto:', error);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * Obtiene el conteo de reportes no vistos
 */
export const getUnviewedCount = async (req: Request, res: Response): Promise<Response> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: 'Usuario no autenticado' });
    }

    // Verificar que es usuario PRO
    const subscription = await subscriptionService.getUserSubscription(userId);
    if (subscription.plan !== 'PRO') {
      return res.json({ count: 0, isPro: false });
    }

    const count = await WeeklyReportService.getUnviewedCount(userId);

    return res.json({ count, isPro: true });

  } catch (error) {
    logger.error('Error obteniendo conteo de reportes no vistos:', error);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * Ejecuta la generación manual de reportes (solo para admins/testing)
 */
export const runManualGeneration = async (req: Request, res: Response): Promise<Response> => {
  try {
    const apiKey = req.headers['x-api-key'];
    const expectedKey = process.env.CRON_API_KEY || 'default-cron-key';

    if (apiKey !== expectedKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const results = await WeeklyReportScheduler.runManual();

    return res.json({
      success: true,
      ...results
    });

  } catch (error: any) {
    logger.error('Error en generación manual:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Genera reporte para un usuario específico (testing)
 */
export const generateForUser = async (req: Request, res: Response): Promise<Response> => {
  try {
    const apiKey = req.headers['x-api-key'];
    const expectedKey = process.env.CRON_API_KEY || 'default-cron-key';

    if (apiKey !== expectedKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { userId } = req.params;

    const result = await WeeklyReportScheduler.generateForUser(userId);

    return res.json(result);

  } catch (error: any) {
    logger.error('Error generando reporte para usuario:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
