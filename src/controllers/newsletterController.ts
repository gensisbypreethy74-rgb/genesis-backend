import crypto from 'crypto';
import { Request, Response } from 'express';
import { Newsletter } from '../models/Newsletter';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';
import { subscribeToZohoList, unsubscribeFromZohoList } from '../utils/zohoCampaigns';
import { sendEmail } from '../utils/sendEmail';
import { escapeHtml } from '../utils/orderEmail';
import logger, { maskEmail } from '../utils/logger';
import { ENV } from '../config/env';

// Unsubscribe links carry an HMAC of the address, so nobody can unsubscribe
// someone else by guessing a URL. (Rotating JWT_SECRET invalidates old links.)
const unsubscribeToken = (email: string) =>
  crypto.createHmac('sha256', ENV.JWT_SECRET).update(`newsletter-unsubscribe:${email}`).digest('hex');

const tokenMatches = (email: string, token: unknown) => {
  const expected = Buffer.from(unsubscribeToken(email));
  const given = Buffer.from(String(token || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
};

// The API serves its own unsubscribe page. Render routes by Host, so the
// request's host is this service's public address.
const unsubscribeUrl = (req: Request, email: string) =>
  `${req.protocol}://${req.get('host')}/api/v1/newsletter/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubscribeToken(email)}`;

/**
 * Branded confirmation email sent directly by our backend on every valid
 * subscription. This is independent of Zoho's double opt-in email (whose
 * deliverability depends on a verified sender domain in the Zoho dashboard) —
 * so the subscriber gets a confirmation the moment an email provider
 * (SENDGRID_API_KEY + SENDGRID_FROM_EMAIL) is configured, regardless of Zoho.
 */
const buildConfirmationEmail = (email: string, unsubscribe: string) => ({
  email,
  subject: 'You’re on the list — Notes from the Studio',
  headers: { 'List-Unsubscribe': `<${unsubscribe}>` },
  html: `<!doctype html>
<html><body style="margin:0;background:#f5f0e8;font-family:Georgia,'Times New Roman',serif;color:#1c1a15;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#faf6ef;border:1px solid #ddd3c2;">
        <tr><td style="padding:44px 44px 8px;text-align:center;">
          <div style="font-family:Georgia,serif;letter-spacing:8px;text-transform:uppercase;font-size:20px;color:#1c1a15;">GENESIS</div>
          <div style="font-family:Arial,sans-serif;letter-spacing:5px;text-transform:uppercase;font-size:9px;color:#6f675a;margin-top:6px;">by Preethy</div>
        </td></tr>
        <tr><td style="padding:24px 44px 8px;text-align:center;">
          <p style="font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:3px;font-size:11px;color:#83653a;margin:0 0 14px;">Notes from the Studio</p>
          <h1 style="font-family:Georgia,serif;font-weight:normal;font-size:30px;line-height:1.2;color:#1c1a15;margin:0 0 18px;">You’re on the list.</h1>
          <p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.75;color:#6f675a;margin:0;">
            Thank you for subscribing. You’ll receive slow letters about clothing, climate,
            and getting dressed for the life you’re actually living — nothing more, nothing rushed.
          </p>
        </td></tr>
        <tr><td style="padding:28px 44px 44px;text-align:center;">
          <a href="${ENV.FRONTEND_URL}"
             style="display:inline-block;background:#1c1a15;color:#f5f0e8;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:2px;font-size:11px;text-decoration:none;padding:14px 28px;">
            Explore the Collection
          </a>
        </td></tr>
        <tr><td style="padding:20px 44px 40px;text-align:center;border-top:1px solid #ddd3c2;">
          <p style="font-family:Arial,sans-serif;font-size:11px;color:#9a9284;margin:0;">
            Genesis by Preethy · Registered in Kochi, Kerala<br/>
            You received this because ${escapeHtml(email)} subscribed at genesisbypreethy.<br/>
            <a href="${escapeHtml(unsubscribe)}" style="color:#9a9284;">Unsubscribe</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
});

/** Send the branded confirmation email — never throws. A no-op until SendGrid is configured. */
const sendConfirmation = async (req: Request, email: string) => {
  try {
    await sendEmail(buildConfirmationEmail(email, unsubscribeUrl(req, email)));
  } catch (err: any) {
    logger.warn(`Newsletter confirmation email failed for ${maskEmail(email)}: ${err?.message || err}`);
  }
};

// POST /newsletter/subscribe  (public)
export const subscribe = asyncHandler(async (req: Request, res: Response) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const source = req.body.source ? String(req.body.source).trim() : undefined;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return errorResponse(res, 400, 'Please provide a valid email address.');
  }

  const existing = await Newsletter.findOne({ email });
  if (existing) {
    const wasReactivated = !existing.isActive;
    if (wasReactivated) {
      existing.isActive = true;
      await existing.save();
    }
    // Push to Zoho too — covers contacts added before Zoho was wired up, or a
    // resubscribe after a previous unsubscribe. Best-effort; never blocks.
    await subscribeToZohoList(email, source);
    // Send our own confirmation only on a genuine re-subscribe, not on every
    // repeat submit of an already-active address (that would be spammy).
    if (wasReactivated) await sendConfirmation(req, email);
    return successResponse(res, 200, 'You are already on the list.', { email });
  }

  await Newsletter.create({ email, source });
  logger.info(`Newsletter: new subscriber ${maskEmail(email)}`);

  // Mirror the subscriber into Zoho Campaigns. This is best-effort: the local
  // record is the source of truth, so a Zoho outage or misconfiguration must
  // not fail the subscription. Failures are logged inside the helper.
  await subscribeToZohoList(email, source);

  // Our own branded confirmation email (best-effort, independent of Zoho).
  await sendConfirmation(req, email);

  return successResponse(res, 201, 'Subscribed successfully.', { email });
});

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Genesis by Preethy</title></head>
<body style="margin:0;background:#f5f0e8;font-family:Georgia,'Times New Roman',serif;color:#1c1a15;">
  <main style="max-width:480px;margin:80px auto;padding:40px 32px;background:#faf6ef;border:1px solid #ddd3c2;text-align:center;">
    <div style="letter-spacing:8px;text-transform:uppercase;font-size:18px;">GENESIS</div>
    <h1 style="font-weight:normal;font-size:26px;margin:28px 0 16px;">${title}</h1>
    ${body}
  </main>
</body></html>`;

const invalidLink = page('This link is not valid', '<p style="font-family:Arial,sans-serif;color:#6f675a;">Please use the unsubscribe link from your most recent email.</p>');

// GET /newsletter/unsubscribe?email=&token=  (public) — confirm step only.
export const unsubscribePage = (req: Request, res: Response) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email || !tokenMatches(email, req.query.token)) {
    return res.status(400).type('html').send(invalidLink);
  }
  res.type('html').send(page('Unsubscribe from Notes from the Studio?', `
    <p style="font-family:Arial,sans-serif;color:#6f675a;">${escapeHtml(email)} will stop receiving our letters.</p>
    <form method="post" action="/api/v1/newsletter/unsubscribe">
      <input type="hidden" name="email" value="${escapeHtml(email)}">
      <input type="hidden" name="token" value="${escapeHtml(String(req.query.token))}">
      <button type="submit" style="margin-top:20px;background:#1c1a15;color:#f5f0e8;border:0;padding:14px 28px;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:2px;font-size:11px;cursor:pointer;">Unsubscribe</button>
    </form>`));
};

// POST /newsletter/unsubscribe  (public, signed)
export const unsubscribe = asyncHandler(async (req: Request, res: Response) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !tokenMatches(email, req.body?.token)) {
    return res.status(400).type('html').send(invalidLink);
  }
  await Newsletter.updateOne({ email }, { $set: { isActive: false } });
  await unsubscribeFromZohoList(email);
  logger.info(`Newsletter: unsubscribed ${maskEmail(email)}`);
  res.type('html').send(page('You’re unsubscribed', '<p style="font-family:Arial,sans-serif;color:#6f675a;">You won’t receive Notes from the Studio any more.</p>'));
});

// GET /newsletter/admin  (admin)
export const getSubscribers = asyncHandler(async (_req: Request, res: Response) => {
  const subscribers = await Newsletter.find().sort({ createdAt: -1 });
  return successResponse(res, 200, 'Subscribers fetched successfully', subscribers);
});

// DELETE /newsletter/admin/:id  (admin) — also removes them from Zoho, so a
// "remove me" request is honoured where the campaigns are actually sent.
export const deleteSubscriber = asyncHandler(async (req: Request, res: Response) => {
  const sub = await Newsletter.findByIdAndDelete(req.params.id);
  if (!sub) {
    return errorResponse(res, 404, 'Subscriber not found');
  }
  await unsubscribeFromZohoList(sub.email);
  return successResponse(res, 200, 'Subscriber removed successfully', { id: req.params.id });
});
