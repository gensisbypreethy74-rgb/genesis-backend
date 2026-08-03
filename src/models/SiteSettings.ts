import mongoose, { Document, Schema } from 'mongoose';

/**
 * Site-wide settings — one singleton document.
 *
 * Anything that was previously hardcoded in the frontend but needs to be
 * admin-editable lives here. The WhatsApp number is the first; add fields
 * as the studio asks for them.
 */
export interface ISiteSettings extends Document {
  /** Digits only, country code first — the form wa.me expects (e.g. "917736830303"). */
  whatsappNumber: string;
}

const DEFAULTS = {
  whatsappNumber: '917736830303',
};

const siteSettingsSchema = new Schema<ISiteSettings>(
  {
    whatsappNumber: { type: String, default: DEFAULTS.whatsappNumber, trim: true },
  },
  { timestamps: true }
);

export const SiteSettings = mongoose.model<ISiteSettings>('SiteSettings', siteSettingsSchema);

export async function getOrCreateSiteSettings() {
  return (await SiteSettings.findOne()) || (await SiteSettings.create({}));
}
