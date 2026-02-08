/**
 * Validación centralizada de variables de entorno
 * El servidor NO iniciará si faltan variables críticas en producción
 */

const isProduction = process.env.NODE_ENV === 'production';

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value;
}

function getOptionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function getRequiredInProduction(key: string, devDefault: string): string {
  const value = process.env[key];
  if (!value && isProduction) {
    throw new Error(`Environment variable ${key} is required in production`);
  }
  return value || devDefault;
}

// Validar todas las variables al importar este módulo
export const ENV = {
  // === CRÍTICAS (siempre requeridas) ===
  JWT_SECRET: getRequiredEnv('JWT_SECRET'),

  // === CRÍTICAS EN PRODUCCIÓN ===
  STRIPE_SECRET_KEY: getRequiredInProduction('STRIPE_SECRET_KEY', 'sk_test_placeholder'),
  STRIPE_WEBHOOK_SECRET: getRequiredInProduction('STRIPE_WEBHOOK_SECRET', 'whsec_placeholder'),
  OPENAI_API_KEY: getRequiredInProduction('OPENAI_API_KEY', 'sk-placeholder'),

  // === STRIPE PRICE IDS ===
  STRIPE_PLUS_MONTHLY_PRICE_ID: getOptionalEnv('STRIPE_PLUS_MONTHLY_PRICE_ID', ''),
  STRIPE_PLUS_YEARLY_PRICE_ID: getOptionalEnv('STRIPE_PLUS_YEARLY_PRICE_ID', ''),
  STRIPE_PRO_MONTHLY_PRICE_ID: getOptionalEnv('STRIPE_PRO_MONTHLY_PRICE_ID', ''),
  STRIPE_PRO_YEARLY_PRICE_ID: getOptionalEnv('STRIPE_PRO_YEARLY_PRICE_ID', ''),

  // === EMAIL SERVICE ===
  RESEND_API_KEY: getOptionalEnv('RESEND_API_KEY', ''),

  // === OPENAI ===
  OPENAI_ASSISTANT_ID: getOptionalEnv('OPENAI_ASSISTANT_ID', ''),

  // === GOOGLE OAUTH ===
  GOOGLE_CLIENT_ID: getOptionalEnv('GOOGLE_CLIENT_ID', ''),
  GOOGLE_CLIENT_SECRET: getOptionalEnv('GOOGLE_CLIENT_SECRET', ''),
  GOOGLE_REDIRECT_URI: getOptionalEnv(
    'GOOGLE_REDIRECT_URI',
    'https://finzenai-backend-production.up.railway.app/api/email-sync/gmail/callback'
  ),

  // === MICROSOFT OAUTH ===
  MICROSOFT_CLIENT_ID: getOptionalEnv('MICROSOFT_CLIENT_ID', ''),
  MICROSOFT_CLIENT_SECRET: getOptionalEnv('MICROSOFT_CLIENT_SECRET', ''),
  MICROSOFT_REDIRECT_URI: getOptionalEnv(
    'MICROSOFT_REDIRECT_URI',
    'https://finzenai-backend-production.up.railway.app/api/email-sync/outlook/callback'
  ),

  // === FIREBASE ===
  FIREBASE_SERVICE_ACCOUNT: getOptionalEnv('FIREBASE_SERVICE_ACCOUNT', ''),

  // === URLs ===
  BACKEND_URL: getOptionalEnv('BACKEND_URL', 'https://finzenai-backend-production.up.railway.app'),
  FRONTEND_URL: getOptionalEnv('FRONTEND_URL', 'http://localhost:5173'),
  APP_URL: getOptionalEnv('APP_URL', 'https://finzenai.com'),

  // === REVENUECAT ===
  REVENUECAT_SECRET_KEY: getOptionalEnv('REVENUECAT_SECRET_KEY', ''),
  REVENUECAT_WEBHOOK_AUTH_HEADER: getOptionalEnv('REVENUECAT_WEBHOOK_AUTH_HEADER', ''),

  // === SERVER ===
  PORT: getOptionalEnv('PORT', '3001'),
  NODE_ENV: getOptionalEnv('NODE_ENV', 'development'),
  CORS_ORIGIN: getOptionalEnv('CORS_ORIGIN', 'http://localhost:5173'),
  APP_VERSION: getOptionalEnv('APP_VERSION', '1.0.0'),

  // === HELPERS ===
  isProduction,
  isDevelopment: !isProduction,
};

// Log de validación exitosa (solo en desarrollo)
if (!isProduction) {
  console.log('✅ Environment variables validated successfully');
}
