import express from 'express';
import { createProduct, getProducts, getProductById, deleteProduct, updateProduct } from '../controllers/productController';
import { protect, authorize } from '../middlewares/authMiddleware';
import { productUpload } from '../middlewares/uploadMiddleware';

const router = express.Router();

// Catalog writes are admin-only; reads stay public.
const adminOnly = [protect, authorize('admin', 'superadmin')];

// productUpload accepts the product's `imageFiles` plus per-variant `variantImages_<index>` fields
router.route('/')
  .post(...adminOnly, productUpload, createProduct)
  .get(getProducts);

router.route('/:id')
  .get(getProductById)
  .put(...adminOnly, productUpload, updateProduct)
  .delete(...adminOnly, deleteProduct);

export default router;
