import dotenv from 'dotenv';

// Tests configure everything explicitly and must never pick up the real .env
// (it can hold live payment and email credentials).
if (process.env.NODE_ENV !== 'test') dotenv.config();

export const ENV = {
  // Defaults to production so a deploy that forgets NODE_ENV gets the safe
  // behaviour (no stack traces, rate limiting on, secure cookies). Local .env
  // sets NODE_ENV=development explicitly.
  NODE_ENV: process.env.NODE_ENV || 'production',
  PORT: process.env.PORT || 5000,
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/heedy-db',
  JWT_SECRET: process.env.JWT_SECRET || '',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  ADMIN_JWT_EXPIRES_IN: process.env.ADMIN_JWT_EXPIRES_IN || '12h',
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:3000',
  FRONTEND_URL: (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, ''),

  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',

  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || '',
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || '',
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || '',

  // Zoho Campaigns (newsletter). DC is the data-center suffix for the account
  // that issued the OAuth token — India accounts use "in" (accounts.zoho.in /
  // campaigns.zoho.in), others use "com", "eu", "com.au", "jp".
  ZOHO_DC: process.env.ZOHO_DC || 'in',
  ZOHO_CLIENT_ID: process.env.ZOHO_CLIENT_ID || '',
  ZOHO_CLIENT_SECRET: process.env.ZOHO_CLIENT_SECRET || '',
  ZOHO_REFRESH_TOKEN: process.env.ZOHO_REFRESH_TOKEN || '',
  ZOHO_LIST_KEY: process.env.ZOHO_LIST_KEY || '',
};

export const isProduction = () => ENV.NODE_ENV === 'production';

/** Razorpay is usable only with a real key pair. */
export const razorpayConfigured = () => Boolean(ENV.RAZORPAY_KEY_ID && ENV.RAZORPAY_KEY_SECRET);

/**
 * Simulated payments exist only so a developer without Razorpay keys can walk
 * through checkout locally. Never in production, never when real keys exist.
 */
export const mockPaymentsAllowed = () => !isProduction() && !razorpayConfigured();

// Fail at boot instead of running with forgeable tokens or a half-configured
// payment flow.
const missing: string[] = [];
if (!ENV.JWT_SECRET) missing.push('JWT_SECRET');
if (isProduction()) {
  for (const key of ['MONGODB_URI', 'FRONTEND_URL', 'GOOGLE_CLIENT_ID', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'] as const) {
    if (!process.env[key]) missing.push(key);
  }
  // Checkout still works without it; only browser-closed payments go unrecovered.
  if (!ENV.RAZORPAY_WEBHOOK_SECRET) {
    console.warn('RAZORPAY_WEBHOOK_SECRET is not set: paid orders whose browser closed before verification will not be recovered.');
  }
}
if (missing.length) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}
