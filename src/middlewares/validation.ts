import { Request, Response, NextFunction } from 'express';
import { z, ZodSchema } from 'zod';
import { errorResponse } from '../utils/responseHandler';

// Validation middleware factory
export const validate = (schema: ZodSchema) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      next();
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        const errors = error.errors.map((err) => ({
          field: err.path.join('.'),
          message: err.message,
        }));
        // Lead with the first concrete problem; the full list stays in `errors`.
        return errorResponse(res, 400, errors[0]?.message || 'Validation failed', errors);
      }
      return errorResponse(res, 400, 'Invalid request data');
    }
  };
};

const objectId = (label = 'ID') => z.string().regex(/^[0-9a-fA-F]{24}$/, `Invalid ${label}`);
const size = z.string().max(40).optional();
const quantity = z.number({ invalid_type_error: 'Quantity must be a number' }).int('Quantity must be a whole number');

// Common validation schemas
export const schemas = {
  // Auth schemas
  login: z.object({
    body: z.object({
      email: z.string().email('Invalid email address'),
      password: z.string().min(1, 'Password is required'),
    }),
  }),

  googleAuth: z.object({
    body: z.object({
      accessToken: z.string().min(1).max(4096).optional(),
      credential: z.string().min(1).max(4096).optional(),
      mode: z.enum(['signin', 'register']).optional(),
    }).refine((b) => b.accessToken || b.credential, { message: 'Google credential is required' }),
  }),

  // Checkout: the client names what it wants; the server prices it.
  createOrder: z.object({
    body: z.object({
      items: z.array(z.object({
        product: objectId('product ID'),
        size,
        quantity: quantity.min(1, 'Quantity must be at least 1').max(20, 'At most 20 of one piece per order'),
      })).min(1, 'Your bag is empty').max(50, 'Too many items in one order'),
      addressId: objectId('address'),
      paymentMethod: z.enum(['razorpay', 'cod']),
    }),
  }),

  verifyPayment: z.object({
    body: z.object({
      razorpay_order_id: z.string().min(1).max(100),
      razorpay_payment_id: z.string().min(1).max(100),
      razorpay_signature: z.string().min(1).max(256),
    }),
  }),

  orderStatus: z.object({
    params: z.object({ id: objectId('order ID') }),
    body: z.object({ orderStatus: z.enum(['processing', 'shipped', 'delivered', 'cancelled']) }),
  }),

  paymentStatus: z.object({
    params: z.object({ id: objectId('order ID') }),
    body: z.object({ paymentStatus: z.literal('refunded') }),
  }),

  trackOrder: z.object({
    body: z.object({
      orderId: objectId('order ID'),
      email: z.string().email('Enter the email used on the order'),
    }),
  }),

  // Cart schemas
  cartAdd: z.object({
    body: z.object({
      productId: objectId('product ID'),
      quantity: quantity.min(1, 'Quantity must be at least 1').max(20, 'At most 20 of one piece'),
      size,
    }),
  }),

  cartUpdate: z.object({
    body: z.object({
      productId: objectId('product ID'),
      quantity: quantity.min(0).max(20, 'At most 20 of one piece'),
      size,
    }),
  }),

  cartRemove: z.object({
    body: z.object({ productId: objectId('product ID'), size }),
  }),

  cartMerge: z.object({
    body: z.object({
      items: z.array(z.object({
        productId: objectId('product ID'),
        quantity: quantity.min(1).max(20),
        size,
      })).max(50, 'Too many items to merge'),
    }),
  }),

  // User schemas
  updateProfile: z.object({
    body: z.object({
      name: z.string().min(2).max(100).optional(),
      phone: z.string().max(20).optional(),
    }),
  }),

  // Matches the storefront address forms and what an order needs for delivery.
  addAddress: z.object({
    body: z.object({
      street: z.string().max(200).optional(),
      apartment: z.string().max(100).optional(),
      landmark: z.string().max(100).optional(),
      city: z.string().trim().min(1, 'City is required').max(100),
      state: z.string().trim().min(1, 'State is required').max(100),
      zipCode: z.string().trim().regex(/^\d{5,6}$/, 'Enter a valid 5-6 digit PIN code'),
      country: z.string().max(100).optional(),
    }),
  }),

  // Newsletter
  subscribe: z.object({
    body: z.object({
      email: z.string().email('Invalid email address'),
      source: z.string().max(60).optional(),
    }),
  }),

  siteSettings: z.object({
    body: z.object({ whatsappNumber: z.string().max(30).optional() }),
  }),

  // ID parameter validation
  mongoId: z.object({
    params: z.object({ id: objectId() }),
  }),
};
