import express from 'express';
import { subscribe, getSubscribers, deleteSubscriber, unsubscribePage, unsubscribe } from '../controllers/newsletterController';
import { protect, authorize } from '../middlewares/authMiddleware';
import { validate, schemas } from '../middlewares/validation';
import { newsletterLimiter } from '../middlewares/rateLimiter';

const router = express.Router();

// Public — subscribe to "Notes from the Studio"
router.post('/subscribe', newsletterLimiter, validate(schemas.subscribe), subscribe);

// Public — the link in every confirmation email. GET only shows a confirm
// button (mail scanners prefetch links); the POST does the unsubscribe.
router.get('/unsubscribe', unsubscribePage);
router.post('/unsubscribe', newsletterLimiter, express.urlencoded({ extended: false }), unsubscribe);

// Admin — manage subscribers
router.get('/admin', protect, authorize('admin', 'superadmin'), getSubscribers);
router.delete('/admin/:id', protect, authorize('admin', 'superadmin'), validate(schemas.mongoId), deleteSubscriber);

export default router;
