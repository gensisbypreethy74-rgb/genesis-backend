import { Router } from 'express';
import { loginAdmin, googleAuth, logout } from '../controllers/authController';
import { protect } from '../middlewares/authMiddleware';
import { validate, schemas } from '../middlewares/validation';
import { authLimiter } from '../middlewares/rateLimiter';

const router = Router();

// Admin portal login (email + password)
router.post('/login', authLimiter, validate(schemas.login), loginAdmin);
// Customer authentication is Google-only
router.post('/google', authLimiter, validate(schemas.googleAuth), googleAuth);
router.post('/logout', protect, logout);
// NOTE: Admin accounts are provisioned out-of-band via the standalone
// `createAdmin.ts` seed script — there is no public admin-creation endpoint.

export default router;
