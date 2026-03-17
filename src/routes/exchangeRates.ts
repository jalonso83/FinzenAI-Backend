import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth';
import { getAllExchangeRates, getExchangeRate } from '../controllers/exchangeRates';

const router: Router = Router();

// Require authentication
router.use(authenticateToken);

// GET /api/exchange-rates - Get all current rates
router.get('/', getAllExchangeRates);

// GET /api/exchange-rates/:currency - Get rate for specific currency
router.get('/:currency', getExchangeRate);

export default router;
