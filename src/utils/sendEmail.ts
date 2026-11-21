import { Resend } from 'resend';
import logger, { maskEmail } from './logger';

// Email configuration interface
interface EmailOptions {
  email: string;
  subject: string;
  /** Plain-text body: the whole email, or the text part alongside `html`. */
  message?: string;
  html?: string;
  headers?: Record<string, string>;
  replyTo?: string;
  /** Resend sends at most once per key (for 24 hours), however often we retry. */
  idempotencyKey?: string;
  tags?: { name: string; value: string }[];
}

export type SendResult =
  | { success: true; id: string }
  | {
      success: false;
      /** Worth trying again later (outage, rate limit, setup not finished). */
      retryable: boolean;
      code: string;
      error: string;
    };

export const isValidEmail = (email?: string | null): email is string =>
  !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

/**
 * Whether outbound email is configured: a Resend API key and a sender address
 * on a domain verified in Resend. Read on every send, never cached.
 */
export const isEmailConfigured = (): boolean =>
  Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim());

/** Server-side only: the key never leaves this process. */
export const resendClient = () => new Resend(process.env.RESEND_API_KEY!.trim());

/** "orders@x.com" → "Genesis by Preethy <orders@x.com>"; a value that already names the sender is kept. */
const sender = () => {
  const from = process.env.EMAIL_FROM!.trim();
  return from.includes('<') ? from : `${(process.env.FROM_NAME || 'Genesis by Preethy').trim()} <${from}>`;
};

// Resend refused the request itself, so sending it again can't succeed. A 403
// validation_error is different: it means the account or sending domain isn't
// set up yet, which a retry after the fix does cure.
const PERMANENT = new Set([
  'validation_error',
  'missing_required_field',
  'invalid_parameter',
  'invalid_attachment',
  'invalid_idempotency_key',
  'invalid_idempotent_request',
]);

/**
 * Send a transactional email through Resend.
 *
 * Never throws: order flows must not break because an email couldn't be sent.
 * Every outcome is logged (recipient masked) and returned. Provider error text
 * is for logs and the studio, never for API responses to shoppers.
 */
export const sendEmail = async (options: EmailOptions): Promise<SendResult> => {
  const to = maskEmail(options.email);
  if (!isValidEmail(options.email)) {
    logger.warn(`Email "${options.subject}" not sent: invalid recipient address ${to}`);
    return { success: false, retryable: false, code: 'invalid_recipient', error: 'Invalid recipient email address' };
  }
  if (!isEmailConfigured()) {
    logger.info(`Email disabled (RESEND_API_KEY / EMAIL_FROM not set). Skipping "${options.subject}" to ${to}`);
    return { success: false, retryable: true, code: 'not_configured', error: 'Email is not configured (RESEND_API_KEY / EMAIL_FROM)' };
  }

  // An HTML email carries its plain-text version alongside when given one.
  const content = options.html
    ? { html: options.html, ...(options.message ? { text: options.message } : {}) }
    : { text: options.message || '' };

  try {
    const { data, error } = await resendClient().emails.send(
      {
        from: sender(),
        to: options.email.trim(),
        subject: options.subject,
        ...content,
        ...(options.replyTo ? { replyTo: options.replyTo } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.tags ? { tags: options.tags } : {}),
      },
      options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined
    );

    if (error) {
      const retryable = !(PERMANENT.has(error.name) && error.statusCode !== 403);
      logger.error(`Resend rejected "${options.subject}" to ${to}: ${error.name} (${error.statusCode ?? 'no status'}) ${error.message}`);
      return { success: false, retryable, code: error.name, error: error.message };
    }

    logger.info(`Email sent to ${to}: "${options.subject}" (Resend id ${data.id})`);
    return { success: true, id: data.id };
  } catch (err: any) {
    logger.error(`Resend request error for ${to}: ${err?.message || err}`);
    return { success: false, retryable: true, code: 'request_error', error: String(err?.message || err) };
  }
};
