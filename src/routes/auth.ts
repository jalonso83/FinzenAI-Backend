import express, { Router } from 'express';
import { register, login, verifyEmail, verifyEmailFromLink, forgotPassword, resetPassword, getProfile, updateProfile, changePassword, checkTrialEligibility } from '../controllers/auth';
import { authenticateToken } from '../middlewares/auth';
import {
  loginLimiter,
  registerLimiter,
  passwordResetLimiter,
  emailVerificationLimiter,
  apiLimiter,
} from '../config/rateLimiter';

const router: Router = express.Router();

// Rutas de autenticación (con rate limiting)
router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);
router.post('/verify-email', emailVerificationLimiter, verifyEmail);
router.get('/verify-email-link', emailVerificationLimiter, verifyEmailFromLink);
router.post('/forgot-password', passwordResetLimiter, forgotPassword);
router.post('/reset-password', passwordResetLimiter, resetPassword);
router.post('/check-trial-eligibility', apiLimiter, checkTrialEligibility);

// Rutas de perfil (requieren autenticación + rate limiting general)
router.get('/profile', apiLimiter, authenticateToken, getProfile);
router.put('/profile', apiLimiter, authenticateToken, updateProfile);
router.put('/change-password', apiLimiter, authenticateToken, changePassword);

export default router; 