import Razorpay from 'razorpay';
import crypto from 'crypto';
import { ENV } from '../config/env';

// One shared client. The SDK refuses to construct without a key, so an
// unconfigured dev setup gets a placeholder that is never called (checkout
// uses simulated payments there; see mockPaymentsAllowed).
export const razorpay = new Razorpay({
  key_id: ENV.RAZORPAY_KEY_ID || 'not_configured',
  key_secret: ENV.RAZORPAY_KEY_SECRET || 'not_configured',
});

const hmacMatches = (payload: string | Buffer, secret: string, signature: unknown) => {
  if (!secret || typeof signature !== 'string') return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(payload).digest('hex'));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
};

/** Checkout callback signature: HMAC-SHA256 of "order_id|payment_id" with the key secret. */
export const verifyPaymentSignature = (orderId: string, paymentId: string, signature: unknown) =>
  hmacMatches(`${orderId}|${paymentId}`, ENV.RAZORPAY_KEY_SECRET, signature);

/** Webhook signature: HMAC-SHA256 of the raw request body with the webhook secret. */
export const verifyWebhookSignature = (rawBody: Buffer, signature: unknown) =>
  hmacMatches(rawBody, ENV.RAZORPAY_WEBHOOK_SECRET, signature);
