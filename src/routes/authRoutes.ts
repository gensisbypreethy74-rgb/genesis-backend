import { Router } from 'express';
import { loginAdmin, googleAuth } from '../controllers/authController';
import { validate, schemas } from '../middlewares/validation';

const router = Router();

// Admin portal login (email + password)
router.post('/login', validate(schemas.login), loginAdmin);
// Customer authentication is Google-only
router.post('/google', googleAuth);
// NOTE: Admin accounts are provisioned out-of-band via the standalone
// `createAdmin.ts` seed script — there is no public admin-creation endpoint.

export default router;
