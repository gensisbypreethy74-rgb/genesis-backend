"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateSiteSettings = exports.getSiteSettings = void 0;
const SiteSettings_1 = require("../models/SiteSettings");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
exports.getSiteSettings = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    (0, responseHandler_1.successResponse)(res, 200, 'Site settings fetched', await (0, SiteSettings_1.getOrCreateSiteSettings)());
});
exports.updateSiteSettings = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const settings = await (0, SiteSettings_1.getOrCreateSiteSettings)();
    const { whatsappNumber } = req.body;
    if (whatsappNumber !== undefined) {
        // Strip anything that isn't a digit — the admin might paste "+91 77368 30303".
        settings.whatsappNumber = whatsappNumber.replace(/\D/g, '');
    }
    await settings.save();
    (0, responseHandler_1.successResponse)(res, 200, 'Site settings updated', settings);
});
//# sourceMappingURL=siteSettingsController.js.map