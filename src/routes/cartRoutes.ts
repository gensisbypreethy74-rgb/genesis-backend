import { Router } from 'express';
import { getCart, addToCart, updateCartItem, removeFromCart, clearCart, mergeCart } from '../controllers/cartController';
import { protect } from '../middlewares/authMiddleware';
import { validate, schemas } from '../middlewares/validation';

const router = Router();

// All cart routes require authentication
router.use(protect);

router.route('/')
  .get(getCart)
  .post(validate(schemas.cartAdd), addToCart)
  .delete(clearCart); // Delete whole cart or clear items

// Merge a guest cart into the user's cart after login
router.post('/merge', validate(schemas.cartMerge), mergeCart);

router.route('/item')
  .put(validate(schemas.cartUpdate), updateCartItem)
  .delete(validate(schemas.cartRemove), removeFromCart); // Requires body { productId, size }

export default router;
