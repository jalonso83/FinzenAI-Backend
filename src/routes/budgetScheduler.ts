import express, { Router, Request, Response } from 'express';
import { BudgetScheduler } from '../services/budgetScheduler';
import { BudgetRenewalService } from '../services/budgetRenewalService';
import { authenticateToken } from '../middlewares/auth';

import { logger } from '../utils/logger';
const router: Router = express.Router();

// Middleware de autenticación para todas las rutas
router.use(authenticateToken);

/**
 * GET /api/scheduler/status
 * Obtiene el estado del scheduler de renovación de presupuestos
 */
router.get('/status', (req: Request, res: Response) => {
  try {
    const status = BudgetScheduler.getStatus();
    
    return res.json({
      success: true,
      scheduler: status,
      message: 'Estado del scheduler obtenido correctamente'
    });
  } catch (error) {
    logger.error('Error getting scheduler status:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Error al obtener el estado del scheduler'
    });
  }
});

/**
 * POST /api/scheduler/run-manual
 * Ejecuta manualmente la renovación de presupuestos
 * Útil para testing o ejecución bajo demanda
 */
router.post('/run-manual', async (req: Request, res: Response) => {
  try {
    logger.log(`[Manual Execution] Ejecutado por usuario: ${req.user?.email}`);
    
    await BudgetScheduler.runManual();
    
    return res.json({
      success: true,
      message: 'Renovación manual de presupuestos ejecutada correctamente'
    });
  } catch (error) {
    logger.error('Error running manual renewal:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Error al ejecutar la renovación manual'
    });
  }
});

/**
 * GET /api/scheduler/budget-history/:categoryId?
 * Obtiene el histórico de presupuestos del usuario
 */
router.get('/budget-history/:categoryId?', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { categoryId } = req.params;
    
    const history = await BudgetRenewalService.getBudgetHistory(
      userId, 
      categoryId || undefined
    );
    
    return res.json({
      success: true,
      history,
      message: 'Histórico de presupuestos obtenido correctamente'
    });
  } catch (error) {
    logger.error('Error getting budget history:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Error al obtener el histórico de presupuestos'
    });
  }
});

export default router;