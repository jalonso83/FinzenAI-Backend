import { ENV } from './env';

// RevenueCat REST API
export const REVENUECAT_API_URL = 'https://api.revenuecat.com/v1';
export const REVENUECAT_API_KEY = ENV.REVENUECAT_SECRET_KEY;
export const REVENUECAT_WEBHOOK_AUTH = ENV.REVENUECAT_WEBHOOK_AUTH_HEADER;

// Mapeo de entitlements de RevenueCat a planes internos
export const ENTITLEMENT_TO_PLAN: Record<string, 'PRO' | 'PREMIUM'> = {
  'FinZen AI Pro': 'PRO',
  'FinZen AI Premium': 'PREMIUM',
};

// Mapeo de product IDs de App Store a plan + periodo
export const PRODUCT_TO_PLAN: Record<string, { plan: 'PRO' | 'PREMIUM'; period: 'monthly' | 'yearly' }> = {
  'pro_monthly': { plan: 'PRO', period: 'monthly' },
  'pro_yearly': { plan: 'PRO', period: 'yearly' },
  'premium_monthly': { plan: 'PREMIUM', period: 'monthly' },
  'premium_yearly': { plan: 'PREMIUM', period: 'yearly' },
};

// Eventos de webhook de RevenueCat
export const RC_WEBHOOK_EVENTS = {
  INITIAL_PURCHASE: 'INITIAL_PURCHASE',
  RENEWAL: 'RENEWAL',
  CANCELLATION: 'CANCELLATION',
  UNCANCELLATION: 'UNCANCELLATION',
  EXPIRATION: 'EXPIRATION',
  BILLING_ISSUE_DETECTED: 'BILLING_ISSUE_DETECTED',
  PRODUCT_CHANGE: 'PRODUCT_CHANGE',
  TRANSFER: 'TRANSFER',
} as const;
