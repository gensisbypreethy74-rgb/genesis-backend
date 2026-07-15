import express from 'express';
import { createProduct, getProducts, deleteProduct, updateProduct } from '../controllers/productController';
import { protect } from '../middlewares/authMiddleware';
import { upload } from '../middlewares/uploadMiddleware';

const router = express.Router();

// upload.any() accepts the product's `imageFiles` plus per-variant `variantImages_<index>` fields
router.route('/')
  .post(protect, upload.any(), createProduct)
  .get(getProducts);

router.route('/:id')
  .put(protect, upload.any(), updateProduct)
  .delete(protect, deleteProduct);

export default router;
