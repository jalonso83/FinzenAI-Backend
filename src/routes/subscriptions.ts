import express, { Router } from 'express';
import { authenticateToken as auth } from '../middlewares/auth';
import {
  createCheckout,
  getSubscription,
  getPlans,
  cancelSubscription,
  reactivateSubscription,
  createCustomerPortal,
  changePlan,
  getPaymentHistory,
  checkCheckoutSession,
} from '../controllers/subscriptions';

const router: Router = express.Router();

/**
 * @route   GET /api/subscriptions/plans
 * @desc    Obtener todos los planes disponibles
 * @access  Public
 */
router.get('/plans', getPlans);

/**
 * @route   POST /api/subscriptions/checkout
 * @desc    Crear sesión de checkout para upgrade
 * @access  Private
 */
router.post('/checkout', auth, createCheckout);

/**
 * @route   GET /api/subscriptions/current
 * @desc    Obtener suscripción actual del usuario
 * @access  Private
 */
router.get('/current', auth, getSubscription);

/**
 * @route   POST /api/subscriptions/cancel
 * @desc    Cancelar suscripción (al final del período)
 * @access  Private
 */
router.post('/cancel', auth, cancelSubscription);

/**
 * @route   POST /api/subscriptions/reactivate
 * @desc    Reactivar suscripción cancelada
 * @access  Private
 */
router.post('/reactivate', auth, reactivateSubscription);

/**
 * @route   POST /api/subscriptions/customer-portal
 * @desc    Crear sesión del portal de cliente de Stripe
 * @access  Private
 */
router.post('/customer-portal', auth, createCustomerPortal);

/**
 * @route   POST /api/subscriptions/change-plan
 * @desc    Cambiar de plan
 * @access  Private
 */
router.post('/change-plan', auth, changePlan);

/**
 * @route   GET /api/subscriptions/payments
 * @desc    Obtener historial de pagos
 * @access  Private
 */
router.get('/payments', auth, getPaymentHistory);

/**
 * @route   GET /api/subscriptions/checkout/:sessionId
 * @desc    Verificar estado de sesión de checkout
 * @access  Private
 */
router.get('/checkout/:sessionId', auth, checkCheckoutSession);

export default router;
