import express, { Router } from 'express';
import {
  getReportHistory,
  getReportById,
  markAsViewed,
  getUnviewedCount,
  runManualGeneration,
  generateForUser
} from '../controllers/weeklyReports';
import { authenticateToken } from '../middlewares/auth';

const router: Router = express.Router();

// Rutas administrativas (protegidas por API key)
router.post('/run-generation', runManualGeneration);
router.post('/generate/:userId', generateForUser);

// Todas las rutas siguientes requieren autenticación
router.use(authenticateToken);

// Obtener historial de reportes
router.get('/history', getReportHistory);

// Obtener conteo de reportes no vistos
router.get('/unviewed-count', getUnviewedCount);

// Obtener un reporte específico
router.get('/:id', getReportById);

// Marcar reporte como visto
router.put('/:id/viewed', markAsViewed);

export default router;
