import express from 'express';
import { getMoment, updateMoment } from '../controllers/momentController';
import { protect, authorize } from '../middlewares/authMiddleware';

const router = express.Router();
router.get('/', getMoment);
router.put('/', protect, authorize('admin', 'superadmin'), updateMoment);
export default router;
