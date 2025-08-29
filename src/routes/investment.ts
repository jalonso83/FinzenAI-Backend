import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth';
import { 
  calculateInvestment, 
  getRiskProfiles, 
  getEquivalencyExamples,
  calculateGoal,
  getGoalTypes
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

export default router;