import { Request, Response } from 'express';
import { Product } from '../models/Product';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';

// Attach uploaded files to the product (imageFiles) and to each variant (variantImages_<index>)
const attachUploads = (req: Request) => {
  const files = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];

  // FormData flattens everything to strings, so the structured fields arrive
  // JSON-encoded and have to be revived before Mongoose sees them. `variants`
  // has always needed this; `specs` and `careIcons` are the PDP fields.
  for (const field of ['variants', 'specs', 'careIcons'] as const) {
    if (typeof req.body[field] === 'string') {
      try {
        req.body[field] = JSON.parse(req.body[field]);
      } catch {
        // Leave it as-is and let schema validation produce the error.
      }
    }
  }

  // Product-level images: existing URLs from body + newly uploaded imageFiles
  const productFileUrls = files.filter(f => f.fieldname === 'imageFiles').map(f => f.path);
  if (typeof req.body.images === 'string') {
    req.body.images = [req.body.images];
  }
  req.body.images = [...(req.body.images || []), ...productFileUrls];

  // Per-variant images: merge existing URLs (already in the parsed variant) with uploaded files
  if (Array.isArray(req.body.variants)) {
    req.body.variants = req.body.variants.map((variant: any, index: number) => {
      const variantFileUrls = files
        .filter(f => f.fieldname === `variantImages_${index}`)
        .map(f => f.path);
      const existing = Array.isArray(variant.images) ? variant.images : [];
      return { ...variant, images: [...existing, ...variantFileUrls] };
    });
  }
};

export const createProduct = asyncHandler(async (req: Request, res: Response) => {
  attachUploads(req);

  const product = await Product.create(req.body);
  successResponse(res, 201, 'Product created successfully', product);
});

export const getProducts = asyncHandler(async (req: Request, res: Response) => {
  const products = await Product.find().sort({ createdAt: -1 });
  successResponse(res, 200, 'Products fetched successfully', products);
});

export const updateProduct = asyncHandler(async (req: Request, res: Response) => {
  let product = await Product.findById(req.params.id);
  if (!product) {
    return errorResponse(res, 404, 'Product not found');
  }

  attachUploads(req);

  product = await Product.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  
  successResponse(res, 200, 'Product updated successfully', product);
});

export const deleteProduct = asyncHandler(async (req: Request, res: Response) => {
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) {
    return errorResponse(res, 404, 'Product not found');
  }
  successResponse(res, 200, 'Product deleted successfully', null);
});
