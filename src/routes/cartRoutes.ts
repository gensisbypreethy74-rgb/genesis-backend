import { Router } from 'express';
import { getCart, addToCart, updateCartItem, removeFromCart, clearCart, mergeCart, quoteCart } from '../controllers/cartController';
import { protect } from '../middlewares/authMiddleware';
import { validate, schemas } from '../middlewares/validation';

const router = Router();

// Public: current prices for a guest's bag (kept in their browser). Reads the
// catalogue only; it never sees or touches anyone's saved cart.
router.post('/quote', validate(schemas.cartQuote), quoteCart);

// Every other cart route is the signed-in customer's own cart
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
