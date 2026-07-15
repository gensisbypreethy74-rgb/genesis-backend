import express from 'express';
import { createOrder, verifyPayment, getMyOrders, getCustomerOrders, getAllOrders, updateOrderStatus } from '../controllers/paymentController';
import { protect, authorize } from '../middlewares/authMiddleware';

const router = express.Router();

router.post('/create-order', protect, createOrder);
router.post('/verify', protect, verifyPayment);
router.get('/myorders', protect, getMyOrders);

// Admin routes
router.get('/admin/orders', protect, authorize('admin', 'superadmin'), getAllOrders);
router.get('/admin/customers/:id/orders', protect, authorize('admin', 'superadmin'), getCustomerOrders);
router.put('/admin/orders/:id/status', protect, authorize('admin', 'superadmin'), updateOrderStatus);

export default router;
