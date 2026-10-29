import { Request, Response } from 'express';
import { Category } from '../models/Category';
import { Product } from '../models/Product';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';

/**
 * Ceiling on studio-managed categories. The storefront's category grid is laid
 * out for a bounded set, so the cap is enforced here — at the API — not only in
 * the admin UI, which a direct POST would bypass.
 */
export const MAX_CATEGORIES = 8;

export const createCategory = asyncHandler(async (req: Request, res: Response) => {
  const count = await Category.countDocuments();
  if (count >= MAX_CATEGORIES) {
    return errorResponse(
      res,
      400,
      `A maximum of ${MAX_CATEGORIES} categories is allowed. Delete one to add another.`
    );
  }
  if (req.file) {
    req.body.image = req.file.path;
  }
  const category = await Category.create(req.body);
  successResponse(res, 201, 'Category created successfully', category);
});

export const getCategories = asyncHandler(async (req: Request, res: Response) => {
  const categories = await Category.find().sort({ createdAt: -1 });
  successResponse(res, 200, 'Categories fetched successfully', categories);
});

export const updateCategory = asyncHandler(async (req: Request, res: Response) => {
  let category = await Category.findById(req.params.id);
  if (!category) {
    return errorResponse(res, 404, 'Category not found');
  }
  if (req.file) {
    req.body.image = req.file.path;
  }
  const oldName = category.name;
  category = await Category.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  // Products reference their category by name, so a rename has to follow them.
  if (category && category.name !== oldName) {
    await Product.updateMany({ category: oldName }, { $set: { category: category.name } });
  }
  successResponse(res, 200, 'Category updated successfully', category);
});

export const deleteCategory = asyncHandler(async (req: Request, res: Response) => {
  const category = await Category.findById(req.params.id);
  if (!category) {
    return errorResponse(res, 404, 'Category not found');
  }
  const inUse = await Product.countDocuments({ category: category.name });
  if (inUse > 0) {
    return errorResponse(res, 409, `${inUse} ${inUse === 1 ? 'piece still uses' : 'pieces still use'} this category. Move them first.`);
  }
  await category.deleteOne();
  successResponse(res, 200, 'Category deleted successfully', null);
});
