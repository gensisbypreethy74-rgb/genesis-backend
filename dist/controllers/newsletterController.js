"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteSubscriber = exports.getSubscribers = exports.subscribe = void 0;
const Newsletter_1 = require("../models/Newsletter");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
// POST /newsletter/subscribe  (public)
exports.subscribe = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const source = req.body.source ? String(req.body.source).trim() : undefined;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'Please provide a valid email address.');
    }
    const existing = await Newsletter_1.Newsletter.findOne({ email });
    if (existing) {
        if (!existing.isActive) {
            existing.isActive = true;
            await existing.save();
        }
        // Idempotent: report success so the UI stays friendly.
        return (0, responseHandler_1.successResponse)(res, 200, 'You are already on the list.', { email });
    }
    await Newsletter_1.Newsletter.create({ email, source });
    return (0, responseHandler_1.successResponse)(res, 201, 'Subscribed successfully.', { email });
});
// GET /newsletter/admin  (admin)
exports.getSubscribers = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const subscribers = await Newsletter_1.Newsletter.find().sort({ createdAt: -1 });
    return (0, responseHandler_1.successResponse)(res, 200, 'Subscribers fetched successfully', subscribers);
});
// DELETE /newsletter/admin/:id  (admin)
exports.deleteSubscriber = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const sub = await Newsletter_1.Newsletter.findByIdAndDelete(req.params.id);
    if (!sub) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Subscriber not found');
    }
    return (0, responseHandler_1.successResponse)(res, 200, 'Subscriber removed successfully', { id: req.params.id });
});
//# sourceMappingURL=newsletterController.js.map