import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth';
import { 
  calculateInvestment, 
  getRiskProfiles, 
  getEquivalencyExamples 
} from '../controllers/investment';

const router = Router();

// Todas las rutas de investment requieren autenticación
router.use(authenticateToken);

// POST /api/investment/calculate - Calcular inversión
router.post('/calculate', calculateInvestment);

// GET /api/investment/risk-profiles - Obtener perfiles de riesgo
router.get('/risk-profiles', getRiskProfiles);

// GET /api/investment/equivalencies - Obtener ejemplos de equivalencias
router.get('/equivalencies', getEquivalencyExamples);

export default router;