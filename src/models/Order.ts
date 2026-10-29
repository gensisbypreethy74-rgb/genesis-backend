import mongoose, { Document, Schema } from 'mongoose';

export const ORDER_STATUSES = ['awaiting_payment', 'processing', 'shipped', 'delivered', 'cancelled'] as const;
export const PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'refund_due', 'refunded'] as const;

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
  },
  { timestamps: true }
);

OrderSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model<IOrder>('Order', OrderSchema);
