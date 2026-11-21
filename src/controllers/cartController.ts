import { Request, Response } from 'express';
import { Cart, ICart } from '../models/Cart';
import { Product } from '../models/Product';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';

// A cart line's "size" identifies the chosen variant. When the frontend doesn't send one
// (e.g. adding from a product card that has no size picker), fall back to the product's
// first/default variant volume so the same product always keys to the same line and merges.
const resolveSize = (product: any, size?: string): string | undefined => {
  if (size && size.length) return size;
  return product?.variants?.[0]?.volume;
};

// Checkout accepts at most 20 of one piece per line, so the cart never holds more.
const MAX_PER_LINE = 20;

/**
 * Why a line can't be bought online right now, or null when it can. Mirrors
 * the checks checkout makes (utils/orders priceCheckout), so a bag never holds
 * something the shopper will only be refused at payment.
 */
const unavailableReason = (product: any, size?: string): string | null => {
  if (!product || product.status === 'Archived') return 'no longer available';
  const variant = product.variants?.find((v: any) => v.volume === size);
  if (!variant) return size ? `no longer available in size ${size}` : 'no longer available';
  if (!(variant.price > 0)) return 'available on enquiry only';
  return null;
};

/** The thumbnail the storefront shows: product photo, else this size's, else any size's. */
const lineImage = (product: any, size?: string): string =>
  product.images?.[0] ||
  product.variants?.find((v: any) => v.volume === size)?.images?.[0] ||
  product.variants?.map((v: any) => v.images?.[0]).find(Boolean) ||
  '';

/** This user's cart, created on first use. Atomic, so two tabs can't create two. */
const cartFor = (userId: unknown) =>
  Cart.findOneAndUpdate({ user: userId }, { $setOnInsert: { items: [] } }, { upsert: true, new: true });

/**
 * Removes lines that can no longer be bought (piece deleted or archived, size
 * withdrawn, no online price) and folds duplicate product + size lines
 * together. Leaves the cart populated; returns the names of removed pieces so
 * the storefront can tell the shopper rather than drop them silently.
 */
async function tidy(cart: ICart): Promise<string[]> {
  await cart.populate('items.product');
  const kept = new Map<string, { product: any; quantity: number; size?: string }>();
  const removed: string[] = [];
  let changed = false;

  for (const item of cart.items) {
    const product = item.product as any;
    const size = resolveSize(product, item.size);
    if (unavailableReason(product, size)) {
      changed = true;
      if (product?.name) removed.push(product.name);
      continue;
    }
    const key = `${product._id.toString()}__${size ?? ''}`;
    const existing = kept.get(key);
    if (existing) {
      existing.quantity = Math.min(MAX_PER_LINE, existing.quantity + item.quantity);
      changed = true;
    } else {
      kept.set(key, { product: product._id, quantity: item.quantity, size });
      if (size !== item.size) changed = true; // stored size differed from the resolved one
    }
  }

  if (changed) {
    cart.items = Array.from(kept.values()) as any;
    await cart.save();
    await cart.populate('items.product');
  }
  return removed;
}

/** The cart as the storefront reads it, plus anything just removed as unavailable. */
const cartBody = (cart: ICart, removed: string[] = []) => {
  const { mergeIds: _mergeIds, ...rest } = cart.toObject() as any;
  return { ...rest, removed };
};

// Get Cart
export const getCart = asyncHandler(async (req: Request, res: Response) => {
  const cart = await cartFor(req.user!._id);
  const removed = await tidy(cart);
  return successResponse(res, 200, 'Cart fetched successfully', cartBody(cart, removed));
});

// Add Item to Cart
export const addToCart = asyncHandler(async (req: Request, res: Response) => {
  const { productId, quantity, size } = req.body;

  const product = await Product.findById(productId);
  if (!product || product.status === 'Archived') {
    return errorResponse(res, 404, 'Product not found');
  }
  if (size && !product.variants.some((v) => v.volume === size)) {
    return errorResponse(res, 400, `${product.name} is not available in size ${size}.`);
  }
  const resolvedSize = resolveSize(product, size);
  const reason = unavailableReason(product, resolvedSize);
  if (reason) {
    return errorResponse(res, 400, `${product.name} is ${reason}.`);
  }

  const cart = await cartFor(req.user!._id);
  const existingItemIndex = cart.items.findIndex(
    (item) => item.product.toString() === productId && item.size === resolvedSize
  );

  if (existingItemIndex > -1) {
    cart.items[existingItemIndex].quantity = Math.min(MAX_PER_LINE, cart.items[existingItemIndex].quantity + quantity);
  } else {
    cart.items.push({ product: productId, quantity: Math.min(MAX_PER_LINE, quantity), size: resolvedSize });
  }

  await cart.save();
  const removed = await tidy(cart);
  return successResponse(res, 200, 'Item added to cart', cartBody(cart, removed));
});

// Update Cart Item Quantity
export const updateCartItem = asyncHandler(async (req: Request, res: Response) => {
  const { productId, quantity, size } = req.body;

  let cart = await Cart.findOne({ user: req.user?._id });
  if (!cart) {
    return errorResponse(res, 404, 'Cart not found');
  }

  const existingItemIndex = cart.items.findIndex(
    (item) => item.product.toString() === productId && item.size === size
  );

  if (existingItemIndex > -1) {
    if (quantity > 0) {
      cart.items[existingItemIndex].quantity = quantity;
    } else {
      cart.items.splice(existingItemIndex, 1);
    }
    await cart.save();
    await cart.populate('items.product');
    return successResponse(res, 200, 'Cart updated', cartBody(cart));
  } else {
    return errorResponse(res, 404, 'Item not found in cart');
  }
});

// Remove Item from Cart
export const removeFromCart = asyncHandler(async (req: Request, res: Response) => {
  const { productId, size } = req.body; // or params, but using body is easier for optional size

  let cart = await Cart.findOne({ user: req.user?._id });
  if (!cart) {
    return errorResponse(res, 404, 'Cart not found');
  }

  cart.items = cart.items.filter(
    (item) => !(item.product.toString() === productId && item.size === size)
  );

  await cart.save();
  await cart.populate('items.product');

  return successResponse(res, 200, 'Item removed from cart', cartBody(cart));
});

/**
 * Merge a guest cart into the signed-in user's cart, once.
 *
 * Quantities of the same product + size are added together (capped at 20 per
 * line); new lines are appended; the account's existing lines are kept.
 * Pieces that can't be bought any more are skipped and reported back.
 *
 * `mergeId` is the guest cart's own id. It is claimed atomically before any
 * item is added, so a retried request (lost response, a second tab, a reload
 * mid-login) changes nothing the second time — quantities can't double.
 */
export const mergeCart = asyncHandler(async (req: Request, res: Response) => {
  const { items, mergeId } = req.body as {
    items?: { productId: string; quantity: number; size?: string }[];
    mergeId?: string;
  };

  let cart = await cartFor(req.user!._id);
  if (mergeId) {
    const claimed = await Cart.updateOne(
      { _id: cart._id, mergeIds: { $ne: mergeId } },
      { $push: { mergeIds: { $each: [mergeId], $slice: -20 } } }
    );
    if (claimed.modifiedCount === 0) {
      const removed = await tidy(cart);
      return successResponse(res, 200, 'Cart already merged', cartBody(cart, removed));
    }
    cart = (await Cart.findById(cart._id))!;
  }

  const skipped: string[] = [];
  if (Array.isArray(items)) {
    const products = await Product.find({ _id: { $in: items.map((i) => i.productId) } });
    const byId = new Map(products.map((p) => [p._id.toString(), p]));

    for (const incoming of items) {
      const quantity = Number(incoming?.quantity);
      if (!incoming?.productId || !quantity || quantity < 1) continue;

      const product = byId.get(incoming.productId);
      const resolvedSize = resolveSize(product, incoming.size);
      if (unavailableReason(product, resolvedSize)) {
        if (product?.name) skipped.push(product.name);
        continue;
      }

      const existingItemIndex = cart.items.findIndex(
        (item) => item.product.toString() === incoming.productId && item.size === resolvedSize
      );

      if (existingItemIndex > -1) {
        cart.items[existingItemIndex].quantity = Math.min(MAX_PER_LINE, cart.items[existingItemIndex].quantity + quantity);
      } else {
        cart.items.push({ product: incoming.productId as any, quantity: Math.min(MAX_PER_LINE, quantity), size: resolvedSize });
      }
    }
    await cart.save();
  }

  const removed = [...skipped, ...(await tidy(cart))];
  return successResponse(res, 200, 'Cart merged successfully', cartBody(cart, removed));
});

/**
 * Prices a guest's bag (kept in their browser) from the catalogue, without an
 * account and without storing anything. The storefront shows these current
 * prices and drops what can no longer be bought. Checkout prices again anyway.
 */
export const quoteCart = asyncHandler(async (req: Request, res: Response) => {
  const { items } = req.body as { items: { productId: string; quantity: number; size?: string }[] };
  const products = await Product.find({ _id: { $in: items.map((i) => i.productId) } });
  const byId = new Map(products.map((p) => [p._id.toString(), p]));

  const lines = items.map((incoming) => {
    const product: any = byId.get(incoming.productId);
    const size = resolveSize(product, incoming.size);
    if (unavailableReason(product, size)) {
      return { productId: incoming.productId, size: incoming.size, name: product?.name ?? null, available: false };
    }
    const variant = product.variants.find((v: any) => v.volume === size);
    return {
      productId: incoming.productId,
      size,
      name: product.name,
      image: lineImage(product, size),
      price: variant.price,
      quantity: Math.min(MAX_PER_LINE, incoming.quantity),
      available: true,
    };
  });

  return successResponse(res, 200, 'Cart priced', { items: lines });
});

// Clear Cart
export const clearCart = asyncHandler(async (req: Request, res: Response) => {
  let cart = await Cart.findOne({ user: req.user?._id });
  if (cart) {
    cart.items = [];
    await cart.save();
  }
  return successResponse(res, 200, 'Cart cleared', cart);
});
