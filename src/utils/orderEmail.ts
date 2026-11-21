import { ENV, isPublicSiteUrl } from '../config/env';
import { PRODUCTION_ORIGINS } from '../config/cors';
import { IOrder } from '../models/Order';
import logger from './logger';

export const BRAND_NAME = 'Genesis by Preethy';

export const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const money = (n: number) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const formatDate = (d: Date | string | undefined) =>
  new Date(d || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' });

// ── Where email links point ────────────────────────────────────────────────

let warnedFallback = false;

/**
 * The live storefront every email link (and the logo) is built on.
 *
 * FRONTEND_URL when it is a public https address — on Render it is the live
 * site, and production refuses to start otherwise (config/env). Anything else,
 * such as localhost in a developer's .env, falls back to the live domain: these
 * emails go to real customers, whose mail apps can't open a developer's machine
 * (and Gmail's image proxy can't fetch the logo from one).
 */
export function siteUrl(): string {
  if (isPublicSiteUrl(ENV.FRONTEND_URL)) return new URL(ENV.FRONTEND_URL).origin;
  if (!warnedFallback) {
    warnedFallback = true;
    logger.warn(`FRONTEND_URL (${ENV.FRONTEND_URL}) is not a public https site; email links use ${PRODUCTION_ORIGINS[0]}`);
  }
  return PRODUCTION_ORIGINS[0];
}

/** Every link an order email carries, all on the live storefront. */
export function orderLinks(orderId: string) {
  const site = siteUrl();
  const id = encodeURIComponent(orderId);
  return {
    home: site,
    logo: `${site}/images/logo-wordmark.png`,
    // The profile opens this order; a signed-out customer signs in first and
    // is brought straight back to it.
    viewOrder: `${site}/profile?tab=orders&order=${id}`,
    // The tracking form, with the order ID already filled in.
    trackOrder: `${site}/track-order?orderId=${id}`,
    shop: `${site}/products`,
    support: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Order #${orderId.slice(-8).toUpperCase()}`)}`,
  };
}

// ── Order confirmation ──────────────────────────────────────────────────────
// Kept in step with what the storefront publishes: the care address
// (lib/contact.ts), the registered company details (footer) and the delivery
// windows (Shipping Information page).
export const SUPPORT_EMAIL = 'care@genesisbypreethy.com';
const LEGAL_LINE = 'Genesis by Preethy Private Limited · Vallikkad House, Ayswarya, Azad Road, Kaloor, Ernakulam, Kerala 682017, India';
const DELIVERY_ESTIMATE =
  'In-stock pieces are dispatched within one to two working days. From dispatch, delivery takes two to four working days to Kerala and metro cities, and four to seven working days elsewhere in India.';

// The palette the newsletter email already uses: ivory, ink and bronze.
const C = { page: '#f5f0e8', card: '#faf6ef', panel: '#f1e9dc', line: '#ddd3c2', ink: '#1c1a15', muted: '#6f675a', faint: '#9a9284', bronze: '#83653a' };
const SERIF = "Georgia,'Times New Roman',serif";
const SANS = 'Helvetica,Arial,sans-serif';

const placedOn = (order: IOrder) =>
  `${new Date(order.paidAt || order.createdAt).toLocaleString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  })} IST`;

const paymentMethodLabel = (order: IOrder) =>
  order.paymentMethod === 'cod' ? 'Cash on Delivery (advance paid online)' : 'Paid online · Razorpay';

const paymentStatusLabel = (order: IOrder) => {
  if (order.paymentStatus === 'completed') return 'Paid in full';
  if (order.paymentMethod === 'cod' && order.paymentStatus === 'pending') {
    return `Advance of ${money(order.advanceAmount)} paid · ${money(order.balanceAmount)} due on delivery`;
  }
  const s = order.paymentStatus.replace('_', ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** "917736830303" → "+91 77368 30303". */
const formatWhatsApp = (digits: string) =>
  /^91\d{10}$/.test(digits) ? `+91 ${digits.slice(2, 7)} ${digits.slice(7)}` : `+${digits}`;

/** A small JPEG rendition: Outlook can't show WebP, so no f_auto here. Non-https refs are skipped. */
const thumbUrl = (url?: string) => {
  if (!url || !url.startsWith('https://')) return '';
  return url.includes('res.cloudinary.com') && url.includes('/upload/')
    ? url.replace('/upload/', '/upload/f_jpg,q_auto,w_128,h_160,c_fill/')
    : url;
};

const label = (text: string) =>
  `<p style="margin:0 0 6px;font-family:${SANS};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${C.faint};">${text}</p>`;

const totalRow = (name: string, value: string, strong = false) => `
  <tr>
    <td style="padding:5px 0;font-family:${SANS};font-size:${strong ? 16 : 14}px;color:${strong ? C.ink : C.muted};${strong ? 'font-weight:bold;' : ''}">${name}</td>
    <td align="right" style="padding:5px 0;font-family:${SANS};font-size:${strong ? 18 : 14}px;color:${C.ink};${strong ? 'font-weight:bold;' : ''}">${value}</td>
  </tr>`;

export interface ConfirmationEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * The order confirmation, as HTML and plain text. Table layout with inline
 * styles so Gmail and Outlook render it, with one media query to stack the
 * columns on phones. Everything from the customer or the catalogue is escaped.
 *
 * Depends only on the order and the studio's settings, so a retry renders the
 * same email — Resend's idempotency key requires an identical request.
 */
export function renderOrderConfirmationEmail(
  order: IOrder,
  { customerName, whatsappNumber }: { customerName?: string; whatsappNumber?: string }
): ConfirmationEmail {
  const id = order._id.toString();
  const ref = id.slice(-8).toUpperCase();
  const name = customerName?.trim() || 'there';
  const links = orderLinks(id);
  const isCod = order.paymentMethod === 'cod';
  const whatsapp = whatsappNumber?.replace(/\D/g, '') || '';
  const intro = isCod
    ? 'Thank you for your order. We have received your advance payment, and our studio is now preparing your pieces.'
    : 'Thank you for your order. We have received your payment, and our studio is now preparing your pieces.';
  const a = order.shippingAddress;
  const addressLines = [name === 'there' ? '' : name, a.street, a.apartment, a.landmark, `${a.city}, ${a.state} ${a.zipCode}`, a.country]
    .map((l) => l?.trim())
    .filter(Boolean) as string[];
  const items = order.items.map((item: any) => ({
    name: item.name || item.product?.name || 'Piece',
    size: item.size as string | undefined,
    quantity: item.quantity as number,
    price: item.price as number,
    image: thumbUrl(item.image),
  }));

  const itemRows = items
    .map((item) => {
      const detail = [item.size && `Size ${escapeHtml(item.size)}`, `Qty ${item.quantity}`, item.quantity > 1 && `${money(item.price)} each`]
        .filter(Boolean)
        .join(' &middot; ');
      const image = item.image
        ? `<img src="${escapeHtml(item.image)}" width="64" height="80" alt="" style="display:block;width:64px;height:80px;border:0;object-fit:cover;background:${C.panel};">`
        : `<div style="width:64px;height:80px;background:${C.panel};"></div>`;
      return `
        <tr>
          <td class="thumb" width="64" valign="top" style="padding:14px 16px 14px 0;border-bottom:1px solid ${C.line};">${image}</td>
          <td valign="top" style="padding:14px 0;border-bottom:1px solid ${C.line};">
            <p style="margin:0;font-family:${SERIF};font-size:17px;line-height:1.3;color:${C.ink};">${escapeHtml(item.name)}</p>
            <p style="margin:6px 0 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${C.muted};">${detail}</p>
          </td>
          <td valign="top" align="right" style="padding:14px 0 14px 12px;border-bottom:1px solid ${C.line};font-family:${SANS};font-size:15px;color:${C.ink};white-space:nowrap;">${money(item.price * item.quantity)}</td>
        </tr>`;
    })
    .join('');

  const totals = [
    totalRow('Subtotal', money(order.subtotal)),
    order.discount > 0 ? totalRow('Discount', `&minus;${money(order.discount)}`) : '',
    totalRow('Shipping', order.shippingFee > 0 ? money(order.shippingFee) : 'Complimentary'),
    totalRow('Total', money(order.total), true),
    isCod ? totalRow('Paid now (advance)', money(order.advanceAmount)) : '',
    isCod ? totalRow('Due on delivery', money(order.balanceAmount)) : '',
  ].join('');

  const shortfall = order.stockShortfall
    ? `<tr><td class="px" style="padding:0 40px 24px;">
         <p style="margin:0;padding:14px 16px;background:${C.panel};border-left:2px solid ${C.bronze};font-family:${SANS};font-size:14px;line-height:1.6;color:${C.ink};">
           One of your pieces sold out moments before your payment went through. Our studio will be in touch shortly to arrange an alternative or a refund.
         </p>
       </td></tr>`
    : '';

  const support = `Need help with your order? Reply to this email or write to <a href="${escapeHtml(links.support)}" style="color:${C.bronze};">${SUPPORT_EMAIL}</a>${
    whatsapp ? `, or message us on WhatsApp at <a href="https://wa.me/${whatsapp}" style="color:${C.bronze};">${formatWhatsApp(whatsapp)}</a>` : ''
  }.`;

  const preheader = `Order #${ref} is confirmed · ${money(order.total)}. Thank you for shopping with ${BRAND_NAME}.`;
  const subject = `Your order #${ref} is confirmed · ${BRAND_NAME}`;

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Your Order Has Been Confirmed!</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  @media only screen and (max-width:620px) {
    .card { width:100% !important; }
    .px { padding-left:22px !important; padding-right:22px !important; }
    .h1 { font-size:26px !important; }
    .stack { display:block !important; width:100% !important; padding:0 0 20px 0 !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
  <tr><td align="center" style="padding:32px 12px;">
    <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
    <table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${C.card};border:1px solid ${C.line};">

      <tr><td align="center" class="px" style="padding:36px 40px 28px;border-bottom:1px solid ${C.line};">
        <a href="${escapeHtml(links.home)}" style="text-decoration:none;">
          <img src="${escapeHtml(links.logo)}" width="150" height="50" alt="Genesis by Preethy" style="display:block;margin:0 auto;width:150px;height:auto;max-width:150px;border:0;font-family:${SERIF};font-size:16px;line-height:22px;letter-spacing:2px;text-align:center;color:${C.bronze};">
        </a>
      </td></tr>

      <tr><td class="px" style="padding:36px 40px 8px;">
        <p style="margin:0 0 12px;font-family:${SANS};font-size:11px;letter-spacing:3px;text-transform:uppercase;color:${C.bronze};">Order confirmed</p>
        <h1 class="h1" style="margin:0 0 20px;font-family:${SERIF};font-weight:normal;font-size:30px;line-height:1.2;color:${C.ink};">Your Order Has Been Confirmed!</h1>
        <p style="margin:0 0 12px;font-family:${SANS};font-size:15px;line-height:1.7;color:${C.ink};">Dear ${escapeHtml(name)},</p>
        <p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.7;color:${C.muted};">${intro}</p>
      </td></tr>

      <tr><td class="px" style="padding:28px 40px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.panel};"><tr><td style="padding:18px 20px 4px;">
          <!-- The panel's padding lives on this wrapper, so stacking the cells on phones can't strip it. -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td class="stack" width="50%" valign="top" style="padding:0 16px 14px 0;">${label('Order ID')}<p style="margin:0;font-family:${SANS};font-size:14px;color:${C.ink};word-break:break-all;">${id}</p></td>
              <td class="stack" width="50%" valign="top" style="padding:0 0 14px;">${label('Placed on')}<p style="margin:0;font-family:${SANS};font-size:14px;color:${C.ink};">${placedOn(order)}</p></td>
            </tr>
            <tr>
              <td class="stack" width="50%" valign="top" style="padding:0 16px 14px 0;">${label('Payment method')}<p style="margin:0;font-family:${SANS};font-size:14px;color:${C.ink};">${paymentMethodLabel(order)}</p></td>
              <td class="stack" width="50%" valign="top" style="padding:0 0 14px;">${label('Payment status')}<p style="margin:0;font-family:${SANS};font-size:14px;color:${C.ink};">${paymentStatusLabel(order)}</p></td>
            </tr>
          </table>
        </td></tr></table>
      </td></tr>

      ${shortfall}

      <tr><td class="px" style="padding:0 40px;">
        ${label('Your order')}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${C.line};">${itemRows}</table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;">${totals}</table>
      </td></tr>

      <tr><td class="px" style="padding:32px 40px 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td class="stack" width="50%" valign="top" style="padding-right:16px;">
              ${label('Shipping to')}
              <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.7;color:${C.ink};">${addressLines.map(escapeHtml).join('<br>')}</p>
            </td>
            <td class="stack" width="50%" valign="top" style="padding-left:16px;">
              ${label('Estimated delivery')}
              <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.7;color:${C.muted};">${DELIVERY_ESTIMATE}</p>
            </td>
          </tr>
        </table>
      </td></tr>

      <tr><td align="center" class="px" style="padding:32px 40px 8px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td bgcolor="${C.ink}" style="background:${C.ink};">
            <a href="${escapeHtml(links.viewOrder)}" style="display:inline-block;padding:14px 30px;font-family:${SANS};font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${C.page};text-decoration:none;">View your order</a>
          </td>
        </tr></table>
        <p style="margin:14px 0 0;font-family:${SANS};font-size:13px;color:${C.muted};"><a href="${escapeHtml(links.trackOrder)}" style="color:${C.bronze};">Track your order</a> &nbsp;&middot;&nbsp; <a href="${escapeHtml(links.shop)}" style="color:${C.bronze};">Continue shopping</a></p>
      </td></tr>

      <tr><td class="px" style="padding:28px 40px 36px;">
        <p style="margin:0 0 14px;font-family:${SANS};font-size:14px;line-height:1.7;color:${C.muted};">${support}</p>
        <p style="margin:0;font-family:${SERIF};font-size:17px;line-height:1.6;color:${C.ink};">Thank you for choosing ${BRAND_NAME}. We hope these pieces become ones you reach for again and again.</p>
      </td></tr>

      <tr><td class="px" style="padding:20px 40px 28px;border-top:1px solid ${C.line};">
        <p style="margin:0;font-family:${SANS};font-size:11px;line-height:1.7;color:${C.faint};">${LEGAL_LINE}<br>You are receiving this email because you placed an order at <a href="${escapeHtml(links.home)}" style="color:${C.faint};">${escapeHtml(links.home.replace(/^https:\/\//, ''))}</a>.</p>
      </td></tr>

    </table>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    'Your Order Has Been Confirmed!',
    '',
    `Dear ${name},`,
    intro,
    '',
    `Order ID: ${id}`,
    `Placed on: ${placedOn(order)}`,
    `Payment: ${paymentMethodLabel(order)} (${paymentStatusLabel(order)})`,
    ...(order.stockShortfall ? ['', 'One of your pieces sold out moments before your payment went through. Our studio will be in touch shortly to arrange an alternative or a refund.'] : []),
    '',
    'YOUR ORDER',
    ...items.map((i) => `- ${i.name}${i.size ? ` (Size ${i.size})` : ''} x ${i.quantity}: ${money(i.price * i.quantity)}`),
    '',
    `Subtotal: ${money(order.subtotal)}`,
    ...(order.discount > 0 ? [`Discount: -${money(order.discount)}`] : []),
    `Shipping: ${order.shippingFee > 0 ? money(order.shippingFee) : 'Complimentary'}`,
    `Total: ${money(order.total)}`,
    ...(isCod ? [`Paid now (advance): ${money(order.advanceAmount)}`, `Due on delivery: ${money(order.balanceAmount)}`] : []),
    '',
    'SHIPPING TO',
    ...addressLines,
    '',
    'ESTIMATED DELIVERY',
    DELIVERY_ESTIMATE,
    '',
    `View your order: ${links.viewOrder}`,
    `Track your order: ${links.trackOrder}`,
    `Continue shopping: ${links.shop}`,
    '',
    `Need help? Reply to this email or write to ${SUPPORT_EMAIL}${whatsapp ? `, or WhatsApp ${formatWhatsApp(whatsapp)}` : ''}.`,
    '',
    `Thank you for choosing ${BRAND_NAME}.`,
    LEGAL_LINE,
  ].join('\n');

  return { subject, html, text };
}

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
          <a href="${escapeHtml(orderLinks(order._id.toString()).viewOrder)}" style="background-color: #111827; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; font-size: 14px; display: inline-block;">${escapeHtml(ctaLabel)}</a>
        </div>
      </div>
      <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #eaeaea;">
        <p style="color: #9ca3af; font-size: 13px; margin: 0;">© ${new Date().getFullYear()} ${BRAND_NAME}. All rights reserved.</p>
      </div>
    </div>`;
}
