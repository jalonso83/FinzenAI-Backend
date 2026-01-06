import express, { Router } from 'express';
import { authenticateToken as auth } from '../middlewares/auth';
import {
  getOrCreateReferralCode,
  validateReferralCode,
  getReferralStats,
  getPendingRewards,
  getReferralInfo,
} from '../controllers/referrals';

const router: Router = express.Router();

/**
 * @route   GET /api/referrals/info
 * @desc    Obtener información del sistema de referidos (público)
 * @access  Public
 */
router.get('/info', getReferralInfo);

/**
 * @route   GET /api/referrals/validate/:code
 * @desc    Validar un código de referido (público para pre-registro)
 * @access  Public
 */
router.get('/validate/:code', validateReferralCode);

/**
 * @route   GET /api/referrals/code
 * @desc    Obtener o generar código de referido del usuario
 * @access  Private
 */
router.get('/code', auth, getOrCreateReferralCode);

/**
 * @route   GET /api/referrals/stats
 * @desc    Obtener estadísticas de referidos del usuario
 * @access  Private
 */
router.get('/stats', auth, getReferralStats);

/**
 * @route   GET /api/referrals/rewards
 * @desc    Obtener recompensas pendientes del usuario
 * @access  Private
 */
router.get('/rewards', auth, getPendingRewards);

export default router;
