import { ENV } from '../config/env';
import { IOrder } from '../models/Order';

export const BRAND_NAME = 'Genesis by Preethy';

export const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const money = (n: number) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const formatDate = (d: Date | string | undefined) =>
  new Date(d || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' });

interface OrderEmailOptions {
  order: IOrder;
  customerName?: string;
  heading: string;
  message: string;
  status?: { label: string; color: string };
  ctaLabel: string;
}

/**
 * The one order email layout (confirmation and every status update). All
 * customer- and catalogue-supplied text is escaped. The button links to the
 * profile page without a login token: the customer signs in as usual.
 */
export function renderOrderEmail({ order, customerName, heading, message, status, ctaLabel }: OrderEmailOptions) {
  const itemsHtml = order.items.map((item: any) => {
    const name = item.name || item.product?.name || 'Piece';
    const detail = [item.size && `Size ${escapeHtml(item.size)}`, `Qty ${item.quantity}`].filter(Boolean).join(' · ');
    return `
      <tr>
        <td style="padding: 15px 10px; border-bottom: 1px solid #eaeaea;">
          <p style="margin: 0; font-weight: bold; color: #111827; font-size: 15px;">${escapeHtml(name)}</p>
          <p style="margin: 5px 0 0; color: #6b7280; font-size: 13px;">${detail}</p>
        </td>
        <td style="padding: 15px 0; border-bottom: 1px solid #eaeaea; text-align: right;">
          <p style="margin: 0; font-weight: bold; color: #111827; font-size: 15px;">${money(item.price * item.quantity)}</p>
        </td>
      </tr>`;
  }).join('');

  const codLine = order.paymentMethod === 'cod'
    ? `<p style="margin: 10px 0 0 0; color: #374151; font-size: 15px;"><strong>Payment:</strong> Cash on Delivery</p>
       <p style="margin: 6px 0 0 0; color: #374151; font-size: 14px;">Advance paid: <span style="color: #10b981; font-weight: bold;">${money(order.advanceAmount)}</span> &nbsp;·&nbsp; Balance due on delivery: <span style="color: #111827; font-weight: bold;">${money(order.balanceAmount)}</span></p>`
    : '';

  const statusBlock = status
    ? `<p style="margin: 10px 0 0 0; color: #374151; font-size: 15px;">Current Status:</p>
       <div style="display: inline-block; background-color: ${status.color}15; color: ${status.color}; padding: 8px 16px; border-radius: 20px; font-weight: bold; font-size: 16px; text-transform: uppercase; margin-top: 10px; border: 1px solid ${status.color}40;">${escapeHtml(status.label)}</div>`
    : '';

  return `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 10px; overflow: hidden; background-color: #ffffff;">
      <div style="background-color: #111827; padding: 30px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 24px; letter-spacing: 6px; text-transform: uppercase;">Genesis</h1>
        <p style="color: #d1d5db; margin: 6px 0 0; font-size: 10px; letter-spacing: 4px; text-transform: uppercase;">by Preethy</p>
      </div>
      <div style="padding: 40px 30px;">
        <h2 style="color: #111827; font-size: 20px; margin-top: 0; margin-bottom: 20px;">${escapeHtml(heading)}</h2>
        <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
          Dear <strong>${escapeHtml(customerName || 'Customer')}</strong>,<br><br>
          ${escapeHtml(message)}
        </p>
        <div style="background-color: #f9fafb; border: 1px solid #f3f4f6; border-radius: 8px; padding: 20px; margin-bottom: 30px; text-align: center;">
          <p style="margin: 0 0 10px 0; color: #374151; font-size: 15px;"><strong>Order ID:</strong> <span style="color: #111827;">${order._id}</span></p>
          <p style="margin: 0; color: #374151; font-size: 15px;"><strong>Order Date:</strong> <span style="color: #111827;">${formatDate(order.createdAt)}</span></p>
          ${codLine}
          ${statusBlock}
        </div>

        <h3 style="color: #111827; font-size: 18px; margin-bottom: 15px; border-bottom: 2px solid #f3f4f6; padding-bottom: 10px;">Order Details</h3>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
          <tbody>${itemsHtml}</tbody>
        </table>

        <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding-bottom: 10px; color: #6b7280; font-size: 14px;">Subtotal:</td>
              <td style="padding-bottom: 10px; color: #111827; font-weight: bold; font-size: 14px; text-align: right;">${money(order.subtotal)}</td>
            </tr>
            ${order.discount > 0 ? `
            <tr>
              <td style="padding-bottom: 10px; color: #6b7280; font-size: 14px;">Discount:</td>
              <td style="padding-bottom: 10px; color: #10b981; font-weight: bold; font-size: 14px; text-align: right;">-${money(order.discount)}</td>
            </tr>` : ''}
            <tr>
              <td style="padding-bottom: 15px; color: #6b7280; font-size: 14px;">Shipping:</td>
              <td style="padding-bottom: 15px; color: #111827; font-weight: bold; font-size: 14px; text-align: right;">${order.shippingFee > 0 ? money(order.shippingFee) : 'Free'}</td>
            </tr>
            <tr>
              <td style="padding-top: 15px; border-top: 1px solid #eaeaea; color: #111827; font-weight: bold; font-size: 16px;">Total:</td>
              <td style="padding-top: 15px; border-top: 1px solid #eaeaea; color: #111827; font-weight: bold; font-size: 18px; text-align: right;">${money(order.total)}</td>
            </tr>
          </table>
        </div>

        <p style="color: #4b5563; font-size: 15px; line-height: 1.6; margin-bottom: 30px;">
          Thank you for shopping with ${BRAND_NAME}. If you have any questions, feel free to reply to this email.
        </p>
        <div style="text-align: center;">
          <a href="${ENV.FRONTEND_URL}/profile" style="background-color: #111827; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; font-size: 14px; display: inline-block;">${escapeHtml(ctaLabel)}</a>
        </div>
      </div>
      <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #eaeaea;">
        <p style="color: #9ca3af; font-size: 13px; margin: 0;">© ${new Date().getFullYear()} ${BRAND_NAME}. All rights reserved.</p>
      </div>
    </div>`;
}
