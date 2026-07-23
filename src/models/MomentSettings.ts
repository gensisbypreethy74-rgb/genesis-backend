import mongoose, { Document, Schema } from 'mongoose';

/** Editable "The Moment" home section — one singleton document. */
export interface IMomentStep {
  number: string;
  title: string;
  description: string;
}

export interface IMomentSettings extends Document {
  eyebrow: string;
  title: string;
  body: string; // blank line = new paragraph
  shopLabel: string;
  shopHref: string; // Shop button → an all-products page with filters
  explainerEyebrow: string;
  steps: IMomentStep[];
}

const stepSchema = new Schema<IMomentStep>(
  { number: String, title: String, description: String },
  { _id: false }
);

const DEFAULTS = {
  eyebrow: 'The Moment · A Considered Cadence',
  title: 'The Moment is here.',
  body:
    'A small, named run — pieces drawn for Onam, live now. It closes on its own time, not when stock runs low.\n\nNothing here is discounted, and nothing is rushed. When this window closes, the pieces move — unchanged — into the Archive, and rest there, fully available to buy.',
  shopLabel: 'Shop the Onam Collection',
  shopHref: '/products?collection=onam',
  explainerEyebrow: 'HOW A GENESIS MOMENT WORKS',
  steps: [
    { number: '01', title: 'IT OPENS, NAMED', description: 'A small, named run — a handful of pieces drawn around one idea. Never a full wardrobe.' },
    { number: '02', title: 'IT CLOSES, QUIETLY', description: "When it's time, the Moment closes. No sale, no clearance, no urgency manufactured to move stock." },
    { number: '03', title: 'IT BECOMES ARCHIVE', description: 'Each piece moves into the Archive — same page, same photography, re-tagged — and remains available to buy.' },
  ],
};

const momentSettingsSchema = new Schema<IMomentSettings>(
  {
    eyebrow: { type: String, default: DEFAULTS.eyebrow },
    title: { type: String, default: DEFAULTS.title },
    body: { type: String, default: DEFAULTS.body },
    shopLabel: { type: String, default: DEFAULTS.shopLabel },
    shopHref: { type: String, default: DEFAULTS.shopHref },
    explainerEyebrow: { type: String, default: DEFAULTS.explainerEyebrow },
    steps: { type: [stepSchema], default: DEFAULTS.steps },
  },
  { timestamps: true }
);

export const MomentSettings = mongoose.model<IMomentSettings>('MomentSettings', momentSettingsSchema);

export async function getOrCreateMomentSettings() {
  return (await MomentSettings.findOne()) || (await MomentSettings.create({}));
}
