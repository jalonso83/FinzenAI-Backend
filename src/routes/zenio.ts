import express, { Router } from 'express';
import { chatWithZenio, getChatHistory, createTransactionFromZenio, createBudgetFromZenio, transcribeAudio } from '../controllers/zenio';
import { authenticateToken } from '../middlewares/auth';
import { saveOnboarding } from '../controllers/onboarding';
import { analyzeAntExpenses, getAntExpenseConfig } from '../controllers/antExpenseDetective';
import { checkZenioLimit } from '../middleware/planLimits';
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
  }
});

// Todas las rutas requieren autenticación
router.use(authenticateToken);

// Rutas de Zenio (Asistente IA) - con validación de límite
router.post('/chat', checkZenioLimit, chatWithZenio);
router.get('/history', getChatHistory);

// Ruta para crear transacciones desde Zenio
router.post('/transaction', createTransactionFromZenio);

// Ruta para crear presupuestos desde Zenio
router.post('/budget', createBudgetFromZenio);

// Ruta para guardar el onboarding
router.post('/onboarding', saveOnboarding);

// Rutas para análisis de gastos hormiga con Zenio
// GET /api/zenio/ant-expense-config - Obtener configuración y opciones disponibles
router.get('/ant-expense-config', getAntExpenseConfig);
// GET /api/zenio/ant-expense-analysis - Analizar gastos hormiga
// Query params opcionales: antThreshold, minFrequency, monthsToAnalyze, useAI
router.get('/ant-expense-analysis', analyzeAntExpenses);

// Ruta para transcribir audio con Whisper
router.post('/transcribe', upload.single('audio'), transcribeAudio);

export default router; 