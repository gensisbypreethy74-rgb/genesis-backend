import { Router } from 'express';
import { loginAdmin, createTestAdmin, googleAuth } from '../controllers/authController';

const router = Router();

// Admin portal login (email + password)
router.post('/login', loginAdmin);
// Customer authentication is Google-only
router.post('/google', googleAuth);
router.post('/setup-test-admin', createTestAdmin); // Can be called once to generate an admin

export default router;
