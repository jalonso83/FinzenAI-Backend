import express, { Router } from 'express';
import { authenticateToken as auth } from '../middlewares/auth';
import { verifyPurchase, restorePurchases, getStatus } from '../controllers/revenueCat';

const router: Router = express.Router();

/**
 * @route   POST /api/subscriptions/rc/verify-purchase
 * @desc    Verificar compra de RevenueCat y sincronizar DB
 * @access  Private
 */
router.post('/verify-purchase', auth, verifyPurchase);

/**
 * @route   POST /api/subscriptions/rc/restore
 * @desc    Restaurar compras de RevenueCat
 * @access  Private
 */
router.post('/restore', auth, restorePurchases);

/**
 * @route   GET /api/subscriptions/rc/status
 * @desc    Obtener estado de suscripción
 * @access  Private
 */
router.get('/status', auth, getStatus);

export default router;
