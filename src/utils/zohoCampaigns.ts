import { ENV } from '../config/env';
import logger, { maskEmail } from './logger';

/**
 * Zoho Campaigns newsletter integration.
 *
 * Adds subscribers to (and removes them from) the "Genesis Newsletter" mailing
 * list via the Campaigns listsubscribe / listunsubscribe APIs. Access tokens are
 * short-lived (1 hour), so we mint them on demand from the long-lived refresh
 * token and cache them in memory.
 *
 * IMPORTANT — required OAuth scope:
 *   These endpoints require `ZohoCampaigns.contact.UPDATE`
 *   (or `ZohoCampaigns.contact.ALL`). A refresh token generated with only
 *   `ZohoCampaigns.contact.CREATE`/`READ` will authenticate but every
 *   call returns HTTP 401. Regenerate the refresh token with the
 *   UPDATE scope if you see persistent 401s here.
 */

const accountsBase = () => `https://accounts.zoho.${ENV.ZOHO_DC}`;
const campaignsBase = () => `https://campaigns.zoho.${ENV.ZOHO_DC}`;

/** True only when every credential needed to talk to Zoho is present. */
export const isZohoConfigured = (): boolean =>
  Boolean(
    ENV.ZOHO_CLIENT_ID &&
      ENV.ZOHO_CLIENT_SECRET &&
      ENV.ZOHO_REFRESH_TOKEN &&
      ENV.ZOHO_LIST_KEY
  );

// In-memory access-token cache. Reset on process restart, which is fine.
let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * Return a valid access token, refreshing (and caching) when needed.
 * `forceRefresh` bypasses the cache — used to recover from a revoked token.
 */
const getAccessToken = async (forceRefresh = false): Promise<string> => {
  const now = Date.now();
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.value;
  }

  const params = new URLSearchParams({
    refresh_token: ENV.ZOHO_REFRESH_TOKEN,
    client_id: ENV.ZOHO_CLIENT_ID,
    client_secret: ENV.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });

  const res = await fetch(`${accountsBase()}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Zoho token refresh failed: ${data.error || res.status} (${res.statusText})`);
  }

  // expires_in is in seconds; refresh 60s early to avoid edge-of-expiry races.
  const ttlMs = (Number(data.expires_in) || 3600) * 1000;
  cachedToken = { value: data.access_token, expiresAt: now + ttlMs - 60_000 };
  return cachedToken.value;
};

export interface ZohoSubscribeResult {
  ok: boolean;
  skipped?: boolean; // Zoho not configured — nothing attempted
  message?: string;
}

/**
 * Subscribe or unsubscribe an email on the configured Zoho Campaigns list.
 * Never throws — returns a result object so callers can treat Zoho as
 * best-effort and keep the user-facing flow resilient.
 */
const callZohoList = async (
  action: 'listsubscribe' | 'listunsubscribe',
  email: string,
  source?: string
): Promise<ZohoSubscribeResult> => {
  if (!isZohoConfigured()) {
    return { ok: false, skipped: true, message: 'Zoho not configured' };
  }

  const doRequest = async (token: string): Promise<Response> => {
    const url = new URL(`${campaignsBase()}/api/v1.1/json/${action}`);
    url.searchParams.set('resfmt', 'JSON');
    url.searchParams.set('listkey', ENV.ZOHO_LIST_KEY);
    url.searchParams.set('contactinfo', JSON.stringify({ 'Contact Email': email }));
    if (source) url.searchParams.set('source', source);
    return fetch(url.toString(), {
      method: 'POST',
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
  };

  try {
    let token = await getAccessToken();
    let res = await doRequest(token);

    // A 401 can mean a revoked/expired cached token — retry once with a fresh
    // one. If it 401s again, the token most likely lacks the UPDATE scope.
    if (res.status === 401) {
      token = await getAccessToken(true);
      res = await doRequest(token);
    }

    const raw = await res.text();
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null; // Zoho returns an HTML page for gateway-level 401s
    }

    // Zoho signals success with code "0".
    if (res.ok && data && String(data.code) === '0') {
      return { ok: true, message: data.message || 'Done' };
    }

    const detail =
      (data && (data.message || data.code)) ||
      (res.status === 401
        ? 'Unauthorized — refresh token likely missing the ZohoCampaigns.contact.UPDATE scope'
        : `HTTP ${res.status}`);
    logger.warn(`Zoho ${action} did not succeed for ${maskEmail(email)}: ${detail}`);
    return { ok: false, message: String(detail) };
  } catch (err: any) {
    logger.error(`Zoho ${action} error for ${maskEmail(email)}: ${err?.message || err}`);
    return { ok: false, message: err?.message || 'Zoho request failed' };
  }
};

export const subscribeToZohoList = (email: string, source?: string) => callZohoList('listsubscribe', email, source);
export const unsubscribeFromZohoList = (email: string) => callZohoList('listunsubscribe', email);
