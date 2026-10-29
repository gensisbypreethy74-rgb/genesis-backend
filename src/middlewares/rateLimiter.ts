import rateLimit from 'express-rate-limit';

// General API rate limiter.
// A single storefront page load fans out to ~8 public content endpoints
// (banner, categories, category-section, moment, founder-note, studio-note,
// products, story), doubled by React StrictMode in dev — so 100/15min locked
// out a visitor after a dozen views. This ceiling is an abuse guard, not a
// per-page budget; it must clear normal browsing (incl. shared-NAT IPs) with
// room to spare. Disabled entirely in development (StrictMode + HMR + local
// testing would otherwise trip it).
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 2000, // per IP per window
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV !== 'production',
});

// Strict rate limiter for authentication endpoints (admin password, Google)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 failed login attempts per windowMs
  message: { success: false, message: 'Too many login attempts from this IP, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful requests
});

// Payment rate limiter
export const paymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // Limit each IP to 10 payment requests per minute
  message: { success: false, message: 'Too many payment requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Public forms that trigger outbound email or reveal order status
export const newsletterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { success: false, message: 'Too many sign-ups from this connection. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const trackOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { success: false, message: 'Too many tracking requests. Please try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
