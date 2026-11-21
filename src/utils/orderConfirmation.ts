import Order, { IOrder } from '../models/Order';
import { User } from '../models/User';
import { getOrCreateSiteSettings } from '../models/SiteSettings';
import { sendEmail, SendResult } from './sendEmail';
import { renderOrderConfirmationEmail, SUPPORT_EMAIL } from './orderEmail';
import logger, { maskEmail } from './logger';

/**
 * Order confirmation emails, as a small outbox kept on the order itself.
 *
 * markOrderPaid queues one ("pending") in the same write that marks the order
 * paid, so a crash or restart right after payment can't lose it. The request
 * that settled the order sends it straight away; anything that fails — Resend
 * down or rate limited, email not configured yet, the server restarted
 * mid-send — is retried with backoff by the worker started in server.ts.
 *
 * At most one email per order:
 *  - only the call that wins the paid transition queues one (markOrderPaid is
 *    atomic), so repeated verify calls and Razorpay webhooks queue nothing;
 *  - each attempt first claims the order with a short lease, so two workers,
 *    or a retry racing the first send, never send at the same time;
 *  - every attempt carries the same Resend idempotency key, so even a send
 *    whose response was lost (timeout, crash) is not delivered twice.
 */

const MAX_ATTEMPTS = 10;
/** Minutes to wait after failed attempt n (1, 2, …): about 26 hours in all. */
const BACKOFF_MINUTES = [1, 5, 15, 30, 60, 120, 240, 360, 360];
/** How long one attempt may hold its claim before another worker may retry it. */
const LEASE_MS = 2 * 60_000;
/** The worker leaves a fresh order alone this long: the request that paid it sends first. */
const FIRST_SEND_GRACE_MS = 60_000;
const WORKER_INTERVAL_MS = 60_000;

/** The confirmation markOrderPaid stores with a newly paid order. */
export const queuedConfirmation = () => ({
  status: 'pending' as const,
  attempts: 0,
  nextAttemptAt: new Date(Date.now() + FIRST_SEND_GRACE_MS),
});

/** Atomically takes the next attempt at one pending, unclaimed confirmation, or returns null. */
const claim = (filter: Record<string, unknown>) => {
  const now = new Date();
  return Order.findOneAndUpdate(
    {
      ...filter,
      'confirmationEmail.status': 'pending',
      $or: [{ 'confirmationEmail.lockedUntil': null }, { 'confirmationEmail.lockedUntil': { $lte: now } }],
    },
    {
      $set: { 'confirmationEmail.lockedUntil': new Date(now.getTime() + LEASE_MS) },
      $inc: { 'confirmationEmail.attempts': 1 },
    },
    { new: true, sort: { 'confirmationEmail.nextAttemptAt': 1 } }
  ).select('+confirmationEmail');
};

/** Sends one claimed confirmation and records the outcome on the order. */
async function deliver(order: IOrder) {
  const id = order._id.toString();
  const attempts = order.confirmationEmail!.attempts;
  let to: string | undefined;
  let result: SendResult;

  if (order.orderStatus === 'cancelled') {
    // Cancelled while the email was still waiting: "confirmed" would be wrong now.
    result = { success: false, retryable: false, code: 'order_cancelled', error: 'The order was cancelled before the confirmation was sent.' };
  } else {
    const [user, settings] = await Promise.all([User.findById(order.user).select('name email'), getOrCreateSiteSettings()]);
    to = user?.email?.trim();
    const email = renderOrderConfirmationEmail(order, { customerName: user?.name, whatsappNumber: settings.whatsappNumber });
    result = await sendEmail({
      email: to || '',
      subject: email.subject,
      html: email.html,
      message: email.text,
      replyTo: SUPPORT_EMAIL,
      idempotencyKey: `order-confirmation/${id}`,
      tags: [
        { name: 'type', value: 'order_confirmation' },
        { name: 'order_id', value: id },
      ],
    });
  }

  const recipient = to ? { 'confirmationEmail.to': to } : {};
  if (result.success) {
    await Order.updateOne(
      { _id: order._id },
      {
        $set: { 'confirmationEmail.status': 'sent', 'confirmationEmail.resendId': result.id, 'confirmationEmail.sentAt': new Date(), ...recipient },
        $unset: { 'confirmationEmail.lockedUntil': 1, 'confirmationEmail.nextAttemptAt': 1, 'confirmationEmail.lastError': 1 },
      }
    );
    logger.info(`Order confirmation for ${id} sent to ${maskEmail(to)} on attempt ${attempts}`);
    return;
  }

  const lastError = `${result.code}: ${result.error}`.slice(0, 500);
  if (!result.retryable || attempts >= MAX_ATTEMPTS) {
    await Order.updateOne(
      { _id: order._id },
      {
        $set: { 'confirmationEmail.status': 'failed', 'confirmationEmail.lastError': lastError, ...recipient },
        $unset: { 'confirmationEmail.lockedUntil': 1, 'confirmationEmail.nextAttemptAt': 1 },
      }
    );
    logger.error(`Order confirmation for ${id} failed for good after attempt ${attempts}: ${lastError}`);
    return;
  }

  const waitMinutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];
  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        'confirmationEmail.lastError': lastError,
        'confirmationEmail.nextAttemptAt': new Date(Date.now() + waitMinutes * 60_000),
        ...recipient,
      },
      $unset: { 'confirmationEmail.lockedUntil': 1 },
    }
  );
  logger.warn(`Order confirmation for ${id} not sent (attempt ${attempts}), retrying in ${waitMinutes} min: ${lastError}`);
}

/** Sends this order's confirmation now if it is still pending. Never throws. */
export async function sendOrderConfirmation(orderId: unknown) {
  try {
    const order = await claim({ _id: orderId });
    if (order) await deliver(order);
  } catch (err: any) {
    // Still pending in the database; the worker picks it up once the claim lapses.
    logger.error(`Order confirmation for ${orderId} errored: ${err?.message || err}`);
  }
}

/** One pass of the retry worker: sends every confirmation that is due. Returns how many it attempted. */
export async function processDueConfirmations(max = 25) {
  let attempted = 0;
  try {
    while (attempted < max) {
      const order = await claim({ 'confirmationEmail.nextAttemptAt': { $lte: new Date() } });
      if (!order) break;
      attempted++;
      await deliver(order);
    }
  } catch (err: any) {
    logger.error(`Order confirmation worker errored: ${err?.message || err}`);
  }
  return attempted;
}

/** Retries due confirmations every minute, starting with any left over from before a restart. */
export function startConfirmationWorker() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processDueConfirmations();
    } finally {
      running = false;
    }
  };
  void tick();
  return setInterval(tick, WORKER_INTERVAL_MS);
}
