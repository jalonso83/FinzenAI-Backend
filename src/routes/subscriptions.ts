import express, { Router } from 'express';
import { authenticateToken as auth } from '../middlewares/auth';
import {
  createCheckout,
  startTrial,
  getSubscription,
  getPlans,
  cancelSubscription,
  reactivateSubscription,
  createCustomerPortal,
  changePlan,
  getPaymentHistory,
  checkCheckoutSession,
  getTrialExpiryState,
  recordTrialExpiryEvent,
} from '../controllers/subscriptions';

const router: Router = express.Router();

/**
 * @route   GET /api/subscriptions/plans
 * @desc    Obtener todos los planes disponibles
 * @access  Public
 */
router.get('/plans', getPlans);

/**
 * @route   POST /api/subscriptions/start-trial
 * @desc    Iniciar período de prueba de 7 días (sin tarjeta)
 * @access  Private
 */
router.post('/start-trial', auth, startTrial);

/**
 * @route   GET /api/subscriptions/trial-expiry
 * @desc    Qué perdió y qué conserva el usuario tras vencer el trial (D6).
 *          La app pinta lo que responda esto; no decide nada por su cuenta,
 *          para poder ablandar el vencimiento sin otro ciclo de tienda.
 * @access  Private
 */
router.get('/trial-expiry', auth, getTrialExpiryState);

/**
 * @route   POST /api/subscriptions/trial-expiry/event
 * @desc    Eventos de la pantalla de vencimiento: 'vio' | 'toco_recuperar' | 'cerro'.
 *          Entra antes que la pantalla, a propósito: sin un "antes" no se puede
 *          saber si la pantalla nueva sirvió de algo.
 * @access  Private
 */
router.post('/trial-expiry/event', auth, recordTrialExpiryEvent);

/**
 * @route   POST /api/subscriptions/checkout
 * @desc    Crear sesión de checkout para upgrade (después del trial)
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
