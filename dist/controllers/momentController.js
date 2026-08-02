"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateMoment = exports.getMoment = void 0;
const MomentSettings_1 = require("../models/MomentSettings");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
exports.getMoment = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    (0, responseHandler_1.successResponse)(res, 200, 'Moment fetched', await (0, MomentSettings_1.getOrCreateMomentSettings)());
});
exports.updateMoment = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const m = await (0, MomentSettings_1.getOrCreateMomentSettings)();
    const { eyebrow, title, body, shopLabel, shopHref, explainerEyebrow, steps } = req.body;
    if (eyebrow !== undefined)
        m.eyebrow = eyebrow;
    if (title !== undefined)
        m.title = title;
    if (body !== undefined)
        m.body = body;
    if (shopLabel !== undefined)
        m.shopLabel = shopLabel;
    if (shopHref !== undefined)
        m.shopHref = shopHref;
    if (explainerEyebrow !== undefined)
        m.explainerEyebrow = explainerEyebrow;
    if (Array.isArray(steps))
        m.steps = steps;
    if (req.body.seasonal && typeof req.body.seasonal === 'object') {
        const s = req.body.seasonal;
        if (s.eyebrow !== undefined)
            m.seasonal.eyebrow = s.eyebrow;
        if (s.heading !== undefined)
            m.seasonal.heading = s.heading;
        if (s.description !== undefined)
            m.seasonal.description = s.description;
        if (s.ctaLabel !== undefined)
            m.seasonal.ctaLabel = s.ctaLabel;
        if (s.ctaHref !== undefined)
            m.seasonal.ctaHref = s.ctaHref;
        // No `productIds`: which pieces are in The Moment is decided by filing them
        // under the "The Moment" category in the Products module, not by curating a
        // list here.
    }
    await m.save();
    (0, responseHandler_1.successResponse)(res, 200, 'Moment updated', m);
});
//# sourceMappingURL=momentController.js.map