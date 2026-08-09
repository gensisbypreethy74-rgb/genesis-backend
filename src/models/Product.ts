import mongoose, { Document, Schema } from 'mongoose';

interface IVariant {
  /**
   * The size label (M / L / XL). Named `volume` from the cosmetics-era schema
   * it grew out of; kept as-is because carts and historical orders reference
   * it, and renaming would break them. The UI labels it "Size".
   */
  volume: string;
  price: number;
  oldPrice?: number;
  color?: string;
  images: string[];
}

/** One row of the Material & Fit spec table, e.g. { label: 'Shoulder', value: '15 in' }. */
export interface ISpec {
  label: string;
  value: string;
}

/**
 * One row of the per-product size chart, e.g. { size: 'M', bust: 94, waist: 76 }.
 *
 * Measurements are stored in CENTIMETRES and nothing else. The storefront
 * derives inches at render time (1 in = 2.54 cm), so there is exactly one set
 * of numbers to keep correct — a stored inch column would be a second copy of
 * the same fact, free to drift the moment someone edits one and not the other.
 * Every measurement is optional: the storefront drops a column no row fills.
 */
export interface ISizeChartGroup {
  title: string;              // editable heading, e.g. "Top & Dresses" / "Bottom"
  fields?: string[];          // which measurement columns this chart shows
  rows: ISizeChartRow[];
}

export interface ISizeChartRow {
  size: string;
  bust?: number;
  waist?: number;
  hip?: number;
  inseam?: number;
  length?: number;
}

/**
 * Care symbols the product detail page can render. A closed vocabulary rather
 * than free text so the storefront can map each to an icon, and so the admin
 * offers a checklist instead of inviting typos.
 */
export const CARE_ICONS = [
  'hand-wash',
  'machine-wash',
  'dont-bleach',
  'iron-low',
  'iron-medium',
  'dont-iron',
  'dry-in-shade',
  'dry-flat',
  'dont-tumble-dry',
  'dry-clean',
] as const;

export type CareIcon = (typeof CARE_ICONS)[number];

export interface IProduct extends Document {
  name: string;
  category: string;
  description?: string;
  variants: IVariant[];
  starRating: number;
  reviewsCount: number;
  offerText?: string;
  keyFeatures?: string;
  images: string[];
  status: string;
  showOnLandingPage: boolean;
  // Editorial merchandising fields (Genesis by Preethy)
  garmentType?: string;    // e.g. "Lace-Trim Kurta Set" — shown under the product name
  collectionName?: string; // e.g. "Onam" — groups a seasonal drop (`collection` is reserved by Mongoose)
  season?: string;         // e.g. "Onam 2026"
  lifeMode?: string;       // "Ambition" | "Occasion" | "Casual/Out" | "At-Home Identity"
  editSection?: string;    // which THE EDIT page: "Within" | "Beyond" | "Genesis Men" | "Archive"
  limited?: boolean;       // renders the "LIMITED PIECE" tag on the card
  /**
   * Fabrics this piece is made of, e.g. ['Cotton', 'Linen']. Free text rather
   * than an enum: the storefront's Material filter is built from whatever is
   * actually on the products, so a new fabric needs no code change. The filter
   * groups case-insensitively, so 'cotton' and 'Cotton' land in one option.
   */
  materials?: string[];

  // ── Product detail page ──────────────────────────────────────────────────
  // Everything below drives the storefront PDP. Each is optional: the page
  // omits the section rather than rendering an empty heading, so a
  // half-described piece still reads as finished.
  tagline?: string;         // italic serif line, e.g. "The piece she reaches for…"
  fitNote?: string;         // "Relaxed through the body. True to size."
  modelNote?: string;       // "Model is 168cm and wears size M."
  studioNotes?: string;     // the paragraph under STUDIO NOTES
  materialText?: string;    // opening line of MATERIAL & FIT
  specs?: ISpec[];          // the label/value table under materialText
  sizeChart?: ISizeChartRow[]; // legacy single chart (kept for older pieces)
  sizeCharts?: ISizeChartGroup[]; // named charts, e.g. "Top & Dresses", "Bottom"
  fitFooter?: string;       // "Unlined. Non-stretch. Side-seam pockets."
  careIcons?: CareIcon[];   // symbols rendered above careText
  careText?: string;        // the CARE paragraph
  shippingReturns?: string; // per-piece override; blank falls back to the site default
}

const specSchema = new Schema<ISpec>(
  {
    label: { type: String, required: true, trim: true },
    value: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const sizeChartRowSchema = new Schema<ISizeChartRow>(
  {
    size: { type: String, required: true, trim: true },
    // Centimetres. `min: 0` only rejects nonsense; a blank cell stays undefined
    // so the storefront can drop the whole column.
    bust: { type: Number, min: 0 },
    waist: { type: Number, min: 0 },
    hip: { type: Number, min: 0 },
    inseam: { type: Number, min: 0 },
    length: { type: Number, min: 0 },
  },
  { _id: false }
);

const sizeChartGroupSchema = new Schema<ISizeChartGroup>(
  {
    title: { type: String, required: true, trim: true },
    fields: { type: [String], default: undefined },
    rows: { type: [sizeChartRowSchema], default: [] },
  },
  { _id: false }
);

const variantSchema = new Schema<IVariant>({
  volume: { type: String, required: true },
  price: { type: Number, required: true },
  oldPrice: { type: Number },
  color: { type: String },
  images: [{ type: String }],
});

const productSchema = new Schema<IProduct>(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true },
    // Optional since the studio stopped collecting it: the form has no
    // description field, so a required one would reject every new product.
    // Existing values are left in place and still feed storefront search.
    description: { type: String },
    variants: [variantSchema],
    starRating: { type: Number, default: 0, min: 0, max: 5 },
    reviewsCount: { type: Number, default: 0 },
    offerText: { type: String },
    keyFeatures: { type: String },
    images: [{ type: String }],
    status: { type: String, default: 'In Stock' },
    showOnLandingPage: { type: Boolean, default: false },
    garmentType: { type: String, trim: true },
    collectionName: { type: String, trim: true },
    season: { type: String, trim: true },
    lifeMode: { type: String, trim: true },
    editSection: {
      type: String,
      trim: true,
      enum: ['Within', 'Beyond', 'Genesis Men', 'Archive', ''],
      default: '',
    },
    limited: { type: Boolean, default: false },
    materials: { type: [String], default: undefined },

    // Product detail page
    tagline: { type: String, trim: true },
    fitNote: { type: String, trim: true },
    modelNote: { type: String, trim: true },
    studioNotes: { type: String, trim: true },
    materialText: { type: String, trim: true },
    specs: { type: [specSchema], default: undefined },
    sizeChart: { type: [sizeChartRowSchema], default: undefined },
    sizeCharts: { type: [sizeChartGroupSchema], default: undefined },
    fitFooter: { type: String, trim: true },
    careIcons: { type: [{ type: String, enum: CARE_ICONS }], default: undefined },
    careText: { type: String, trim: true },
    shippingReturns: { type: String, trim: true },
  },
  { timestamps: true }
);

export const Product = mongoose.model<IProduct>('Product', productSchema);
