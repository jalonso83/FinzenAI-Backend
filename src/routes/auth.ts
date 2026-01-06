import express, { Router } from 'express';
import { register, login, verifyEmail, forgotPassword, resetPassword, getProfile, updateProfile, changePassword, checkTrialEligibility } from '../controllers/auth';
import { authenticateToken } from '../middlewares/auth';

const router: Router = express.Router();

// Rutas de autenticación
router.post('/register', register);
router.post('/login', login);
router.post('/verify-email', verifyEmail);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/check-trial-eligibility', checkTrialEligibility);

// Rutas de perfil (requieren autenticación)
router.get('/profile', authenticateToken, getProfile);
router.put('/profile', authenticateToken, updateProfile);
router.put('/change-password', authenticateToken, changePassword);

export default router; 