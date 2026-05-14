import express, { Router } from 'express';
import { getFeatures } from '../controllers/config';
import { authenticateToken } from '../middlewares/auth';
import { apiLimiter } from '../config/rateLimiter';

const router: Router = express.Router();

// Devuelve los feature flags del usuario autenticado
router.get('/features', apiLimiter, authenticateToken, getFeatures);

export default router;
