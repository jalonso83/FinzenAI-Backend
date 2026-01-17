import express, { Application } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { prisma, disconnectPrisma } from './lib/prisma';
import { BudgetScheduler } from './services/budgetScheduler';
import { EmailSyncScheduler } from './services/emailSyncScheduler';
import { ReminderScheduler } from './services/reminderScheduler';
import { AntExpenseScheduler } from './services/antExpenseScheduler';
import { GoalReminderScheduler } from './services/goalReminderScheduler';
import { TipScheduler } from './services/tipScheduler';
import { TrialScheduler } from './services/trialScheduler';
import { ReferralScheduler } from './services/referralScheduler';
import { validateReferralConfig } from './config/referralConfig';
import { initPrices } from './controllers/investment';

// Force deployment trigger - Email Sync Integration

// Importar rutas
import authRoutes from './routes/auth';
import transactionRoutes from './routes/transactions';
import budgetRoutes from './routes/budgets';
import zenioRoutes from './routes/zenio';
import categoryRoutes from './routes/categories';
import goalRoutes from './routes/goals';
import reportRoutes from './routes/reports';
import gamificationRoutes from './routes/gamification';
import investmentRoutes from './routes/investment';
import budgetSchedulerRoutes from './routes/budgetScheduler';
import subscriptionRoutes from './routes/subscriptions';
import emailSyncRoutes from './routes/emailSync';
import notificationRoutes from './routes/notifications';
import reminderRoutes from './routes/reminders';
import referralRoutes from './routes/referrals';
import webRoutes from './routes/web';

// Importar webhooks
import { handleStripeWebhook } from './webhooks/stripeWebhook';

// Importar rate limiters
import { webhookLimiter, apiLimiter } from './config/rateLimiter';

import { logger } from './utils/logger';
// Configurar variables de entorno
dotenv.config();

const app: Application = express();
const PORT = process.env.PORT || 3001;

// Habilitar trust proxy para obtener IP real detrás de Railway/proxies
app.set('trust proxy', 1);

// Webhook de Stripe - DEBE ir ANTES de express.json() para recibir raw body
app.post(
  '/webhooks/stripe',
  webhookLimiter,
  express.raw({ type: 'application/json' }),
  handleStripeWebhook
);

// Validación de CORS en producción
const corsOrigin = process.env.CORS_ORIGIN;
if (!corsOrigin && process.env.NODE_ENV === 'production') {
  throw new Error('CORS_ORIGIN must be set in production environment');
}

// Middleware
app.use(cors({
  origin: corsOrigin?.split(',') || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware de logging
app.use((req, res, next) => {
  logger.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Rutas Web (Universal Links, checkout pages) - SIN prefijo /api
app.use(webRoutes);

// Rutas API
app.use('/api/auth', authRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/budgets', budgetRoutes);
app.use('/api/zenio', zenioRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/goals', goalRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/gamification', gamificationRoutes);
app.use('/api/investment', investmentRoutes);
app.use('/api/scheduler', budgetSchedulerRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/email-sync', emailSyncRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/referrals', referralRoutes);

// Ruta de salud
app.get('/api/health', (req, res) => {
  return res.json({
    status: 'OK',
    message: 'FinZen AI Backend is running - Email Sync & AI Parser Ready',
    timestamp: new Date().toISOString(),
    version: process.env.APP_VERSION || '1.0.0'
  });
});

// Health check para Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Middleware de manejo de errores
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Error:', err);
  return res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Ruta 404
app.use('*', (req, res) => {
  return res.status(404).json({
    error: 'Not Found',
    message: 'Route not found'
  });
});

// Inicializar servidor
async function startServer() {
  try {
    // Validar configuración de referidos
    validateReferralConfig();

    // Conectar a la base de datos
    await prisma.$connect();
    logger.log('✅ Database connected successfully');

    // Iniciar scheduler de renovación de presupuestos
    BudgetScheduler.startScheduler();

    // Iniciar scheduler de sincronizacion de emails
    EmailSyncScheduler.startScheduler();

    // Iniciar scheduler de recordatorios de pago
    ReminderScheduler.startScheduler();

    // Iniciar scheduler de alertas de gastos hormiga
    AntExpenseScheduler.startScheduler();

    // Iniciar scheduler de recordatorios de metas
    GoalReminderScheduler.startScheduler();

    // Iniciar scheduler de tips financieros (IA)
    TipScheduler.startScheduler();

    // Iniciar scheduler de notificaciones de trial
    TrialScheduler.startScheduler();

    // Iniciar scheduler de expiración de referidos
    ReferralScheduler.startScheduler();

    // Inicializar precios de referencia para calculadoras
    await initPrices();

    // Iniciar servidor
    app.listen(PORT, () => {
      logger.log(`🚀 FinZen AI Backend running on port ${PORT}`);
      logger.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
    });
  } catch (error) {
    logger.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Manejo de señales de terminación
process.on('SIGINT', async () => {
  logger.log('\n🛑 Shutting down server...');
  BudgetScheduler.stopScheduler();
  EmailSyncScheduler.stopScheduler();
  ReminderScheduler.stopScheduler();
  AntExpenseScheduler.stopScheduler();
  GoalReminderScheduler.stopScheduler();
  TipScheduler.stopScheduler();
  TrialScheduler.stopScheduler();
  ReferralScheduler.stopScheduler();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.log('\n🛑 Shutting down server...');
  BudgetScheduler.stopScheduler();
  EmailSyncScheduler.stopScheduler();
  ReminderScheduler.stopScheduler();
  AntExpenseScheduler.stopScheduler();
  GoalReminderScheduler.stopScheduler();
  TipScheduler.stopScheduler();
  TrialScheduler.stopScheduler();
  ReferralScheduler.stopScheduler();
  await prisma.$disconnect();
  process.exit(0);
});

startServer();

export default app; 