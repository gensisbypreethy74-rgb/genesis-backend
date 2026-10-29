import express from 'express';
import { getSiteSettings, updateSiteSettings } from '../controllers/siteSettingsController';
import { protect, authorize } from '../middlewares/authMiddleware';
import { validate, schemas } from '../middlewares/validation';

const router = express.Router();
router.get('/', getSiteSettings);
router.put('/', protect, authorize('admin', 'superadmin'), validate(schemas.siteSettings), updateSiteSettings);
export default router;
