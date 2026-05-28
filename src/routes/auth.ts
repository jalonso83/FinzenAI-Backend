import express, { Router } from 'express';
import { register, login, resendVerificationEmail, verifyEmail, verifyEmailFromLink, verifyEmailWithAttribution, forgotPassword, resetPassword, getProfile, updateProfile, changePassword, checkTrialEligibility, deleteAccount } from '../controllers/auth';
import { appleSignIn, googleSignIn } from '../controllers/sso';
import { skipOnboarding, completeOnboarding } from '../controllers/onboarding';
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
// SSO: Sign in with Apple / Google. Cubre tanto login como registro nuevo
// — el endpoint decide internamente vía linkeo automático por sub o email verificado.
router.post('/apple', loginLimiter, appleSignIn);
router.post('/google', loginLimiter, googleSignIn);
router.post('/resend-verification', emailVerificationLimiter, resendVerificationEmail);
router.post('/verify-email', emailVerificationLimiter, verifyEmail);
router.get('/verify-email-link', emailVerificationLimiter, verifyEmailFromLink);
router.post('/verify-email-with-attribution', emailVerificationLimiter, verifyEmailWithAttribution);
router.post('/forgot-password', passwordResetLimiter, forgotPassword);
router.post('/reset-password', passwordResetLimiter, resetPassword);
router.post('/check-trial-eligibility', apiLimiter, checkTrialEligibility);

// Rutas de perfil (requieren autenticación + rate limiting general)
router.get('/profile', apiLimiter, authenticateToken, getProfile);
router.put('/profile', apiLimiter, authenticateToken, updateProfile);
router.put('/change-password', apiLimiter, authenticateToken, changePassword);
router.delete('/account', apiLimiter, authenticateToken, deleteAccount);

// Skip onboarding (gateado por feature flag — ver controllers/config.ts)
router.post('/onboarding/skip', apiLimiter, authenticateToken, skipOnboarding);

// Complete onboarding (valida que exista perfil antes de marcar completed).
// Reemplaza el patrón legacy de PUT /auth/profile con onboardingCompleted=true.
router.post('/onboarding/complete', apiLimiter, authenticateToken, completeOnboarding);

export default router;