/**
 * Rutas Zenio V2 - Responses API
 *
 * Montadas en /api/zenio/v2 en paralelo con las rutas actuales /api/zenio.
 * Misma estructura de rutas, mismo middleware, pero apuntando a zenioV2 controller.
 */

import express, { Router, Request, Response } from 'express';
import {
  chatWithZenioV2,
  getChatHistoryV2,
  createTransactionFromZenioV2,
  createBudgetFromZenioV2,
  transcribeAudioV2,
} from '../controllers/zenioV2';
import { authenticateToken } from '../middlewares/auth';
import { saveOnboarding } from '../controllers/onboarding';
import { analyzeAntExpenses, getAntExpenseConfig } from '../controllers/antExpenseDetective';
import { checkZenioLimit } from '../middleware/planLimits';
import { strictApiLimiter, apiLimiter } from '../config/rateLimiter';
import multer from 'multer';

const router: Router = express.Router();

// Configurar multer para archivos de audio
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB máximo
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos de audio'));
    }
  },
});

// Todas las rutas requieren autenticación
router.use(authenticateToken);

// Rutas de Zenio V2 (Responses API)
router.post('/chat', strictApiLimiter, checkZenioLimit, chatWithZenioV2);
router.get('/history', apiLimiter, getChatHistoryV2);

// Ruta para crear transacciones desde Zenio V2
router.post('/transaction', apiLimiter, createTransactionFromZenioV2);

// Ruta para crear presupuestos desde Zenio V2
router.post('/budget', apiLimiter, createBudgetFromZenioV2);

// Ruta para guardar el onboarding (reutiliza el original)
router.post('/onboarding', apiLimiter, saveOnboarding);

// Rutas para análisis de gastos hormiga (reutiliza los originales)
router.get('/ant-expense-config', apiLimiter, getAntExpenseConfig);
router.get('/ant-expense-analysis', strictApiLimiter, analyzeAntExpenses);

// Ruta para transcribir audio con Whisper
router.post('/transcribe', strictApiLimiter, upload.single('audio'), transcribeAudioV2);

export default router;
