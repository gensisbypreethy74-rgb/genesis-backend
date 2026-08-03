"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MomentSettings = void 0;
exports.getOrCreateMomentSettings = getOrCreateMomentSettings;
const mongoose_1 = __importStar(require("mongoose"));
const stepSchema = new mongoose_1.Schema({ number: String, title: String, description: String }, { _id: false });
const DEFAULTS = {
    eyebrow: 'The Moment · A Considered Cadence',
    title: 'The Moment is here.',
    body: 'A small, named run — pieces drawn for Onam, live now. It closes on its own time, not when stock runs low.\n\nNothing here is discounted, and nothing is rushed. When this window closes, the pieces move — unchanged — into the Archive, and rest there, fully available to buy.',
    shopLabel: 'Shop the Onam Collection',
    shopHref: '/collections/onam',
    explainerEyebrow: 'HOW A GENESIS MOMENT WORKS',
    steps: [
        { number: '01', title: 'IT OPENS, NAMED', description: 'A small, named run — a handful of pieces drawn around one idea. Never a full wardrobe.' },
        { number: '02', title: 'IT CLOSES, QUIETLY', description: "When it's time, the Moment closes. No sale, no clearance, no urgency manufactured to move stock." },
        { number: '03', title: 'IT BECOMES ARCHIVE', description: 'Each piece moves into the Archive — same page, same photography, re-tagged — and remains available to buy.' },
    ],
    seasonal: {
        eyebrow: 'Now · The Onam Collection',
        heading: 'Named for the flowers of the season.',
        description: '',
        ctaLabel: 'View All Pieces',
        ctaHref: '/products?category=the-moment',
    },
};
const momentSettingsSchema = new mongoose_1.Schema({
    eyebrow: { type: String, default: DEFAULTS.eyebrow },
    title: { type: String, default: DEFAULTS.title },
    body: { type: String, default: DEFAULTS.body },
    shopLabel: { type: String, default: DEFAULTS.shopLabel },
    shopHref: { type: String, default: DEFAULTS.shopHref },
    explainerEyebrow: { type: String, default: DEFAULTS.explainerEyebrow },
    steps: { type: [stepSchema], default: DEFAULTS.steps },
    seasonal: {
        eyebrow: { type: String, default: DEFAULTS.seasonal.eyebrow },
        heading: { type: String, default: DEFAULTS.seasonal.heading },
        description: { type: String, default: DEFAULTS.seasonal.description },
        ctaLabel: { type: String, default: DEFAULTS.seasonal.ctaLabel },
        ctaHref: { type: String, default: DEFAULTS.seasonal.ctaHref },
    },
}, { timestamps: true });
exports.MomentSettings = mongoose_1.default.model('MomentSettings', momentSettingsSchema);
async function getOrCreateMomentSettings() {
    return (await exports.MomentSettings.findOne()) || (await exports.MomentSettings.create({}));
}
//# sourceMappingURL=MomentSettings.js.map