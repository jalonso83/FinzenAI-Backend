import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth';
import { getCategoryReport, exportCategoryReport, getIncomeReport, getDateReport, getBudgetReport, getDashboardTotals } from '../controllers/reports';

const router: Router = Router();

// Aplicar middleware de autenticación a todas las rutas
router.use(authenticateToken);

// Rutas de reportes
router.get('/categories', getCategoryReport);
router.get('/categories/export', exportCategoryReport);
router.get('/income', getIncomeReport);
router.get('/dates', getDateReport);
router.get('/budgets', getBudgetReport);
router.get('/dashboard-totals', getDashboardTotals); // Nuevo endpoint para totales consistentes del dashboard

export default router;