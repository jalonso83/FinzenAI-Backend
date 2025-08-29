import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth';
import { 
  calculateInvestment, 
  getRiskProfiles, 
  getEquivalencyExamples,
  calculateGoal,
  getGoalTypes,
  calculateSkipVsSave,
  getCommonExpenses
} from '../controllers/investment';

const router: Router = Router();

// Todas las rutas de investment requieren autenticación
router.use(authenticateToken);

// POST /api/investment/calculate - Calcular inversión
router.post('/calculate', calculateInvestment);

// GET /api/investment/risk-profiles - Obtener perfiles de riesgo
router.get('/risk-profiles', getRiskProfiles);

// GET /api/investment/equivalencies - Obtener ejemplos de equivalencias
router.get('/equivalencies', getEquivalencyExamples);

// POST /api/investment/calculate-goal - Calcular meta de ahorro
router.post('/calculate-goal', calculateGoal);

// GET /api/investment/goal-types - Obtener tipos de metas disponibles
router.get('/goal-types', getGoalTypes);

// POST /api/investment/skip-vs-save - Calcular Skip vs Save Challenge
router.post('/skip-vs-save', calculateSkipVsSave);

// GET /api/investment/common-expenses - Obtener gastos comunes sugeridos
router.get('/common-expenses', getCommonExpenses);

export default router;