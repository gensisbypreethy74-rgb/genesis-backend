import logger, { maskEmail } from './logger';

// Email configuration interface
interface EmailOptions {
  email: string;
  subject: string;
  message?: string;
  html?: string;
  headers?: Record<string, string>;
}

const SENDGRID_ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

/**
 * Whether outbound email is configured. Requires both an API key and a verified
 * sender address. When either is missing we skip sending (no-op) so the app
 * behaves exactly as before until the client supplies real credentials.
 */
export const isEmailConfigured = (): boolean => {
  const key = process.env.SENDGRID_API_KEY?.trim();
  const from = process.env.SENDGRID_FROM_EMAIL?.trim();
  return Boolean(key && from);
};

/**
 * Send a transactional email via the SendGrid v3 HTTP API.
 *
 * - If email is not configured (missing key / sender), this is a safe no-op that
 *   logs and returns `{ skipped: true }` — preserving the previous behaviour.
 * - Never throws on a delivery failure: order flows must not break because an
 *   email couldn't be sent. Failures are logged and returned as `{ success: false }`.
 *
 * @param options - Email options (recipient, subject, content)
 */
export const sendEmail = async (options: EmailOptions): Promise<any> => {
  // Validate recipient to preserve previous behaviour for callers.
  if (!options.email || !options.email.includes('@')) {
    throw new Error('Invalid recipient email address');
  }

  const to = maskEmail(options.email);
  if (!isEmailConfigured()) {
    logger.info(`Email disabled (no SendGrid config). Skipping "${options.subject}" to ${to}`);
    return { success: true, provider: 'disabled', skipped: true };
  }

  const fromEmail = process.env.SENDGRID_FROM_EMAIL!.trim();
  const fromName = (process.env.FROM_NAME || 'Genesis by Preethy').trim();

  const payload = {
    personalizations: [{ to: [{ email: options.email }] }],
    from: { email: fromEmail, name: fromName },
    subject: options.subject,
    ...(options.headers ? { headers: options.headers } : {}),
    content: [
      options.html
        ? { type: 'text/html', value: options.html }
        : { type: 'text/plain', value: options.message || '' },
    ],
  };

  try {
    const res = await fetch(SENDGRID_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY!.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.error(`SendGrid send failed (${res.status}) for ${to}: ${detail}`);
      return { success: false, provider: 'sendgrid', status: res.status };
    }

    logger.info(`Email sent to ${to}: "${options.subject}"`);
    return { success: true, provider: 'sendgrid', messageId: res.headers.get('x-message-id') };
  } catch (err: any) {
    // Swallow the error so callers (order/payment flows) are never broken by email.
    logger.error(`SendGrid request error for ${to}: ${err?.message || err}`);
    return { success: false, provider: 'sendgrid', error: err?.message };
  }
};
