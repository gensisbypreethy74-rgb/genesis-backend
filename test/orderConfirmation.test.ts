// Order confirmation emails through Resend: sent once per paid order, retried
// on failure, never for unpaid/cancelled orders, delivery tracked by webhook.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startStack, stopStack, resetDb, api, makeUser, makeProduct, hmac, stubFetch, json } from './helpers';

const { razorpay } = require('../src/utils/razorpay');
const Order = require('../src/models/Order').default;
const { processDueConfirmations, sendOrderConfirmation } = require('../src/utils/orderConfirmation');

type Ctx = Awaited<ReturnType<typeof makeUser>>;
type Sent = { body: any; idempotencyKey: string | null; auth: string | null };

const WEBHOOK_SECRET = `whsec_${crypto.randomBytes(24).toString('base64')}`;
let seq = 0;
let sent: Sent[] = [];
/** What the fake Resend answers next; defaults to success. */
let resendReply: () => Response = () => json({ id: `re_${sent.length}` });

const configureEmail = () => {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'orders@genesis.test';
  process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
};

const checkout = (ctx: Ctx, items: unknown[], paymentMethod = 'razorpay') =>
  api('POST', '/payments/create-order', { token: ctx.token, body: { items, addressId: ctx.addressId, paymentMethod } });

const pay = (ctx: Ctx, rzpOrderId: string, paymentId = 'pay_T1', secret = 'test_key_secret') =>
  api('POST', '/payments/verify', {
    token: ctx.token,
    body: { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: hmac(`${rzpOrderId}|${paymentId}`, secret) },
  });

/** Checkout + successful payment; returns the order id and Razorpay order id. */
async function paidOrder(ctx: Ctx, productId: string, paymentMethod = 'razorpay') {
  const res = await checkout(ctx, [{ product: productId, size: 'M', quantity: 1 }], paymentMethod);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const rzp = res.data.data.razorpayOrder.id;
  const paid = await pay(ctx, rzp);
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  return { orderId: String(res.data.data.orderId), rzp, response: paid };
}

const confirmationOf = async (orderId: string) =>
  (await Order.findById(orderId).select('+confirmationEmail').lean())?.confirmationEmail;

/** Waits for the background send that follows payment to finish its attempt. */
async function attempted(orderId: string) {
  for (let i = 0; i < 200; i++) {
    const ce = await confirmationOf(orderId);
    if (ce && ce.attempts > 0 && !ce.lockedUntil) return ce;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`confirmation for ${orderId} was never attempted`);
}

/** Makes a waiting confirmation due now, as if its backoff had elapsed. */
const makeDue = (orderId: string) =>
  Order.updateOne({ _id: orderId }, { $set: { 'confirmationEmail.nextAttemptAt': new Date(Date.now() - 1000) } });

const signedResendWebhook = (event: unknown, secret = WEBHOOK_SECRET) => {
  const raw = JSON.stringify(event);
  const id = `msg_${crypto.randomUUID()}`;
  const ts = Math.floor(Date.now() / 1000).toString();
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  return api('POST', '/emails/webhook', {
    raw,
    headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` },
  });
};

describe('order confirmation emails', () => {
  before(startStack);
  after(stopStack);
  beforeEach(async () => {
    await resetDb();
    configureEmail();
    sent = [];
    resendReply = () => json({ id: `re_${sent.length}` });
    razorpay.orders.create = async (o: any) => ({ id: `order_E${++seq}`, amount: o.amount, currency: o.currency, status: 'created' });
    stubFetch('https://api.resend.com/emails', (_url, init) => {
      const headers = new Headers(init?.headers);
      sent.push({ body: JSON.parse(String(init?.body)), idempotencyKey: headers.get('idempotency-key'), auth: headers.get('authorization') });
      return resendReply();
    });
  });

  it('E1: a paid order sends one branded confirmation to the customer, recorded on the order', async () => {
    const ctx = await makeUser();
    const p = await makeProduct({ name: 'Chethi & Kaitha <i>' });
    const admin = await makeUser({ role: 'admin' });
    const { orderId, response } = await paidOrder(ctx, p.id);

    const ce = await attempted(orderId);
    assert.equal(ce.status, 'sent');
    assert.equal(ce.resendId, 're_1');
    assert.equal(ce.to, ctx.user.email);
    assert.equal(ce.attempts, 1);
    assert.ok(ce.sentAt);

    assert.equal(sent.length, 1);
    const [email] = sent;
    assert.equal(email.idempotencyKey, `order-confirmation/${orderId}`);
    assert.equal(email.auth, 'Bearer re_test_key');
    assert.deepEqual([email.body.to].flat(), [ctx.user.email]);
    assert.equal(email.body.from, 'Genesis by Preethy <orders@genesis.test>');
    assert.match(String(email.body.reply_to), /care@genesisbypreethy\.com/);
    assert.match(email.body.subject, new RegExp(`#${orderId.slice(-8).toUpperCase()} is confirmed`));
    const html: string = email.body.html;
    for (const part of [
      'Your Order Has Been Confirmed!', 'Dear Asha Menon,', orderId, 'Chethi &amp; Kaitha &lt;i&gt;', 'Size M', '₹24,000',
      'Complimentary', 'Paid online · Razorpay', 'Paid in full', '12 Marine Drive', 'Kochi, Kerala 682001',
      'dispatched within one to two working days', 'care@genesisbypreethy.com',
      `https://genesisbypreethy.com/profile?tab=orders&amp;order=${orderId}`,
      // The logo comes from the live site even when FRONTEND_URL is local or a test host.
      'https://genesisbypreethy.com/images/logo-wordmark.png', 'f_jpg,q_auto,w_128,h_160,c_fill',
    ]) assert.ok(html.includes(part), `email shows ${part}`);
    assert.ok(!html.includes('<i>'), 'catalogue text is escaped');
    assert.match(email.body.text, /Your Order Has Been Confirmed!/);
    assert.match(email.body.text, new RegExp(`Order ID: ${orderId}`));

    // Shoppers never see the email bookkeeping; the studio does.
    assert.equal(response.data.data.confirmationEmail, undefined);
    const mine = await api('GET', '/payments/myorders', { token: ctx.token });
    assert.equal(mine.data.data[0].confirmationEmail, undefined);
    const studio = await api('GET', '/payments/admin/orders', { token: admin.token });
    assert.equal(studio.data.data[0].confirmationEmail.status, 'sent');
  });

  it('E2: unpaid, rejected and abandoned checkouts send nothing', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    const abandoned = await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }]);
    const rejected = await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }]);
    assert.equal((await pay(ctx, rejected.data.data.razorpayOrder.id, 'pay_X', 'wrong_secret')).status, 400);

    assert.equal(await processDueConfirmations(), 0);
    assert.equal(sent.length, 0);
    for (const res of [abandoned, rejected]) {
      assert.equal(await confirmationOf(res.data.data.orderId), undefined, 'nothing queued for an unpaid order');
    }
  });

  it('E3: repeated verify calls, the Razorpay webhook and the worker still send exactly one email', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    const { orderId, rzp } = await paidOrder(ctx, p.id);
    await attempted(orderId);

    assert.equal((await pay(ctx, rzp)).status, 200, 'replayed verify');
    assert.equal((await pay(ctx, rzp)).status, 200, 'another replay');
    const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_T1', order_id: rzp, amount: 2400000, currency: 'INR' } } } });
    const hook = await api('POST', '/payments/webhook', { raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmac(raw, 'test_webhook_secret') } });
    assert.equal(hook.status, 200);
    await makeDue(orderId);
    await processDueConfirmations();
    await sendOrderConfirmation(orderId);

    assert.equal(sent.length, 1);
    assert.equal((await confirmationOf(orderId)).status, 'sent');

    // The real race: the browser's verify and Razorpay's webhook land together.
    const res = await checkout(ctx, [{ product: p.id, size: 'L', quantity: 1 }]);
    const rzp2 = res.data.data.razorpayOrder.id;
    const raw2 = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_T2', order_id: rzp2, amount: 2500000, currency: 'INR' } } } });
    const settle = () => api('POST', '/payments/webhook', { raw: raw2, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmac(raw2, 'test_webhook_secret') } });
    await Promise.all([pay(ctx, rzp2, 'pay_T2'), settle(), pay(ctx, rzp2, 'pay_T2'), settle()]);
    await attempted(String(res.data.data.orderId));
    await new Promise((r) => setTimeout(r, 200)); // let any stray second send finish
    assert.equal(sent.length, 2, 'one email for each of the two orders');
  });

  it('E4: simultaneous orders each get their own email; concurrent sends of one order send once', async () => {
    const p = await makeProduct({ variants: [{ volume: 'M', price: 24000, images: [] }] });
    const customers = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const orders = await Promise.all(customers.map((c, i) => paidOrder(c, p.id, i === 2 ? 'cod' : 'razorpay')));
    await Promise.all(orders.map((o) => attempted(o.orderId)));

    assert.equal(sent.length, 3);
    for (const [i, c] of customers.entries()) {
      const mail = sent.find((s) => [s.body.to].flat()[0] === c.user.email);
      assert.ok(mail, `customer ${i} got an email`);
      assert.equal(mail!.idempotencyKey, `order-confirmation/${orders[i].orderId}`);
      assert.ok(mail!.body.html.includes(orders[i].orderId), 'with their own order in it');
      for (const other of orders.filter((_, j) => j !== i)) assert.ok(!mail!.body.html.includes(other.orderId));
    }
    const cod = sent.find((s) => [s.body.to].flat()[0] === customers[2].user.email)!.body.html;
    assert.ok(cod.includes('Cash on Delivery') && cod.includes('Due on delivery') && cod.includes('Advance of ₹2,400 paid'));

    // A confirmation put back in the queue, raced by five senders: one email.
    const { orderId } = orders[0];
    await Order.updateOne({ _id: orderId }, { $set: { 'confirmationEmail.status': 'pending' }, $unset: { 'confirmationEmail.lockedUntil': 1 } });
    sent = [];
    await Promise.all(Array.from({ length: 5 }, () => sendOrderConfirmation(orderId)));
    assert.equal(sent.length, 1);
  });

  it('E5: an invalid customer email fails the confirmation without calling Resend; the order stays paid', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    await require('../src/models/User').User.collection.updateOne({ _id: ctx.user._id }, { $set: { email: 'not-an-email' } });
    const { orderId } = await paidOrder(ctx, p.id);

    const ce = await attempted(orderId);
    assert.equal(ce.status, 'failed');
    assert.match(ce.lastError, /invalid_recipient/);
    assert.equal(sent.length, 0);
    const order = await Order.findById(orderId);
    assert.equal(order.orderStatus, 'processing');
    assert.equal(order.paymentStatus, 'completed');
    assert.equal(await processDueConfirmations(), 0, 'not retried');
  });

  it('E6: a Resend outage keeps the order and retries the email later with the same idempotency key', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    resendReply = () => json({ statusCode: 500, name: 'application_error', message: 'Resend is down' }, 500);
    const { orderId } = await paidOrder(ctx, p.id);

    let ce = await attempted(orderId);
    assert.equal(ce.status, 'pending');
    assert.equal(ce.attempts, 1);
    assert.match(ce.lastError, /application_error/);
    assert.ok(new Date(ce.nextAttemptAt).getTime() > Date.now(), 'backs off before retrying');
    assert.equal((await Order.findById(orderId)).orderStatus, 'processing', 'order untouched');

    assert.equal(await processDueConfirmations(), 0, 'not due yet');
    resendReply = () => json({ id: 're_retry' });
    await makeDue(orderId);
    assert.equal(await processDueConfirmations(), 1);

    ce = await confirmationOf(orderId);
    assert.equal(ce.status, 'sent');
    assert.equal(ce.resendId, 're_retry');
    assert.equal(ce.attempts, 2);
    assert.equal(ce.lastError, undefined);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].idempotencyKey, sent[1].idempotencyKey);
  });

  it('E7: nothing is lost across a restart, including a send that died mid-flight', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    delete process.env.RESEND_API_KEY; // email not configured when the order is paid
    const { orderId } = await paidOrder(ctx, p.id);
    let ce = await attempted(orderId);
    assert.equal(ce.status, 'pending');
    assert.match(ce.lastError, /not_configured/);
    assert.equal(sent.length, 0);

    // A server died holding the claim: nobody else sends until its lease lapses.
    configureEmail();
    await Order.updateOne({ _id: orderId }, { $set: { 'confirmationEmail.nextAttemptAt': new Date(0), 'confirmationEmail.lockedUntil': new Date(Date.now() + 60_000) } });
    assert.equal(await processDueConfirmations(), 0);
    await Order.updateOne({ _id: orderId }, { $set: { 'confirmationEmail.lockedUntil': new Date(Date.now() - 1000) } });
    assert.equal(await processDueConfirmations(), 1, 'what the worker runs at boot');

    ce = await confirmationOf(orderId);
    assert.equal(ce.status, 'sent');
    assert.equal(sent.length, 1);
  });

  it('E8: a request Resend refuses outright fails at once; retryable errors give up after 10 attempts', async () => {
    const p = await makeProduct();
    const a = await makeUser();
    resendReply = () => json({ statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' }, 422);
    const first = await paidOrder(a, p.id);
    let ce = await attempted(first.orderId);
    assert.equal(ce.status, 'failed');
    assert.equal(ce.attempts, 1);

    // A domain not yet verified (403) is a setup problem: worth retrying.
    const b = await makeUser();
    resendReply = () => json({ statusCode: 403, name: 'validation_error', message: 'The domain is not verified.' }, 403);
    const second = await paidOrder(b, p.id);
    ce = await attempted(second.orderId);
    assert.equal(ce.status, 'pending');

    resendReply = () => json({ statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' }, 429);
    await Order.updateOne({ _id: second.orderId }, { $set: { 'confirmationEmail.attempts': 9 } });
    await makeDue(second.orderId);
    await processDueConfirmations();
    ce = await confirmationOf(second.orderId);
    assert.equal(ce.status, 'failed');
    assert.equal(ce.attempts, 10);
    assert.match(ce.lastError, /rate_limit_exceeded/);
  });

  it('E9: an order cancelled before its email went out is never "confirmed" afterwards', async () => {
    const ctx = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const p = await makeProduct();
    delete process.env.RESEND_API_KEY;
    const { orderId } = await paidOrder(ctx, p.id);
    await attempted(orderId);
    const cancel = await api('PUT', `/payments/admin/orders/${orderId}/status`, { token: admin.token, body: { orderStatus: 'cancelled' } });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.data));

    configureEmail();
    await makeDue(orderId);
    await processDueConfirmations();
    const ce = await confirmationOf(orderId);
    assert.equal(ce.status, 'failed');
    assert.match(ce.lastError, /order_cancelled/);
    assert.equal(sent.length, 0);
  });

  it('E11: every link in the email opens the live site over https, never localhost', async () => {
    const { renderOrderConfirmationEmail, renderOrderEmail } = require('../src/utils/orderEmail');
    const { ENV } = require('../src/config/env');
    const ctx = await makeUser();
    const p = await makeProduct();
    const { orderId } = await paidOrder(ctx, p.id);
    const order = await Order.findById(orderId);
    const unescape = (s: string) => s.replace(/&amp;/g, '&');
    const links = (html: string) => [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => unescape(m[1]));
    const saved = ENV.FRONTEND_URL;
    try {
      for (const configured of ['http://localhost:3000', 'http://shop.test', 'https://localhost:3000']) {
        ENV.FRONTEND_URL = configured;
        const email = renderOrderConfirmationEmail(order, { customerName: 'Asha', whatsappNumber: '917736830303' });
        const all = links(email.html);
        assert.ok(all.length >= 8, `found ${all.length} links`);
        for (const url of all) {
          assert.ok(
            url.startsWith('https://genesisbypreethy.com/') || url === 'https://genesisbypreethy.com' ||
              url.startsWith('https://wa.me/') || url.startsWith('https://res.cloudinary.com/') ||
              url.startsWith('mailto:care@genesisbypreethy.com'),
            `${configured}: unexpected link ${url}`
          );
          assert.ok(!/localhost|127\.0\.0\.1|shop\.test|^http:/.test(url), `${configured}: ${url}`);
        }
        assert.ok(all.includes(`https://genesisbypreethy.com/profile?tab=orders&order=${orderId}`), 'View your order → that order');
        assert.ok(all.includes(`https://genesisbypreethy.com/track-order?orderId=${orderId}`), 'Track → prefilled');
        assert.ok(all.includes('https://genesisbypreethy.com/products'), 'Continue shopping → the shop');
        assert.ok(all.includes(`mailto:care@genesisbypreethy.com?subject=Order%20%23${orderId.slice(-8).toUpperCase()}`), 'support → care, with the order');
        assert.ok(all.includes('https://wa.me/917736830303'));
        assert.ok(!/localhost|http:\/\//.test(email.text), 'plain-text version too');
        assert.ok(email.text.includes(`https://genesisbypreethy.com/profile?tab=orders&order=${orderId}`));
      }
      // A real https storefront (e.g. the live site under another name) is used as configured.
      ENV.FRONTEND_URL = 'https://www.genesisbypreethy.com';
      const www = links(renderOrderConfirmationEmail(order, {}).html);
      assert.ok(www.includes(`https://www.genesisbypreethy.com/profile?tab=orders&order=${orderId}`));
      // Status-update emails use the same rule.
      ENV.FRONTEND_URL = 'http://localhost:3000';
      const update = links(renderOrderEmail({ order, customerName: 'Asha', heading: 'h', message: 'm', ctaLabel: 'View' }));
      assert.deepEqual(update, [`https://genesisbypreethy.com/profile?tab=orders&order=${orderId}`]);
    } finally {
      ENV.FRONTEND_URL = saved;
    }
  });

  it('E10: Resend delivery webhooks update delivery only; unsigned or unconfigured calls are refused', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    const { orderId } = await paidOrder(ctx, p.id);
    const { resendId } = await attempted(orderId);
    const event = (type: string, emailId = resendId) => ({ type, created_at: new Date().toISOString(), data: { email_id: emailId } });

    assert.equal((await signedResendWebhook(event('email.delivered'))).status, 200);
    let ce = await confirmationOf(orderId);
    assert.equal(ce.delivery.status, 'delivered');
    assert.equal(ce.status, 'sent', 'send status is separate');

    await signedResendWebhook(event('email.delivery_delayed'));
    assert.equal((await confirmationOf(orderId)).delivery.status, 'delivered', 'a late "delayed" does not overwrite');
    await signedResendWebhook(event('email.complained'));
    assert.equal((await confirmationOf(orderId)).delivery.status, 'complained');

    assert.equal((await signedResendWebhook(event('email.bounced', 're_unknown'))).status, 200, 'other emails are ignored');
    assert.equal((await signedResendWebhook(event('email.bounced'), `whsec_${crypto.randomBytes(24).toString('base64')}`)).status, 400);
    const unsigned = await api('POST', '/emails/webhook', { raw: JSON.stringify(event('email.bounced')), headers: { 'Content-Type': 'application/json' } });
    assert.equal(unsigned.status, 400);
    ce = await confirmationOf(orderId);
    assert.equal(ce.delivery.status, 'complained', 'forged events changed nothing');

    delete process.env.RESEND_WEBHOOK_SECRET;
    assert.equal((await signedResendWebhook(event('email.bounced'))).status, 503);
  });
});
