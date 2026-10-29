import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    return {
      folder: 'heedy_products',
      allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
      public_id: `${file.fieldname}-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
    };
  },
});

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export const upload = multer({
  storage: storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 60 }, // 15MB per file (the admin checks the same)
  // Reject non-images before anything is sent to Cloudinary.
  fileFilter: (_req, file, cb) => {
    if (IMAGE_TYPES.includes(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('Images must be JPG, PNG or WebP.'), { statusCode: 400 }));
  },
});

/** Product form: up to 10 piece photos plus up to 10 per size (sizes 0–19). */
export const productUpload = upload.fields([
  { name: 'imageFiles', maxCount: 10 },
  ...Array.from({ length: 20 }, (_, i) => ({ name: `variantImages_${i}`, maxCount: 10 })),
]);
