import { Request, Response } from 'express';
import Order from '../models/Order';
import { Product } from '../models/Product';
import { User } from '../models/User';
import { Category } from '../models/Category';
import { Banner } from '../models/Banner';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse } from '../utils/responseHandler';

const PLACED = { orderStatus: { $ne: 'awaiting_payment' } };

export const getDashboardStats = asyncHandler(async (req: Request, res: Response) => {
  const [
    totalOrders,
    recentOrders,
    totalProducts,
    totalCustomers,
    totalCategories,
    totalBanners,
    revenueResult,
  ] = await Promise.all([
    Order.countDocuments(PLACED),
    Order.find(PLACED).populate('user', 'name email').sort({ createdAt: -1 }).limit(5),
    Product.countDocuments(),
    User.countDocuments({ role: 'customer' }),
    Category.countDocuments(),
    Banner.countDocuments(),
    // Money actually received: full total for paid orders, the advance for open
    // COD orders. Cancelled orders and legacy simulated payments never count.
    Order.aggregate([
      {
        $match: {
          orderStatus: { $nin: ['cancelled', 'awaiting_payment'] },
          paymentStatus: { $in: ['completed', 'pending'] },
          razorpayPaymentId: { $ne: 'mock_payment' },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'completed'] }, '$total', '$advanceAmount'] } },
        },
      },
    ]),
  ]);

  const totalRevenue = revenueResult.length > 0 ? revenueResult[0].total : 0;

  successResponse(res, 200, 'Dashboard stats fetched', {
    totalRevenue,
    totalOrders,
    totalProducts,
    totalCategories,
    totalBanners,
    totalCustomers,
    recentOrders,
  });
});
