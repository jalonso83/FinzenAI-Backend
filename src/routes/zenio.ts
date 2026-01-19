import express, { Router, Request, Response } from 'express';
import { chatWithZenio, getChatHistory, createTransactionFromZenio, createBudgetFromZenio, transcribeAudio } from '../controllers/zenio';
import { authenticateToken } from '../middlewares/auth';
import { saveOnboarding } from '../controllers/onboarding';
import { analyzeAntExpenses, getAntExpenseConfig } from '../controllers/antExpenseDetective';
import { checkZenioLimit } from '../middleware/planLimits';
import { strictApiLimiter, apiLimiter } from '../config/rateLimiter';
import { AntExpenseScheduler } from '../services/antExpenseScheduler';
import multer from 'multer';

const router: Router = express.Router();

// Endpoint de prueba para alertas de gastos hormiga (requiere API key, no auth)
router.post('/test-ant-alert/:userId', async (req: Request, res: Response) => {
  const apiKey = req.headers['x-api-key'];
  const expectedKey = process.env.CRON_API_KEY || 'default-cron-key';

  if (apiKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { userId } = req.params;
  const period = (req.query.period as 'weekly' | 'monthly') || 'weekly';

  try {
    const result = await AntExpenseScheduler.analyzeUser(userId, period);
    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

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

// Rutas de Zenio (Asistente IA) - con validación de límite + rate limiting estricto
router.post('/chat', strictApiLimiter, checkZenioLimit, chatWithZenio);
router.get('/history', apiLimiter, getChatHistory);

// Ruta para crear transacciones desde Zenio
router.post('/transaction', apiLimiter, createTransactionFromZenio);

// Ruta para crear presupuestos desde Zenio
router.post('/budget', apiLimiter, createBudgetFromZenio);

// Ruta para guardar el onboarding
router.post('/onboarding', apiLimiter, saveOnboarding);

// Rutas para análisis de gastos hormiga con Zenio (usan IA = estricto)
router.get('/ant-expense-config', apiLimiter, getAntExpenseConfig);
router.get('/ant-expense-analysis', strictApiLimiter, analyzeAntExpenses);

// Ruta para transcribir audio con Whisper (usa IA = estricto)
router.post('/transcribe', strictApiLimiter, upload.single('audio'), transcribeAudio);

export default router; 