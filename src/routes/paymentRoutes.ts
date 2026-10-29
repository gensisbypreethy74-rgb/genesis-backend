import express from 'express';
import {
  createOrder,
  verifyPayment,
  trackOrder,
  getMyOrders,
  getCustomerOrders,
  getAllOrders,
  updateOrderStatus,
  updatePaymentStatus,
} from '../controllers/paymentController';
import { protect, authorize } from '../middlewares/authMiddleware';
import { validate, schemas } from '../middlewares/validation';
import { paymentLimiter, trackOrderLimiter } from '../middlewares/rateLimiter';

const router = express.Router();

// POST /webhook is mounted in app.ts: it needs the raw body for its signature.
router.post('/create-order', paymentLimiter, protect, validate(schemas.createOrder), createOrder);
router.post('/verify', paymentLimiter, protect, validate(schemas.verifyPayment), verifyPayment);
router.post('/track', trackOrderLimiter, validate(schemas.trackOrder), trackOrder);
router.get('/myorders', protect, getMyOrders);

// Admin routes
const adminOnly = [protect, authorize('admin', 'superadmin')];
router.get('/admin/orders', ...adminOnly, getAllOrders);
router.get('/admin/customers/:id/orders', ...adminOnly, validate(schemas.mongoId), getCustomerOrders);
router.put('/admin/orders/:id/status', ...adminOnly, validate(schemas.orderStatus), updateOrderStatus);
router.put('/admin/orders/:id/payment-status', ...adminOnly, validate(schemas.paymentStatus), updatePaymentStatus);

export default router;
