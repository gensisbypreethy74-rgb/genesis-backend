"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authController_1 = require("../controllers/authController");
const router = (0, express_1.Router)();
// Admin portal login (email + password)
router.post('/login', authController_1.loginAdmin);
// Customer authentication is Google-only
router.post('/google', authController_1.googleAuth);
router.post('/setup-test-admin', authController_1.createTestAdmin); // Can be called once to generate an admin
exports.default = router;
//# sourceMappingURL=authRoutes.js.map