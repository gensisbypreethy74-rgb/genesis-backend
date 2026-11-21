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
  // No default: a missing value must stop the server, not quietly use some
  // other database. Local development sets it in .env like everywhere else.
  MONGODB_URI: process.env.MONGODB_URI || '',
  JWT_SECRET: process.env.JWT_SECRET || '',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  ADMIN_JWT_EXPIRES_IN: process.env.ADMIN_JWT_EXPIRES_IN || '12h',
  // Extra origins only: the live sites and localhost are built into config/cors.ts.
  CORS_ORIGIN: process.env.CORS_ORIGIN || '',
  FRONTEND_URL: (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, ''),

  // Trimmed and unquoted: a pasted `"…apps.googleusercontent.com" ` would
  // otherwise never match the token's audience.
  GOOGLE_CLIENT_ID: (process.env.GOOGLE_CLIENT_ID || '').trim().replace(/^["']|["']$/g, ''),

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

/**
 * A storefront address a customer can open from an email: https, a real host
 * (not localhost), and an origin only. Emails go to real inboxes, so links
 * must never point at a developer's machine.
 */
export const isPublicSiteUrl = (value: string) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && u.pathname === '/' && !u.search && !u.hash;
  } catch {
    return false;
  }
};

/** Razorpay is usable only with a real key pair. */
export const razorpayConfigured = () => Boolean(ENV.RAZORPAY_KEY_ID && ENV.RAZORPAY_KEY_SECRET);

/** Render sets RENDER=true on every service it runs; anything there is a deployment. */
export const isDeployed = () => Boolean(process.env.RENDER);

/**
 * Simulated payments exist only so a developer without Razorpay keys can walk
 * through checkout locally. Never in production, never on a deployed server
 * (even one misconfigured with NODE_ENV=development), never when real keys exist.
 */
export const mockPaymentsAllowed = () => !isProduction() && !isDeployed() && !razorpayConfigured();

// Fail at boot instead of running with forgeable tokens or a half-configured
// payment flow.
const missing: string[] = [];
if (!ENV.JWT_SECRET) missing.push('JWT_SECRET');
if (!ENV.MONGODB_URI) missing.push('MONGODB_URI');
// A Render deploy is checked like production even if NODE_ENV was mistyped:
// otherwise FRONTEND_URL would silently become localhost in customer emails.
if (isProduction() || isDeployed()) {
  for (const key of ['MONGODB_URI', 'FRONTEND_URL', 'GOOGLE_CLIENT_ID', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'] as const) {
    if (!process.env[key]) missing.push(key);
  }
  // Checkout still works without it; only browser-closed payments go unrecovered.
  if (!ENV.RAZORPAY_WEBHOOK_SECRET) {
    console.warn('RAZORPAY_WEBHOOK_SECRET is not set: paid orders whose browser closed before verification will not be recovered.');
  }
  // Not fatal, so a missing email setup can never take checkout down: order
  // confirmations wait as "pending" and go out once it is configured.
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    console.warn('RESEND_API_KEY / EMAIL_FROM are not set: order confirmation emails are queued but not sent.');
  }
}
if (missing.length) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}
// Every link in customer emails is built on it.
if ((isProduction() || isDeployed()) && !isPublicSiteUrl(ENV.FRONTEND_URL)) {
  throw new Error('FRONTEND_URL must be the live storefront address over https, e.g. https://genesisbypreethy.com');
}

if (isDeployed() && !isProduction()) {
  console.warn(
    `WARNING: running on Render with NODE_ENV=${ENV.NODE_ENV}. Stack traces are sent to visitors, ` +
    'and the API rate limit is off. Set NODE_ENV=production.'
  );
}

/** Non-secret view of the running configuration, for checking a deploy from its logs. */
export const configSummary = () => {
  return [
    `NODE_ENV=${ENV.NODE_ENV}`,
    `FRONTEND_URL=${ENV.FRONTEND_URL}`,
    `Google client=${ENV.GOOGLE_CLIENT_ID ? ENV.GOOGLE_CLIENT_ID.slice(0, 12) + '…' : '(missing)'}`,
    `Razorpay=${ENV.RAZORPAY_KEY_ID.startsWith('rzp_live_') ? 'live' : ENV.RAZORPAY_KEY_ID.startsWith('rzp_test_') ? 'test' : '(missing)'}`,
    `webhook secret=${ENV.RAZORPAY_WEBHOOK_SECRET ? 'set' : 'MISSING'}`,
    `email=${process.env.RESEND_API_KEY && process.env.EMAIL_FROM ? 'on (Resend)' : 'off'}`,
    `email webhook secret=${process.env.RESEND_WEBHOOK_SECRET ? 'set' : 'MISSING'}`,
  ].join(' | ');
};
