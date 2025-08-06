import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth';
import { getCategoryReport, exportCategoryReport, getDateReport } from '../controllers/reports';

const router: Router = Router();

// Aplicar middleware de autenticación a todas las rutas
router.use(authenticateToken);

// Rutas de reportes
router.get('/categories', getCategoryReport);
router.get('/categories/export', exportCategoryReport);
router.get('/dates', getDateReport);

export default router;