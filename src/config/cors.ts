import { ENV, isProduction, isDeployed } from './env';

/** The live sites. Built in, so a missing or mistyped CORS_ORIGIN on Render can't lock them out. */
export const PRODUCTION_ORIGINS = [
  'https://genesisbypreethy.com',
  'https://www.genesisbypreethy.com',
  'https://admin.genesisbypreethy.com',
];

/** Local storefront and admin dev servers. Never allowed on a deployed server. */
export const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:3001'];

// Browsers send origins without a trailing slash; a pasted "https://x.com/" would never match.
const normalize = (origin: string) => origin.trim().replace(/\/+$/, '').toLowerCase();
const isLocal = (origin: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

/**
 * Browser origins allowed to call the API with credentials: the live sites,
 * any extras in CORS_ORIGIN (e.g. a Vercel preview URL), and localhost only
 * when not deployed.
 */
export function allowedOrigins(extra = ENV.CORS_ORIGIN, deployed = isProduction() || isDeployed()) {
  const fromEnv = extra.split(',').map(normalize).filter(Boolean);
  return new Set([
    ...PRODUCTION_ORIGINS,
    ...(deployed ? [] : DEV_ORIGINS),
    ...fromEnv.filter((origin) => !(deployed && isLocal(origin))),
  ]);
}
