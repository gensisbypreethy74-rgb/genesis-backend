import express from 'express';
import { createCategory, getCategories, deleteCategory, updateCategory } from '../controllers/categoryController';
import { protect } from '../middlewares/authMiddleware';
import { upload } from '../middlewares/uploadMiddleware';

const router = express.Router();

router.route('/')
  .post(protect, upload.single('imageFile'), createCategory)
  .get(getCategories);

router.route('/:id')
  .put(protect, upload.single('imageFile'), updateCategory)
  .delete(protect, deleteCategory);

export default router;
