// Deploy trigger: dashboard analytics overhaul (funnel cohorte, retención, churn por payments, daily_open)
import express, { Application } from 'express';
import helmet from 'helmet';
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
import { BudgetReminderScheduler } from './services/budgetReminderScheduler';
import { WeeklyReportScheduler } from './services/weeklyReportScheduler';
import { ExchangeRateScheduler } from './services/exchangeRateScheduler';
import { AttributionRetryScheduler } from './services/attributionRetryScheduler';
import startOpenAiUsageProcessor from './schedulers/openaiUsageProcessor';
import { validateReferralConfig } from './config/referralConfig';
import { initPrices } from './controllers/investment';

// Force deployment trigger - Email Sync Integration

// Importar rutas
import authRoutes from './routes/auth';
import transactionRoutes from './routes/transactions';
import budgetRoutes from './routes/budgets';
import zenioRoutes from './routes/zenio';
import zenioV2Routes from './routes/zenioV2';
import zenioAgentsRoutes from './routes/zenioAgents';
import ttsRoutes from './routes/tts';
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
import weeklyReportRoutes from './routes/weeklyReports';
import webRoutes from './routes/web';
import oauthTestRoutes from './routes/oauthTest';
import revenueCatRoutes from './routes/revenueCat';
import adminRoutes from './routes/admin';
import exchangeRateRoutes from './routes/exchangeRates';
import openaiCostsRoutes from './routes/openaiCosts';
import eventsRoutes from './routes/events';
import feedbackRoutes from './routes/feedback';

// Importar webhooks
import { handleStripeWebhook } from './webhooks/stripeWebhook';
import { handleRevenueCatWebhook } from './webhooks/revenueCatWebhook';

// Importar rate limiters
import { webhookLimiter, apiLimiter } from './config/rateLimiter';

import { logger } from './utils/logger';
// Configurar variables de entorno
dotenv.config();

const app: Application = express();
const PORT = process.env.PORT || 3001;

// Habilitar trust proxy para obtener IP real detrás de Railway/proxies
app.set('trust proxy', 1);

// Block TRACE and TRACK methods (prevents proxy fingerprinting - CASA CWE-204)
app.use((req, res, next) => {
  if (req.method === 'TRACE' || req.method === 'TRACK') {
    return res.status(405).set('Allow', 'GET, POST, PUT, PATCH, DELETE, OPTIONS').end();
  }
  next();
});

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

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hidePoweredBy: true,
}));

// Remove proxy disclosure headers and hide server identity
app.use((req, res, next) => {
  res.removeHeader('Via');
  res.removeHeader('X-Powered-By');
  res.removeHeader('X-Cache');
  res.removeHeader('X-Cache-Hits');
  res.removeHeader('X-Served-By');
  res.removeHeader('X-Timer');
  res.setHeader('Server', 'FinZenAI');
  next();
});

// Prevent caching of all responses (CASA CWE-524)
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Middleware
app.use(cors({
  origin: corsOrigin?.split(',') || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Webhook de RevenueCat (JSON body, después de express.json)
app.post('/webhooks/revenuecat', webhookLimiter, handleRevenueCatWebhook);

// Middleware de logging
app.use((req, res, next) => {
  logger.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Rutas Web (Universal Links, checkout pages) - SIN prefijo /api
app.use(webRoutes);

// OAuth Test Page — DESHABILITADO (ya no necesario para verificacion de Google)
// app.use(oauthTestRoutes);

// Rate limiting global para todas las rutas API
app.use('/api', apiLimiter);

// Rutas API
app.use('/api/auth', authRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/budgets', budgetRoutes);
app.use('/api/zenio', zenioRoutes);
app.use('/api/zenio/v2', zenioV2Routes);
app.use('/api/zenio/agents', zenioAgentsRoutes);
app.use('/api/tts', ttsRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/goals', goalRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/gamification', gamificationRoutes);
app.use('/api/investment', investmentRoutes);
app.use('/api/scheduler', budgetSchedulerRoutes);
app.use('/api/subscriptions/rc', revenueCatRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/email-sync', emailSyncRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/weekly-reports', weeklyReportRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/openai-costs', openaiCostsRoutes);
app.use('/api/exchange-rates', exchangeRateRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/feedback', feedbackRoutes);

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

    // Iniciar scheduler de recordatorios de presupuesto (Nivel 2)
    BudgetReminderScheduler.startScheduler();

    // Iniciar scheduler de tips financieros (IA)
    TipScheduler.startScheduler();

    // Iniciar scheduler de notificaciones de trial
    TrialScheduler.startScheduler();

    // Iniciar scheduler de expiración de referidos
    ReferralScheduler.startScheduler();

    // Iniciar scheduler de reportes semanales PRO
    WeeklyReportScheduler.startScheduler();

    // Iniciar scheduler de tasas de cambio (medianoche)
    ExchangeRateScheduler.startScheduler();

    // Iniciar scheduler de retry de eventos de attribution (cada 5 min)
    AttributionRetryScheduler.startScheduler();

    // Iniciar scheduler de procesamiento de uso de OpenAI (cada 5 minutos)
    startOpenAiUsageProcessor();

    // Inicializar precios de referencia para calculadoras
    await initPrices();

    // OpenAI cost tracking: Feature display names mapped (2026-04-23)
    logger.log('[APP] OpenAI cost tracking initialized with display names');

    // Iniciar servidor
    const server = app.listen(PORT, () => {
      logger.log(`🚀 FinZen AI Backend running on port ${PORT}`);
      logger.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
      logger.log('✅ User status filters: NO_VERIFICADO, SIN_ONBOARDING, EN_TRIAL, ACTIVO, CANCELADO');
    });
    server.setTimeout(120000); // 2 minutos máximo por request
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
  BudgetReminderScheduler.stopScheduler();
  TipScheduler.stopScheduler();
  TrialScheduler.stopScheduler();
  ReferralScheduler.stopScheduler();
  WeeklyReportScheduler.stopScheduler();
  ExchangeRateScheduler.stopScheduler();
  AttributionRetryScheduler.stopScheduler();
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
  BudgetReminderScheduler.stopScheduler();
  TipScheduler.stopScheduler();
  TrialScheduler.stopScheduler();
  ReferralScheduler.stopScheduler();
  WeeklyReportScheduler.stopScheduler();
  ExchangeRateScheduler.stopScheduler();
  AttributionRetryScheduler.stopScheduler();
  await prisma.$disconnect();
  process.exit(0);
});

startServer();

export default app; 