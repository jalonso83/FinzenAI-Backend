import express, { Router } from 'express';
import { chatWithZenio, getChatHistory, createTransactionFromZenio, createBudgetFromZenio } from '../controllers/zenio';
import { authenticateToken } from '../middlewares/auth';
import { saveOnboarding } from '../controllers/onboarding';

const router: Router = express.Router();

// Todas las rutas requieren autenticación
router.use(authenticateToken);

// Rutas de Zenio (Asistente IA)
router.post('/chat', chatWithZenio);
router.get('/history', getChatHistory);

// Ruta para crear transacciones desde Zenio
router.post('/transaction', createTransactionFromZenio);

// Ruta para crear presupuestos desde Zenio
router.post('/budget', createBudgetFromZenio);

// Ruta para guardar el onboarding
router.post('/onboarding', saveOnboarding);

export default router; 