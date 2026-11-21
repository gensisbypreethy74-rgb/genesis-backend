import mongoose, { Document, Schema } from 'mongoose';

export const ORDER_STATUSES = ['awaiting_payment', 'processing', 'shipped', 'delivered', 'cancelled'] as const;
export const PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'refund_due', 'refunded'] as const;
/** Whether we have sent the confirmation email (see utils/orderConfirmation). */
export const CONFIRMATION_EMAIL_STATUSES = ['pending', 'sent', 'failed'] as const;
/** What Resend later reports about that email reaching the inbox. */
export const EMAIL_DELIVERY_STATUSES = ['delivered', 'delivery_delayed', 'bounced', 'complained', 'failed'] as const;

export interface IConfirmationEmail {
  status: (typeof CONFIRMATION_EMAIL_STATUSES)[number];
  /** Address the latest attempt went to. */
  to?: string;
  attempts: number;
  /** Earliest time the retry worker may try again. */
  nextAttemptAt?: Date;
  /** Claim held by the attempt in flight, so no two send at once. */
  lockedUntil?: Date;
  resendId?: string;
  sentAt?: Date;
  lastError?: string;
  delivery?: { status: (typeof EMAIL_DELIVERY_STATUSES)[number]; at: Date };
}

export interface IOrderItem {
  product: mongoose.Types.ObjectId;
  // Snapshots taken at purchase, so history survives product edits/deletes.
  name?: string;
  image?: string;
  quantity: number;
  price: number;
  size?: string;
}

export interface IOrder extends Document {
  user: mongoose.Types.ObjectId;
  items: IOrderItem[];
  shippingAddress: {
    street?: string;
    apartment?: string;
    landmark?: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  subtotal: number;
  discount: number;
  shippingFee: number;
  total: number;
  paymentMethod: string;
  advanceAmount: number;
  balanceAmount: number;
  paymentStatus: (typeof PAYMENT_STATUSES)[number];
  /**
   * `awaiting_payment`: created at checkout with server-computed prices, not
   * yet paid. Only the verify call or the Razorpay webhook moves it on, and no
   * customer/admin list shows it.
   */
  orderStatus: (typeof ORDER_STATUSES)[number];
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  paidAt?: Date;
  /** Paid, but a size ran out between checkout and payment. The studio must follow up. */
  stockShortfall?: boolean;
  /** Absent on orders paid before confirmation tracking existed. */
  confirmationEmail?: IConfirmationEmail;
  createdAt: Date;
  updatedAt: Date;
}

const OrderSchema: Schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    items: [
      {
        product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
        name: { type: String },
        image: { type: String },
        quantity: { type: Number, required: true },
        price: { type: Number, required: true },
        size: { type: String },
      },
    ],
    shippingAddress: {
      street: { type: String },
      apartment: { type: String },
      landmark: { type: String },
      city: { type: String, required: true },
      state: { type: String, required: true },
      zipCode: { type: String, required: true },
      country: { type: String, required: true },
    },
    subtotal: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    shippingFee: { type: Number, default: 0 },
    total: { type: Number, required: true },
    paymentMethod: { type: String, required: true },
    // For COD orders: advanceAmount is paid online now, balanceAmount is collected on delivery.
    advanceAmount: { type: Number, default: 0 },
    balanceAmount: { type: Number, default: 0 },
    paymentStatus: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: 'pending',
    },
    orderStatus: {
      type: String,
      enum: ORDER_STATUSES,
      default: 'processing',
    },
    razorpayOrderId: { type: String, index: true },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },
    paidAt: { type: Date },
    stockShortfall: { type: Boolean },
    // Queued in the same write that marks the order paid, so a crash can't
    // lose it. `status` is whether we sent it; `delivery` is what Resend later
    // reports. Left out of API responses unless asked for (`+confirmationEmail`).
    confirmationEmail: {
      type: new Schema(
        {
          status: { type: String, enum: CONFIRMATION_EMAIL_STATUSES, required: true },
          to: { type: String },
          attempts: { type: Number, default: 0 },
          nextAttemptAt: { type: Date },
          lockedUntil: { type: Date },
          resendId: { type: String },
          sentAt: { type: Date },
          lastError: { type: String },
          delivery: {
            status: { type: String, enum: EMAIL_DELIVERY_STATUSES },
            at: { type: Date },
          },
        },
        { _id: false }
      ),
      select: false,
    },
  },
  { timestamps: true }
);

OrderSchema.index({ user: 1, createdAt: -1 });
// The retry worker's queue: only pending confirmations are indexed.
OrderSchema.index(
  { 'confirmationEmail.nextAttemptAt': 1 },
  { partialFilterExpression: { 'confirmationEmail.status': 'pending' } }
);
// Resend's delivery webhooks look the order up by the email id.
OrderSchema.index({ 'confirmationEmail.resendId': 1 }, { sparse: true });

export default mongoose.model<IOrder>('Order', OrderSchema);
