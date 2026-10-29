// Regression tests for the payment / order findings: B2, B3, B5, B6, B12, B13, B21, B22, F2, F4.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, stopStack, resetDb, api, makeUser, makeProduct, hmac } from './helpers';

const { razorpay } = require('../src/utils/razorpay');
const { ENV } = require('../src/config/env');
const Order = require('../src/models/Order').default;
const { Product } = require('../src/models/Product');
const { Cart } = require('../src/models/Cart');

let created: any[] = [];
let seq = 0;

type Ctx = Awaited<ReturnType<typeof makeUser>>;

const checkout = (ctx: Ctx, items: unknown[], paymentMethod = 'razorpay', addressId = ctx.addressId) =>
  api('POST', '/payments/create-order', { token: ctx.token, body: { items, addressId, paymentMethod } });

const pay = (ctx: Ctx, orderId: string, paymentId = 'pay_T1', secret = 'test_key_secret') =>
  api('POST', '/payments/verify', {
    token: ctx.token,
    body: { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: hmac(`${orderId}|${paymentId}`, secret) },
  });

const webhook = (event: string, payment: Record<string, unknown>, secret = 'test_webhook_secret') => {
  const raw = JSON.stringify({ event, payload: { payment: { entity: payment } } });
  return api('POST', '/payments/webhook', {
    raw,
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': hmac(raw, secret) },
  });
};

const stockOf = async (productId: unknown, size: string) =>
  (await Product.findById(productId)).variants.find((v: any) => v.volume === size).stock;

describe('payments', () => {
  before(startStack);
  after(stopStack);
  beforeEach(async () => {
    await resetDb();
    created = [];
    razorpay.orders.create = async (o: any) => {
      created.push(o);
      return { id: `order_T${++seq}`, amount: o.amount, currency: o.currency, status: 'created' };
    };
  });

  it('B3: prices the bag on the server and ignores prices/totals sent by the browser', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    const res = await api('POST', '/payments/create-order', {
      token: ctx.token,
      body: { items: [{ product: p.id, size: 'M', quantity: 1, price: 1 }], addressId: ctx.addressId, paymentMethod: 'razorpay', total: 1, subtotal: 1 },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(created[0].amount, 2400000, 'Razorpay is asked for ₹24,000 in paise');
    assert.equal(res.data.data.amounts.total, 24000);
    const order = await Order.findById(res.data.data.orderId);
    assert.equal(order.total, 24000);
    assert.equal(order.items[0].price, 24000);
    assert.equal(order.orderStatus, 'awaiting_payment');
    // F1: Razorpay's form is prefilled with this customer, not a hard-coded stranger.
    assert.equal(res.data.data.prefill.email, ctx.user.email);
    assert.equal(res.data.data.prefill.name, 'Asha Menon');
  });

  it('B3: rejects the old client-priced payload', async () => {
    const ctx = await makeUser();
    const res = await api('POST', '/payments/create-order', { token: ctx.token, body: { total: 1 } });
    assert.equal(res.status, 400);
    assert.equal(created.length, 0);
  });

  it('B2: "mock_payment" no longer settles a real order', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    const { data } = await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }]);
    const res = await api('POST', '/payments/verify', {
      token: ctx.token,
      body: { razorpay_order_id: data.data.razorpayOrder.id, razorpay_payment_id: 'mock_payment', razorpay_signature: 'mock_signature' },
    });
    assert.equal(res.status, 400);
    assert.equal((await Order.findById(data.data.orderId)).orderStatus, 'awaiting_payment');
  });

  it('B2: simulated payments exist only without Razorpay keys, and never in production', async () => {
    const saved = { id: ENV.RAZORPAY_KEY_ID, secret: ENV.RAZORPAY_KEY_SECRET, env: ENV.NODE_ENV };
    try {
      ENV.RAZORPAY_KEY_ID = '';
      ENV.RAZORPAY_KEY_SECRET = '';
      const ctx = await makeUser();
      const p = await makeProduct();
      const first = await checkout(ctx, [{ product: p.id, size: 'L', quantity: 1 }]);
      assert.equal(first.data.data.isMock, true);
      assert.equal(created.length, 0, 'no Razorpay call in simulated mode');
      const ok = await api('POST', '/payments/verify', {
        token: ctx.token,
        body: { razorpay_order_id: first.data.data.razorpayOrder.id, razorpay_payment_id: 'mock_payment', razorpay_signature: 'mock' },
      });
      assert.equal(ok.status, 200);

      const second = await checkout(ctx, [{ product: p.id, size: 'L', quantity: 1 }]);
      ENV.NODE_ENV = 'production';
      const refused = await api('POST', '/payments/verify', {
        token: ctx.token,
        body: { razorpay_order_id: second.data.data.razorpayOrder.id, razorpay_payment_id: 'mock_payment', razorpay_signature: 'mock' },
      });
      assert.equal(refused.status, 400, 'a simulated order cannot be settled in production');
    } finally {
      ENV.RAZORPAY_KEY_ID = saved.id;
      ENV.RAZORPAY_KEY_SECRET = saved.secret;
      ENV.NODE_ENV = saved.env;
    }
  });

  it('settles a correctly signed payment: order placed, stock taken, cart emptied', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    await Cart.create({ user: ctx.user._id, items: [{ product: p._id, quantity: 1, size: 'M' }] });
    const { data } = await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }]);
    const res = await pay(ctx, data.data.razorpayOrder.id);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const order = await Order.findById(data.data.orderId);
    assert.equal(order.orderStatus, 'processing');
    assert.equal(order.paymentStatus, 'completed');
    assert.ok(order.paidAt);
    assert.equal(await stockOf(p._id, 'M'), 1);
    assert.equal((await Cart.findOne({ user: ctx.user._id })).items.length, 0);
  });

  it('rejects a bad signature', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    const { data } = await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }]);
    const res = await pay(ctx, data.data.razorpayOrder.id, 'pay_T1', 'wrong_secret');
    assert.equal(res.status, 400);
    assert.equal((await Order.findById(data.data.orderId)).orderStatus, 'awaiting_payment');
  });

  it('B5: replaying a verified payment returns the same order and creates nothing', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    const { data } = await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }]);
    const a = await pay(ctx, data.data.razorpayOrder.id);
    const b = await pay(ctx, data.data.razorpayOrder.id);
    const c = await pay(ctx, data.data.razorpayOrder.id);
    assert.equal(b.status, 200);
    assert.equal(c.data.data._id, a.data.data._id);
    assert.equal(await Order.countDocuments(), 1);
    assert.equal(await stockOf(p._id, 'M'), 1, 'stock taken once');
    const other = await pay(ctx, data.data.razorpayOrder.id, 'pay_OTHER');
    assert.equal(other.status, 409, 'a second payment id cannot be attached');
  });

  it("B5: one customer cannot settle another customer's order", async () => {
    const alice = await makeUser();
    const mallory = await makeUser();
    const p = await makeProduct();
    const { data } = await checkout(alice, [{ product: p.id, size: 'M', quantity: 1 }]);
    const res = await pay(mallory, data.data.razorpayOrder.id);
    assert.equal(res.status, 404);
  });

  it('B5/B6: verify and webhook racing settle the order exactly once', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    const { data } = await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }]);
    const rzp = data.data.razorpayOrder;
    await Promise.all([
      pay(ctx, rzp.id, 'pay_R1'),
      webhook('payment.captured', { id: 'pay_R1', order_id: rzp.id, amount: rzp.amount, currency: 'INR' }),
      webhook('order.paid', { id: 'pay_R1', order_id: rzp.id, amount: rzp.amount, currency: 'INR' }),
    ]);
    assert.equal(await stockOf(p._id, 'M'), 1);
    assert.equal((await Order.findById(data.data.orderId)).orderStatus, 'processing');
  });

  it('B6: a payment whose browser closed is recovered by the webhook', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    const { data } = await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }]);
    const rzp = data.data.razorpayOrder;
    assert.equal((await api('GET', '/payments/myorders', { token: ctx.token })).data.data.length, 0, 'unpaid checkout is not an order yet');

    const res = await webhook('payment.captured', { id: 'pay_W1', order_id: rzp.id, amount: rzp.amount, currency: 'INR' });
    assert.equal(res.status, 200);
    const mine = await api('GET', '/payments/myorders', { token: ctx.token });
    assert.equal(mine.data.data.length, 1);
    assert.equal(mine.data.data[0].paymentStatus, 'completed');
    assert.equal(mine.data.data[0].razorpayPaymentId, 'pay_W1');

    // Razorpay retries / duplicates change nothing.
    await webhook('payment.captured', { id: 'pay_W1', order_id: rzp.id, amount: rzp.amount, currency: 'INR' });
    assert.equal(await stockOf(p._id, 'M'), 1);
  });

  it('B6: webhook rejects bad signatures, wrong amounts, unknown orders; ignores payment.failed', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    const { data } = await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }]);
    const rzp = data.data.razorpayOrder;
    const entity = { id: 'pay_X', order_id: rzp.id, amount: rzp.amount, currency: 'INR' };

    assert.equal((await webhook('payment.captured', entity, 'not_the_secret')).status, 400);
    assert.equal((await webhook('payment.captured', { ...entity, amount: 100 })).data.ignored, 'amount mismatch');
    assert.equal((await webhook('payment.captured', { ...entity, order_id: 'order_unknown' })).data.ignored, 'unknown order');
    assert.equal((await webhook('payment.failed', entity)).data.ignored, 'payment.failed');
    assert.equal((await Order.findById(data.data.orderId)).orderStatus, 'awaiting_payment');

    // Out-of-order delivery: failed (first attempt), then captured (retry) settles.
    assert.equal((await webhook('payment.captured', entity)).status, 200);
    await webhook('payment.failed', entity);
    assert.equal((await Order.findById(data.data.orderId)).orderStatus, 'processing', 'a later failure never undoes a payment');
  });

  it('B6: webhook refuses to act when the webhook secret is not configured', async () => {
    const saved = ENV.RAZORPAY_WEBHOOK_SECRET;
    try {
      ENV.RAZORPAY_WEBHOOK_SECRET = '';
      const res = await webhook('payment.captured', { id: 'p', order_id: 'o', amount: 1, currency: 'INR' }, 'anything');
      assert.equal(res.status, 503);
    } finally {
      ENV.RAZORPAY_WEBHOOK_SECRET = saved;
    }
  });

  it('unpaid checkouts are hidden from the admin list and dashboard', async () => {
    const ctx = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const p = await makeProduct();
    await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }]);
    assert.equal((await api('GET', '/payments/admin/orders', { token: admin.token })).data.data.length, 0);
    assert.equal((await api('GET', '/dashboard/stats', { token: admin.token })).data.data.totalOrders, 0);
  });

  it('COD charges a 10% advance online and records the balance', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    const { data } = await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }], 'cod');
    assert.equal(created[0].amount, 240000);
    assert.deepEqual([data.data.amounts.advanceAmount, data.data.amounts.balanceAmount], [2400, 21600]);
    await pay(ctx, data.data.razorpayOrder.id);
    const order = await Order.findById(data.data.orderId);
    assert.equal(order.paymentStatus, 'pending');
    assert.equal(order.orderStatus, 'processing');
  });

  it('B12: stock is checked at checkout and taken at payment; a late sell-out is flagged', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    assert.equal((await checkout(ctx, [{ product: p.id, size: 'M', quantity: 3 }])).status, 409);
    // Same size twice in one bag counts together.
    assert.equal((await checkout(ctx, [{ product: p.id, size: 'M', quantity: 2 }, { product: p.id, size: 'M', quantity: 1 }])).status, 409);
    assert.equal((await checkout(ctx, [{ product: p.id, size: 'L', quantity: 15 }])).status, 200, 'untracked sizes are unlimited');

    await Product.updateOne({ _id: p._id, 'variants.volume': 'M' }, { $set: { 'variants.$.stock': 1 } });
    const first = await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }]);
    const second = await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }]);
    await pay(ctx, first.data.data.razorpayOrder.id, 'pay_A');
    await pay(ctx, second.data.data.razorpayOrder.id, 'pay_B');
    assert.equal(await stockOf(p._id, 'M'), 0);
    assert.equal((await Order.findById(second.data.data.orderId)).stockShortfall, true);
    const soldOut = await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }]);
    assert.equal(soldOut.status, 409);
    assert.match(soldOut.data.message, /sold out/);
  });

  it('F2: an address without a PIN code is refused before any payment; full address reaches the order', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    const bad = await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }], 'razorpay', ctx.incompleteAddressId);
    assert.equal(bad.status, 400);
    assert.equal(created.length, 0, 'no Razorpay order was opened');

    const { data } = await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }]);
    const order = await Order.findById(data.data.orderId);
    assert.deepEqual(
      [order.shippingAddress.street, order.shippingAddress.apartment, order.shippingAddress.landmark, order.shippingAddress.state, order.shippingAddress.zipCode],
      ['12 Marine Drive', 'Flat 4B', 'Near the boat jetty', 'Kerala', '682001']
    );
  });

  it('refuses archived pieces, ₹0 pieces and sizes that do not exist', async () => {
    const ctx = await makeUser();
    const archived = await makeProduct({ status: 'Archived' });
    const enquire = await makeProduct({ variants: [{ volume: 'M', price: 0, images: [] }] });
    const p = await makeProduct();
    assert.equal((await checkout(ctx, [{ product: archived.id, size: 'M', quantity: 1 }])).status, 404);
    assert.equal((await checkout(ctx, [{ product: enquire.id, size: 'M', quantity: 1 }])).status, 400);
    assert.equal((await checkout(ctx, [{ product: p.id, size: 'XXL', quantity: 1 }])).status, 400);
  });

  async function paidOrder(ctx: Ctx, size = 'M', method = 'razorpay') {
    const p = await makeProduct();
    const { data } = await checkout(ctx, [{ product: p.id, size, quantity: 1 }], method);
    await pay(ctx, data.data.razorpayOrder.id, `pay_${Math.random()}`);
    return { orderId: data.data.orderId as string, product: p };
  }

  it('B13: order status follows the allowed transitions only', async () => {
    const ctx = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const { orderId } = await paidOrder(ctx);
    const set = (orderStatus: string) => api('PUT', `/payments/admin/orders/${orderId}/status`, { token: admin.token, body: { orderStatus } });

    assert.equal((await set('delivered')).status, 400, 'processing → delivered skips shipping');
    assert.equal((await set('refunded')).status, 400, 'not an order status');
    assert.equal((await set('shipped')).status, 200);
    assert.equal((await set('processing')).status, 200, 'undo an accidental "shipped"');
    assert.equal((await set('shipped')).status, 200);
    assert.equal((await set('delivered')).status, 200);
    assert.equal((await set('processing')).status, 400, 'delivered is final');
    assert.equal((await set('cancelled')).status, 400, 'delivered is final');
  });

  it('B13: cancelling a paid order marks a refund due; only then can it be marked refunded', async () => {
    const ctx = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const { orderId } = await paidOrder(ctx);
    const markRefunded = () => api('PUT', `/payments/admin/orders/${orderId}/payment-status`, { token: admin.token, body: { paymentStatus: 'refunded' } });

    assert.equal((await markRefunded()).status, 400, 'nothing to refund yet');
    const cancelled = await api('PUT', `/payments/admin/orders/${orderId}/status`, { token: admin.token, body: { orderStatus: 'cancelled' } });
    assert.equal(cancelled.data.data.paymentStatus, 'refund_due');
    assert.equal((await markRefunded()).data.data.paymentStatus, 'refunded');
    assert.equal((await markRefunded()).status, 400);
  });

  it('B13: delivering a COD order records the balance as collected', async () => {
    const ctx = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const { orderId } = await paidOrder(ctx, 'M', 'cod');
    await api('PUT', `/payments/admin/orders/${orderId}/status`, { token: admin.token, body: { orderStatus: 'shipped' } });
    const res = await api('PUT', `/payments/admin/orders/${orderId}/status`, { token: admin.token, body: { orderStatus: 'delivered' } });
    assert.equal(res.data.data.paymentStatus, 'completed');
  });

  it('B21: revenue counts money received only', async () => {
    const ctx = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    await paidOrder(ctx, 'M'); // ₹24,000 paid
    await paidOrder(ctx, 'L', 'cod'); // ₹25,000 COD → ₹2,500 advance received
    const { orderId: cancelledId } = await paidOrder(ctx, 'M');
    await api('PUT', `/payments/admin/orders/${cancelledId}/status`, { token: admin.token, body: { orderStatus: 'cancelled' } });
    // A legacy order "paid" with the old mock bypass.
    await Order.collection.insertOne({
      user: ctx.user._id, items: [], shippingAddress: { city: 'x', state: 'y', zipCode: '1', country: 'India' },
      subtotal: 99999, total: 99999, paymentMethod: 'razorpay', paymentStatus: 'completed', orderStatus: 'processing', razorpayPaymentId: 'mock_payment',
    });
    const stats = await api('GET', '/dashboard/stats', { token: admin.token });
    assert.equal(stats.data.data.totalRevenue, 26500);
  });

  it('B22: order lines keep the piece name and size after the product is deleted', async () => {
    const ctx = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const { product } = await paidOrder(ctx, 'M');
    assert.equal((await api('DELETE', `/products/${product.id}`, { token: admin.token })).status, 200);
    const [order] = (await api('GET', '/payments/myorders', { token: ctx.token })).data.data;
    assert.equal(order.items[0].product, null);
    assert.equal(order.items[0].name, 'Thamara');
    assert.equal(order.items[0].size, 'M');
    assert.match(order.items[0].image, /thamara\.jpg$/);
  });

  it('F4: Track Order answers only with the matching email, and not for unpaid checkouts', async () => {
    const ctx = await makeUser();
    const { orderId } = await paidOrder(ctx);
    const ok = await api('POST', '/payments/track', { body: { orderId, email: ctx.user.email.toUpperCase() } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.data.orderStatus, 'processing');
    assert.equal(ok.data.data.itemCount, 1);
    assert.equal(ok.data.data.shippingAddress, undefined, 'no personal details');
    assert.equal((await api('POST', '/payments/track', { body: { orderId, email: 'someone@else.com' } })).status, 404);

    const p = await makeProduct();
    const unpaid = await checkout(ctx, [{ product: p.id, size: 'M', quantity: 1 }]);
    assert.equal((await api('POST', '/payments/track', { body: { orderId: unpaid.data.data.orderId, email: ctx.user.email } })).status, 404);
  });

  it('B23: orders are indexed for per-customer history', async () => {
    const indexes = await Order.collection.indexes();
    assert.ok(indexes.some((i: any) => i.key.user === 1 && i.key.createdAt === -1));
    assert.ok(indexes.some((i: any) => i.key.razorpayOrderId === 1));
  });
});
