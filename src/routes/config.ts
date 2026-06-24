import express, { Router } from 'express';
import { getFeatures, markAppEntered } from '../controllers/config';
import { authenticateToken } from '../middlewares/auth';
import { apiLimiter } from '../config/rateLimiter';

const router: Router = express.Router();

// Devuelve los feature flags del usuario autenticado
router.get('/features', apiLimiter, authenticateToken, getFeatures);

// Marca que el usuario llegó al dashboard (señal de entrada para H10)
router.post('/app-entered', apiLimiter, authenticateToken, markAppEntered);

export default router;
