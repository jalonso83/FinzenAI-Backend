import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth';
import { requirePlan } from '../middleware/planLimits';
import {
  calculateInvestment,
  getRiskProfiles,
  getEquivalencyExamples,
  calculateGoal,
  getGoalTypes,
  calculateSkipVsSave,
  getCommonExpenses,
  calculateInflation,
  getCurrentPrices
} from '../controllers/investment';

const router: Router = Router();

// Todas las rutas de investment requieren autenticación
router.use(authenticateToken);

// =============================================
// CALCULADORAS BÁSICAS (Disponibles para todos los planes)
// =============================================

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

// =============================================
// CALCULADORAS AVANZADAS (Requieren PLUS o superior)
// Skip vs Save Challenge - Exclusivo para planes de pago
// =============================================

// POST /api/investment/skip-vs-save - Calcular Skip vs Save Challenge
router.post('/skip-vs-save', requirePlan('PREMIUM'), calculateSkipVsSave);

// GET /api/investment/common-expenses - Obtener gastos comunes sugeridos
router.get('/common-expenses', requirePlan('PREMIUM'), getCommonExpenses);

// POST /api/investment/calculate-inflation - Calcular impacto de inflación
router.post('/calculate-inflation', calculateInflation);

// GET /api/investment/current-prices - Obtener precios actuales de referencia
router.get('/current-prices', getCurrentPrices);

export default router;