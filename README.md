# Genesis by Preethy — API

Express + MongoDB API for the storefront (`genesis-frontend`) and the studio admin (`genesis-admin`).

## Scripts

- `npm run dev` — local server with reload (reads `.env`)
- `npm run build` / `npm start` — compile to `dist/` and run it (Render runs `build` on install)
- `npm test` — regression suite. Needs a local `mongod` (MongoDB 8 at `C:/Program Files/MongoDB/Server/8.0/bin`, on `PATH`, or `MONGOD_BIN=/path/to/mongod`). Tests never read `.env` and never call Google, Razorpay, SendGrid or Zoho.

## Environment

Required everywhere: `JWT_SECRET`.

Required when `NODE_ENV=production` (and production is the default when `NODE_ENV` is unset — the server refuses to start without these):
`MONGODB_URI`, `FRONTEND_URL`, `GOOGLE_CLIENT_ID`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`.

Strongly recommended in production: `RAZORPAY_WEBHOOK_SECRET` (see below). Optional: `CORS_ORIGIN` (comma-separated), `JWT_EXPIRES_IN` (customers, default `7d`), `ADMIN_JWT_EXPIRES_IN` (default `12h`), `SENDGRID_API_KEY` + `SENDGRID_FROM_EMAIL` + `FROM_NAME` (email is skipped without them), `ZOHO_*` (newsletter mirroring), `CLOUDINARY_*` (image uploads).

Use Razorpay **test** keys (`rzp_test_…`) locally. Without any Razorpay keys and outside production, checkout uses simulated payments so the flow can be walked through.

## Payments

1. `POST /api/v1/payments/create-order` prices the bag from the catalogue, opens a Razorpay order for that amount and stores an `awaiting_payment` order.
2. `POST /api/v1/payments/verify` checks Razorpay's signature and settles that order once (replays return the same order).
3. `POST /api/v1/payments/webhook` settles orders whose browser closed before step 2. In the Razorpay Dashboard → Webhooks, add `https://<api-host>/api/v1/payments/webhook` with events `payment.captured` and `order.paid`, and put the webhook secret in `RAZORPAY_WEBHOOK_SECRET`.

Unpaid `awaiting_payment` orders never appear in customer or admin lists.

## Admin accounts

There is no public admin sign-up. Create or reset an admin (this also signs that admin out everywhere):

```
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase 2026' npx ts-node createAdmin.ts
```
