import { ENV } from './env';
import { PLANS } from './stripe';

/**
 * Admin configuration
 * Parses ADMIN_EMAILS from environment and exposes plan pricing
 */

// Parse comma-separated admin emails, trim whitespace and \r
const parseAdminEmails = (raw: string): string[] => {
  if (!raw) return [];
  return raw
    .split(',')
    .map(e => e.trim().replace(/\r/g, '').toLowerCase())
    .filter(Boolean);
};

export const ADMIN_EMAILS = parseAdminEmails(ENV.ADMIN_EMAILS);

// Plan prices from PLANS (source of truth)
export const PLAN_PRICES = {
  FREE: PLANS.FREE.price.monthly,
  PREMIUM: PLANS.PREMIUM.price.monthly,
  PRO: PLANS.PRO.price.monthly,
} as const;
