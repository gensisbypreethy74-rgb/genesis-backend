import { Request, Response } from 'express';
import Order, { IOrder } from '../models/Order';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';
import { sendEmail, isEmailConfigured, resendClient } from '../utils/sendEmail';
import logger from '../utils/logger';
import { ENV, mockPaymentsAllowed } from '../config/env';
import { razorpay, verifyPaymentSignature, verifyWebhookSignature } from '../utils/razorpay';
import { priceCheckout, markOrderPaid, onlineAmountPaise, CheckoutError } from '../utils/orders';
import { renderOrderEmail, BRAND_NAME } from '../utils/orderEmail';
import { sendOrderConfirmation } from '../utils/orderConfirmation';

const MOCK_ORDER_PREFIX = 'mock_order_';

// Unpaid checkouts never show up as orders, for customers or the studio.
const PLACED = { orderStatus: { $ne: 'awaiting_payment' } };

const ADMIN_ORDER_POPULATE = [
  { path: 'user', select: 'name email phone' },
  { path: 'items.product', select: 'name images variants' },
];

// Shared by the browser verify call and the webhook: settle once, email once.
// markOrderPaid queues the confirmation in the same write; it is sent here in
// the background, so the shopper's response never waits on the email provider,
// and anything that fails is retried by the confirmation worker.
const settlePaid = async (order: IOrder, paymentId: string, signature?: string) => {
  const result = await markOrderPaid(order._id, { paymentId, signature });
  if (result?.fresh && result.order) void sendOrderConfirmation(result.order._id);
  return result?.order ?? null;
};

// Create Order — prices the bag on the server, opens the Razorpay order for
// that amount, and records an awaiting_payment order to settle later.
export const createOrder = asyncHandler(async (req: Request, res: Response) => {
  const { items, addressId, paymentMethod } = req.body;
  const user = req.user!;

  const address = user.addresses?.find((a) => a._id?.toString() === addressId);
  if (!address) {
    return errorResponse(res, 404, 'Please choose a saved shipping address.');
  }
  if (!address.city?.trim() || !address.state?.trim() || !/^\d{5,6}$/.test(address.zipCode?.trim() || '')) {
    return errorResponse(res, 400, 'This address is missing a city, state or PIN code. Please edit it before paying.');
  }

  let priced: Awaited<ReturnType<typeof priceCheckout>>;
  try {
    priced = await priceCheckout(items, paymentMethod);
  } catch (err) {
    if (err instanceof CheckoutError) return errorResponse(res, err.statusCode, err.message);
    throw err;
  }

  const amount = Math.round(priced.payableNow * 100);
  const isMock = mockPaymentsAllowed();
  const razorpayOrder = isMock
    ? { id: `${MOCK_ORDER_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, amount, currency: 'INR' }
    : await razorpay.orders.create({ amount, currency: 'INR', receipt: `rcpt_${Date.now()}` });

  if (Number(razorpayOrder.amount) !== amount || razorpayOrder.currency !== 'INR') {
    throw new Error(`Razorpay order ${razorpayOrder.id} came back with ${razorpayOrder.amount} ${razorpayOrder.currency}, expected ${amount} INR`);
  }

  const order = await Order.create({
    user: user._id,
    items: priced.items,
    shippingAddress: {
      street: address.street?.trim(),
      apartment: address.apartment?.trim(),
      landmark: address.landmark?.trim(),
      city: address.city.trim(),
      state: address.state.trim(),
      zipCode: address.zipCode!.trim(),
      country: address.country?.trim() || 'India',
    },
    subtotal: priced.subtotal,
    discount: priced.discount,
    shippingFee: priced.shippingFee,
    total: priced.total,
    paymentMethod,
    advanceAmount: priced.advanceAmount,
    balanceAmount: priced.balanceAmount,
    paymentStatus: 'pending',
    orderStatus: 'awaiting_payment',
    razorpayOrderId: razorpayOrder.id,
  });

  successResponse(res, 200, 'Order created', {
    orderId: order._id,
    razorpayOrder: { id: razorpayOrder.id, amount, currency: 'INR' },
    isMock,
    key_id: isMock ? undefined : ENV.RAZORPAY_KEY_ID,
    prefill: { name: user.name, email: user.email, contact: user.phone || '' },
    amounts: {
      subtotal: priced.subtotal,
      discount: priced.discount,
      shippingFee: priced.shippingFee,
      total: priced.total,
      advanceAmount: priced.advanceAmount,
      balanceAmount: priced.balanceAmount,
      payableNow: priced.payableNow,
    },
  });
});

// Verify Payment — checks Razorpay's signature for one of this customer's
// awaiting orders and settles it. Idempotent: a replay returns the same order.
export const verifyPayment = asyncHandler(async (req: Request, res: Response) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  const order = await Order.findOne({ razorpayOrderId: razorpay_order_id, user: req.user!._id });
  if (!order) {
    return errorResponse(res, 404, 'Order not found');
  }

  // Simulated orders only exist (and only verify) in a dev setup without Razorpay keys.
  const valid = razorpay_order_id.startsWith(MOCK_ORDER_PREFIX)
    ? mockPaymentsAllowed()
    : verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
  if (!valid) {
    logger.warn(`Rejected payment verification for order ${order._id}`);
    return errorResponse(res, 400, 'Invalid signature. Payment verification failed.');
  }

  let settled: IOrder | null = order;
  if (order.orderStatus === 'awaiting_payment') {
    settled = await settlePaid(order, razorpay_payment_id, razorpay_signature);
  } else if (order.razorpayPaymentId && order.razorpayPaymentId !== razorpay_payment_id) {
    return errorResponse(res, 409, 'This order has already been paid.');
  }

  await settled!.populate('items.product', 'name images variants');
  successResponse(res, 200, 'Payment verified and order placed successfully', settled);
});

// Razorpay webhook — recovers payments whose browser never reached /verify.
// Mounted in app.ts with a raw body parser; Razorpay retries any non-2xx.
export const razorpayWebhook = async (req: Request, res: Response) => {
  try {
    if (!ENV.RAZORPAY_WEBHOOK_SECRET) {
      logger.error('Razorpay webhook received but RAZORPAY_WEBHOOK_SECRET is not set');
      return res.status(503).json({ success: false, message: 'Webhook not configured' });
    }
    const raw = req.body;
    if (!Buffer.isBuffer(raw) || !verifyWebhookSignature(raw, req.get('x-razorpay-signature'))) {
      logger.warn('Rejected Razorpay webhook with a bad signature');
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    const event = JSON.parse(raw.toString('utf8'));
    // Only "money arrived" events settle an order. payment.failed (e.g. a
    // failed first attempt before a successful retry) never undoes anything.
    if (event.event !== 'payment.captured' && event.event !== 'order.paid') {
      return res.status(200).json({ success: true, ignored: event.event });
    }

    const payment = event.payload?.payment?.entity;
    const order = payment?.order_id ? await Order.findOne({ razorpayOrderId: payment.order_id }) : null;
    if (!order) {
      logger.warn(`Razorpay webhook ${event.event} for unknown order ${payment?.order_id}`);
      return res.status(200).json({ success: true, ignored: 'unknown order' });
    }
    if (Number(payment.amount) !== onlineAmountPaise(order) || payment.currency !== 'INR') {
      logger.error(`Razorpay webhook amount mismatch on order ${order._id}: got ${payment.amount} ${payment.currency}, expected ${onlineAmountPaise(order)} INR`);
      return res.status(200).json({ success: true, ignored: 'amount mismatch' });
    }

    if (order.orderStatus === 'awaiting_payment') await settlePaid(order, payment.id);
    return res.status(200).json({ success: true });
  } catch (err: any) {
    logger.error(`Razorpay webhook failed: ${err?.stack || err}`);
    return res.status(500).json({ success: false });
  }
};

// Resend webhook — what happened to a confirmation email after we sent it.
// Kept apart from the send status: "sent" means Resend accepted it; these say
// whether it reached the inbox. Mounted in app.ts with a raw body parser,
// because the signature covers the exact bytes. Resend retries any non-2xx.
const DELIVERY_EVENTS: Record<string, string> = {
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delivery_delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
};

export const resendWebhook = async (req: Request, res: Response) => {
  try {
    const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
    if (!secret || !isEmailConfigured()) {
      logger.error('Resend webhook received but RESEND_WEBHOOK_SECRET or the Resend email setup is missing');
      return res.status(503).json({ success: false, message: 'Webhook not configured' });
    }
    const raw = req.body;
    let event: any;
    try {
      if (!Buffer.isBuffer(raw)) throw new Error('no body');
      event = resendClient().webhooks.verify({
        payload: raw.toString('utf8'),
        headers: {
          id: req.get('svix-id') || req.get('webhook-id') || '',
          timestamp: req.get('svix-timestamp') || req.get('webhook-timestamp') || '',
          signature: req.get('svix-signature') || req.get('webhook-signature') || '',
        },
        webhookSecret: secret,
      });
    } catch {
      logger.warn('Rejected Resend webhook with a bad or expired signature');
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    const status = DELIVERY_EVENTS[event.type];
    const emailId = event.data?.email_id;
    if (!status || !emailId) return res.status(200).json({ success: true, ignored: event.type });

    // Events can arrive out of order: "delayed" never overwrites a final outcome.
    const filter: Record<string, unknown> = { 'confirmationEmail.resendId': emailId };
    if (status === 'delivery_delayed') {
      filter.$or = [{ 'confirmationEmail.delivery.status': null }, { 'confirmationEmail.delivery.status': 'delivery_delayed' }];
    }
    const at = new Date(event.created_at || Date.now());
    const updated = await Order.findOneAndUpdate(filter, { $set: { 'confirmationEmail.delivery': { status, at } } }).select('_id');
    if (updated && status !== 'delivered' && status !== 'delivery_delayed') {
      logger.warn(`Order confirmation for ${updated._id} was ${status} (Resend email ${emailId})`);
    }
    return res.status(200).json({ success: true });
  } catch (err: any) {
    logger.error(`Resend webhook failed: ${err?.stack || err}`);
    return res.status(500).json({ success: false });
  }
};

// Public order lookup for the Track Order page: needs the order ID and the
// email on the account, and reveals status only.
export const trackOrder = asyncHandler(async (req: Request, res: Response) => {
  const { orderId, email } = req.body;
  const order = await Order.findOne({ _id: orderId, ...PLACED }).populate('user', 'email');
  const ownerEmail = (order?.user as any)?.email as string | undefined;
  if (!order || ownerEmail?.toLowerCase() !== String(email).trim().toLowerCase()) {
    return errorResponse(res, 404, "We couldn't find an order with that ID and email.");
  }
  successResponse(res, 200, 'Order found', {
    orderId: order._id,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    placedAt: order.paidAt || order.createdAt,
    updatedAt: order.updatedAt,
    itemCount: order.items.reduce((n, i) => n + i.quantity, 0),
  });
});

// Get My Orders
export const getMyOrders = asyncHandler(async (req: Request, res: Response) => {
  const orders = await Order.find({ user: req.user?._id, ...PLACED })
    .populate('items.product', 'name images')
    .sort({ createdAt: -1 });

  successResponse(res, 200, 'Orders fetched', orders);
});

// Admin: Get a specific customer's order history
export const getCustomerOrders = asyncHandler(async (req: Request, res: Response) => {
  const orders = await Order.find({ user: req.params.id, ...PLACED })
    .populate('items.product', 'name images')
    .sort({ createdAt: -1 });

  successResponse(res, 200, 'Orders fetched', orders);
});

// Admin: Get All Orders. `?page=&limit=` is optional; without it every order is returned as before.
export const getAllOrders = asyncHandler(async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 0, 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  // The studio sees each order's confirmation email status; shoppers' order views never include it.
  let query = Order.find(PLACED).select('+confirmationEmail').populate(ADMIN_ORDER_POPULATE).sort({ createdAt: -1 });
  if (limit) query = query.skip((page - 1) * limit).limit(limit);

  successResponse(res, 200, 'Orders fetched', await query);
});

// Allowed moves for the studio. shipped → processing undoes an accidental "shipped".
const TRANSITIONS: Record<string, string[]> = {
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered', 'cancelled', 'processing'],
  delivered: [],
  cancelled: [],
};

const STATUS_EMAILS: Record<string, { label: string; color: string; subject: string; message: string }> = {
  shipped: { label: 'Shipped', color: '#3b82f6', subject: 'Order Shipped', message: 'Great news! Your order has been shipped and is on its way to you.' },
  delivered: { label: 'Delivered', color: '#10b981', subject: 'Order Delivered', message: 'Your order has been delivered successfully. We hope you enjoy your purchase!' },
  cancelled: { label: 'Cancelled', color: '#ef4444', subject: 'Order Cancelled', message: 'Your order has been cancelled. If you have been charged, a refund will be initiated shortly.' },
};

// Admin: Update Order Status
export const updateOrderStatus = asyncHandler(async (req: Request, res: Response) => {
  const next: string = req.body.orderStatus;
  const order = await Order.findOne({ _id: req.params.id, ...PLACED });
  if (!order) {
    return errorResponse(res, 404, 'Order not found');
  }

  const from = order.orderStatus;
  if (from === next) {
    await order.populate(ADMIN_ORDER_POPULATE);
    return successResponse(res, 200, 'Status unchanged', order);
  }
  if (!TRANSITIONS[from]?.includes(next)) {
    return errorResponse(res, 400, `An order that is ${from} can't be marked ${next}.`);
  }

  const set: Record<string, unknown> = { orderStatus: next };
  const moneyReceived = order.paymentStatus === 'completed' || (order.paymentMethod === 'cod' && order.paymentStatus === 'pending' && order.advanceAmount > 0);
  if (next === 'cancelled' && moneyReceived) set.paymentStatus = 'refund_due';
  // Delivering a COD order means the balance was collected at the door.
  if (next === 'delivered' && order.paymentMethod === 'cod' && order.paymentStatus === 'pending') set.paymentStatus = 'completed';

  // Conditional on the status we validated against, so two admins can't race past the rules.
  const updated = await Order.findOneAndUpdate({ _id: order._id, orderStatus: from }, { $set: set }, { new: true, runValidators: true })
    .populate(ADMIN_ORDER_POPULATE);
  if (!updated) {
    return errorResponse(res, 409, 'This order was just changed by someone else. Refresh and try again.');
  }

  const email = STATUS_EMAILS[next];
  const user = updated.user as any;
  if (email && user?.email) {
    try {
      await sendEmail({
        email: user.email,
        subject: `${email.subject} · ${BRAND_NAME}`,
        html: renderOrderEmail({
          order: updated,
          customerName: user.name,
          heading: 'Order Status Update',
          message: email.message,
          status: { label: email.label, color: email.color },
          ctaLabel: 'View Order History',
        }),
      });
    } catch (err: any) {
      logger.error(`Status email failed for order ${updated._id}: ${err?.message || err}`);
    }
  }

  successResponse(res, 200, 'Order status updated', updated);
});

// Admin: record that a refund due on a cancelled order has been paid out
// (the refund itself is issued from the Razorpay dashboard).
export const updatePaymentStatus = asyncHandler(async (req: Request, res: Response) => {
  const updated = await Order.findOneAndUpdate(
    { _id: req.params.id, paymentStatus: 'refund_due' },
    { $set: { paymentStatus: 'refunded' } },
    { new: true }
  ).populate(ADMIN_ORDER_POPULATE);

  if (!updated) {
    const exists = await Order.exists({ _id: req.params.id, ...PLACED });
    return exists
      ? errorResponse(res, 400, 'Only orders with a refund due can be marked refunded.')
      : errorResponse(res, 404, 'Order not found');
  }
  successResponse(res, 200, 'Marked as refunded', updated);
});
