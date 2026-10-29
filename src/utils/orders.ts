import Order, { IOrder } from '../models/Order';
import { Product } from '../models/Product';
import { Cart } from '../models/Cart';

// Checkout rules, previously only in the storefront. The browser now just
// displays them; the server is what charges.
export const SHIPPING_FEE = 0; // storefront shows "Complimentary"
export const COD_ADVANCE_RATE = 0.1; // COD: 10% online now, balance on delivery

const round2 = (n: number) => Math.round(n * 100) / 100;

export class CheckoutError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export interface CheckoutLine {
  product: string;
  size?: string;
  quantity: number;
}

/** Prices a checkout from the catalogue. The client only says which pieces, sizes and how many. */
export async function priceCheckout(lines: CheckoutLine[], paymentMethod: 'razorpay' | 'cod') {
  // Same piece + size twice counts as one line, so the stock check sees the real quantity.
  const merged = new Map<string, CheckoutLine>();
  for (const l of lines) {
    const key = `${l.product}__${l.size ?? ''}`;
    const existing = merged.get(key);
    if (existing) existing.quantity += l.quantity;
    else merged.set(key, { ...l });
  }

  const products = await Product.find({ _id: { $in: [...new Set(lines.map((l) => l.product))] } });
  const byId = new Map(products.map((p) => [p._id.toString(), p]));

  const items = [...merged.values()].map((line) => {
    const p = byId.get(line.product);
    if (!p || p.status === 'Archived') {
      throw new CheckoutError(404, 'A piece in your bag is no longer available. Please remove it and try again.');
    }
    const variant = line.size ? p.variants.find((v) => v.volume === line.size) : p.variants[0];
    if (!variant) {
      throw new CheckoutError(400, `${p.name} is not available${line.size ? ` in size ${line.size}` : ''}.`);
    }
    if (!(variant.price > 0)) {
      throw new CheckoutError(400, `${p.name} can't be bought online. Please contact the studio.`);
    }
    if (typeof variant.stock === 'number' && variant.stock < line.quantity) {
      throw new CheckoutError(
        409,
        variant.stock === 0
          ? `${p.name} (${variant.volume}) is sold out.`
          : `Only ${variant.stock} of ${p.name} (${variant.volume}) left.`
      );
    }
    return {
      product: p._id,
      name: p.name,
      image: p.images?.[0] || variant.images?.[0] || p.variants.map((v) => v.images?.[0]).find(Boolean),
      size: variant.volume,
      quantity: line.quantity,
      price: variant.price,
    };
  });

  const subtotal = round2(items.reduce((sum, i) => sum + i.price * i.quantity, 0));
  const discount = 0;
  const shippingFee = SHIPPING_FEE;
  const total = round2(subtotal - discount + shippingFee);
  const isCod = paymentMethod === 'cod';
  const advanceAmount = isCod ? round2(total * COD_ADVANCE_RATE) : 0;
  const balanceAmount = isCod ? round2(total - advanceAmount) : 0;
  const payableNow = isCod ? advanceAmount : total;
  if (payableNow < 1) {
    throw new CheckoutError(400, 'The amount to pay must be at least ₹1.');
  }
  return { items, subtotal, discount, shippingFee, total, advanceAmount, balanceAmount, payableNow };
}

/** What Razorpay should have collected for this order, in paise. */
export const onlineAmountPaise = (order: Pick<IOrder, 'paymentMethod' | 'advanceAmount' | 'total'>) =>
  Math.round((order.paymentMethod === 'cod' ? order.advanceAmount : order.total) * 100);

/**
 * Decrements stock for tracked sizes. Returns true if any tracked size had
 * fewer pieces than were bought (it sold out between checkout and payment).
 */
async function takeStock(items: IOrder['items']) {
  let shortfall = false;
  for (const item of items) {
    const res = await Product.updateOne(
      { _id: item.product, variants: { $elemMatch: { volume: item.size, stock: { $gte: item.quantity } } } },
      { $inc: { 'variants.$.stock': -item.quantity } }
    );
    if (res.modifiedCount === 0) {
      // Untracked sizes have no stock number; only a tracked one can fall short.
      const tracked = await Product.exists({
        _id: item.product,
        variants: { $elemMatch: { volume: item.size, stock: { $type: 'number' } } },
      });
      if (tracked) shortfall = true;
    }
  }
  return shortfall;
}

/**
 * Moves an order from awaiting_payment to paid exactly once. The browser
 * verify call and the Razorpay webhook may both call this, in any order and
 * any number of times; only the first one transitions the order and runs the
 * side effects (stock, cart). `fresh` tells the caller whether it was that one.
 */
export async function markOrderPaid(orderId: unknown, payment: { paymentId: string; signature?: string }) {
  const current = await Order.findById(orderId);
  if (!current) return null;

  const set: Record<string, unknown> = {
    orderStatus: 'processing',
    // COD: only the advance is in; the balance is collected on delivery.
    paymentStatus: current.paymentMethod === 'cod' ? 'pending' : 'completed',
    razorpayPaymentId: payment.paymentId,
    paidAt: new Date(),
  };
  if (payment.signature) set.razorpaySignature = payment.signature;

  const paid = await Order.findOneAndUpdate(
    { _id: current._id, orderStatus: 'awaiting_payment' },
    { $set: set },
    { new: true }
  );
  if (!paid) return { order: await Order.findById(current._id), fresh: false };

  if (await takeStock(paid.items)) {
    paid.stockShortfall = true;
    await paid.save();
  }
  await Cart.updateOne({ user: paid.user }, { $set: { items: [] } });
  return { order: paid, fresh: true };
}
