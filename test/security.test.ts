// Regression tests for auth / platform findings: B1, B4, B7, B8, B9, B14, B15, B16, B17, B18, B19, B20, B24 (n/a), B26, B27, A7, A8.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack, stopStack, resetDb, api, makeUser, makeProduct, stubFetch, outboundCalls, json, baseUrl } from './helpers';

const { User } = require('../src/models/User');
const { Newsletter } = require('../src/models/Newsletter');
const { Product } = require('../src/models/Product');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

/** Pretend Google: `token` is valid for `info` (tokeninfo) and `profile` (userinfo). */
const googleKnows = (token: string, info: Record<string, unknown>, profile: Record<string, unknown> = {}) => {
  stubFetch('https://oauth2.googleapis.com/tokeninfo', (url) =>
    url.searchParams.get('access_token') === token ? json(info) : json({ error_description: 'Invalid Value' }, 400)
  );
  stubFetch('https://www.googleapis.com/oauth2/v3/userinfo', () => json({ sub: info.sub, ...profile }));
};

describe('security', () => {
  before(startStack);
  after(stopStack);
  beforeEach(resetDb);

  describe('B1: Google sign-in trusts only Google', () => {
    it('ignores identity fields from the browser (the old account-takeover request)', async () => {
      const admin = await makeUser({ role: 'admin', email: 'owner@genesis.test' });
      const forged = await api('POST', '/auth/google', { body: { googleId: 'x', email: admin.user.email, mode: 'signin' } });
      assert.equal(forged.status, 400);
      assert.ok(!forged.data.data?.token, 'no token minted');

      const withFakeToken = await api('POST', '/auth/google', { body: { accessToken: 'made-up', googleId: 'x', email: admin.user.email } });
      assert.equal(withFakeToken.status, 401);
      assert.ok(!withFakeToken.data.data?.token, 'no token minted');
    });

    it('rejects a real Google token issued to a different app', async () => {
      googleKnows('tok_other_app', { aud: 'someone-else.apps.googleusercontent.com', sub: 'g1', email: 'a@example.com', email_verified: 'true' });
      const res = await api('POST', '/auth/google', { body: { accessToken: 'tok_other_app', mode: 'register' } });
      assert.equal(res.status, 401);
    });

    it('rejects an expired token and survives Google being unreachable (401, not 500)', async () => {
      // tokeninfo answers 400 invalid_token for expired access tokens.
      stubFetch('https://oauth2.googleapis.com/tokeninfo', () => json({ error: 'invalid_token', error_description: 'Token expired' }, 400));
      assert.equal((await api('POST', '/auth/google', { body: { accessToken: 'expired' } })).status, 401);
      stubFetch('https://oauth2.googleapis.com/tokeninfo', () => { throw new TypeError('fetch failed'); });
      assert.equal((await api('POST', '/auth/google', { body: { accessToken: 'whatever' } })).status, 401);
      assert.equal((await api('POST', '/auth/google', { body: { mode: 'signin' } })).status, 400, 'missing token');
    });

    it('rejects an unverified Google email', async () => {
      googleKnows('tok_unverified', { aud: CLIENT_ID, sub: 'g2', email: 'b@example.com', email_verified: 'false' });
      assert.equal((await api('POST', '/auth/google', { body: { accessToken: 'tok_unverified' } })).status, 401);
    });

    it('signs up a customer from a verified token, using Google\'s identity not the body\'s', async () => {
      googleKnows('tok_good', { aud: CLIENT_ID, sub: 'g3', email: 'Meera@Example.com', email_verified: 'true' }, { name: 'Meera' });
      const res = await api('POST', '/auth/google', { body: { accessToken: 'tok_good', mode: 'register', email: 'attacker@evil.test' } });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal(res.data.data.email, 'meera@example.com');
      assert.equal(res.data.data.role, 'customer');
      const profile = await api('GET', '/users/profile', { token: res.data.data.token });
      assert.equal(profile.data.data.name, 'Meera');
    });

    it('refuses Google sign-in for studio accounts', async () => {
      const admin = await makeUser({ role: 'admin', email: 'studio@genesis.test' });
      googleKnows('tok_admin', { aud: CLIENT_ID, sub: 'g4', email: admin.user.email, email_verified: 'true' });
      const res = await api('POST', '/auth/google', { body: { accessToken: 'tok_admin', mode: 'signin' } });
      assert.equal(res.status, 403);
      assert.ok(!res.data.data?.token, 'no token minted');
    });
  });

  it('B9: admin login is throttled after 5 failures', async () => {
    await makeUser({ role: 'admin', email: 'boss@genesis.test', password: 'Right-Password-123' });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await api('POST', '/auth/login', { body: { email: 'boss@genesis.test', password: `wrong-${i}` } })).status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  });

  it('B20/A5: admin sign-out revokes the token; a stale cookie never overrides the header', async () => {
    await makeUser({ role: 'admin', email: 'boss@genesis.test', password: 'Right-Password-123' });
    const login = await api('POST', '/auth/login', { body: { email: 'boss@genesis.test', password: 'Right-Password-123' } });
    assert.equal(login.status, 200);
    const adminToken = login.data.data.token;
    const { exp, iat } = JSON.parse(Buffer.from(adminToken.split('.')[1], 'base64url').toString());
    assert.equal(exp - iat, 12 * 3600, 'admin sessions last 12 hours');

    // Header wins over a customer's cookie on the same browser.
    const customer = await makeUser();
    const withCookie = await api('GET', '/dashboard/stats', { token: adminToken, headers: { Cookie: `jwt=${customer.token}` } });
    assert.equal(withCookie.status, 200);

    const out = await api('POST', '/auth/logout', { token: adminToken });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie') || '', /jwt=;/);
    assert.equal((await api('GET', '/dashboard/stats', { token: adminToken })).status, 401, 'old admin token is revoked');

    // Customers' other sessions keep working after a sign-out.
    assert.equal((await api('POST', '/auth/logout', { token: customer.token })).status, 200);
    assert.equal((await api('GET', '/users/profile', { token: customer.token })).status, 200);
  });

  it('B8: refuses to boot without JWT_SECRET, and in production without payment/Google config', () => {
    const root = path.join(__dirname, '..');
    // Run from an empty folder so dotenv can't pick up the developer's real .env.
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-env-'));
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), '-e', `require(${JSON.stringify(path.join(root, 'src/config/env.ts'))})`], {
        cwd: emptyDir,
        env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', TS_NODE_PROJECT: path.join(root, 'tsconfig.json'), ...env },
        encoding: 'utf8',
      });
    try {
      const noSecret = run({ NODE_ENV: 'development' });
      assert.notEqual(noSecret.status, 0);
      assert.match(noSecret.stderr, /JWT_SECRET/);
      const dev = run({ NODE_ENV: 'development', JWT_SECRET: 'x' });
      assert.equal(dev.status, 0, dev.stderr);
      // NODE_ENV unset means production: Razorpay/Google/FRONTEND_URL become mandatory.
      const unsetNodeEnv = run({ JWT_SECRET: 'x' });
      assert.notEqual(unsetNodeEnv.status, 0);
      assert.match(unsetNodeEnv.stderr, /RAZORPAY_KEY_SECRET/);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('B15: server errors are logged, not echoed; blocked origins get 403', async () => {
    const { errorHandler } = require('../src/middlewares/errorHandler');
    let sent: any;
    const res: any = { status(c: number) { this.code = c; return this; }, json(b: any) { sent = { code: this.code, ...b }; } };
    errorHandler(new Error('E11000 duplicate key error collection: genesis.orders'), { method: 'GET', originalUrl: '/x' }, res, () => {});
    assert.equal(sent.code, 500);
    assert.doesNotMatch(sent.message, /E11000|collection/);

    const cors = await fetch(`${baseUrl}/api/v1/health`, { headers: { Origin: 'https://evil.test' } });
    assert.equal(cors.status, 403);
  });

  describe('CORS', () => {
    const LIVE = ['https://admin.genesisbypreethy.com', 'https://www.genesisbypreethy.com', 'https://genesisbypreethy.com'];
    const preflight = (origin: string, method = 'PUT') =>
      fetch(`${baseUrl}/api/v1/payments/admin/orders/abc/status`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'authorization,content-type' },
      });

    it('the three live origins pass a credentialed preflight for every method and header the apps use', async () => {
      for (const origin of LIVE) {
        const res = await preflight(origin);
        assert.equal(res.status, 200, origin);
        assert.equal(res.headers.get('access-control-allow-origin'), origin);
        assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
        assert.match(res.headers.get('access-control-allow-headers') || '', /Content-Type/);
        assert.match(res.headers.get('access-control-allow-headers') || '', /Authorization/);
        for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.match(res.headers.get('access-control-allow-methods') || '', new RegExp(m));
        assert.match(res.headers.get('vary') || '', /Origin/, 'caches keep origins apart');
      }
    });

    it('refuses unknown and look-alike origins without any CORS headers (never a wildcard)', async () => {
      for (const origin of ['https://evil.example', 'https://genesisbypreethy.com.evil.example', 'http://genesisbypreethy.com', 'https://shop.genesisbypreethy.com', 'null']) {
        const res = await preflight(origin);
        assert.equal(res.status, 403, origin);
        assert.equal(res.headers.get('access-control-allow-origin'), null, origin);
      }
    });

    it('authenticated requests from the live origins succeed and carry CORS headers', async () => {
      const admin = await makeUser({ role: 'admin' });
      const customer = await makeUser();
      const orders = await fetch(`${baseUrl}/api/v1/payments/admin/orders`, { headers: { Origin: LIVE[0], Authorization: `Bearer ${admin.token}` } });
      assert.equal(orders.status, 200);
      assert.equal(orders.headers.get('access-control-allow-origin'), LIVE[0]);
      const profile = await fetch(`${baseUrl}/api/v1/users/profile`, { headers: { Origin: LIVE[1], Authorization: `Bearer ${customer.token}` } });
      assert.equal(profile.status, 200);
      assert.equal(profile.headers.get('access-control-allow-origin'), LIVE[1]);
    });

    it('a missing token is a readable 401, not a CORS failure', async () => {
      const res = await fetch(`${baseUrl}/api/v1/payments/admin/orders`, { headers: { Origin: LIVE[0] } });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('access-control-allow-origin'), LIVE[0], 'the browser can read the 401');
    });

    it('localhost is allowed only in development; CORS_ORIGIN extras are normalised', () => {
      const { allowedOrigins, PRODUCTION_ORIGINS, DEV_ORIGINS } = require('../src/config/cors');
      const deployed = allowedOrigins('http://localhost:3000, https://genesis-preview.vercel.app/ ,', true);
      assert.ok(!deployed.has('http://localhost:3000'), 'no localhost on a deployed server, even if CORS_ORIGIN lists it');
      assert.ok(deployed.has('https://genesis-preview.vercel.app'), 'trailing slash and spaces removed');
      for (const o of PRODUCTION_ORIGINS) assert.ok(deployed.has(o));
      const dev = allowedOrigins('', false);
      for (const o of [...PRODUCTION_ORIGINS, ...DEV_ORIGINS]) assert.ok(dev.has(o));
    });
  });

  it('production config: simulated payments are never allowed on Render, whatever NODE_ENV says', () => {
    const env = require('../src/config/env');
    const saved = { id: env.ENV.RAZORPAY_KEY_ID, secret: env.ENV.RAZORPAY_KEY_SECRET, render: process.env.RENDER };
    try {
      env.ENV.RAZORPAY_KEY_ID = '';
      env.ENV.RAZORPAY_KEY_SECRET = '';
      assert.equal(env.mockPaymentsAllowed(), true, 'local dev without keys may simulate');
      process.env.RENDER = 'true';
      assert.equal(env.mockPaymentsAllowed(), false, 'never on a deployed server');
    } finally {
      env.ENV.RAZORPAY_KEY_ID = saved.id;
      env.ENV.RAZORPAY_KEY_SECRET = saved.secret;
      if (saved.render === undefined) delete process.env.RENDER; else process.env.RENDER = saved.render;
    }
  });

  it('production config: the startup summary names settings but never secrets', () => {
    const summary: string = require('../src/config/env').configSummary();
    assert.match(summary, /NODE_ENV=test/);
    assert.match(summary, /Razorpay=test/);
    assert.match(summary, /webhook secret=set/);
    for (const secret of ['test_key_secret', 'test_webhook_secret', 'test-jwt-secret']) assert.ok(!summary.includes(secret), `${secret} not logged`);
  });

  it('B16: JSON bodies over 1 MB are refused', async () => {
    const res = await api('POST', '/newsletter/subscribe', { body: { email: 'a@b.co', source: 'x'.repeat(1_100_000) } });
    assert.equal(res.status, 413);
  });

  it('B17: cart rejects malformed quantities and unknown sizes', async () => {
    const ctx = await makeUser();
    const p = await makeProduct();
    const add = (body: unknown) => api('POST', '/cart', { token: ctx.token, body });
    assert.equal((await add({ productId: p.id, quantity: '5', size: 'M' })).status, 400);
    assert.equal((await add({ productId: p.id, quantity: -3, size: 'M' })).status, 400);
    assert.equal((await add({ productId: p.id, size: 'M' })).status, 400);
    assert.equal((await add({ productId: p.id, quantity: 1, size: 'XXL' })).status, 400);
    const ok = await add({ productId: p.id, quantity: 1, size: 'M' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.data.items[0].quantity, 1);
    assert.equal((await api('PUT', '/site-settings', { token: (await makeUser({ role: 'admin' })).token, body: { whatsappNumber: 919999 } })).status, 400);
  });

  it('B19: text is stored as typed; unsafe CMS links are refused', async () => {
    const ctx = await makeUser();
    const named = await api('PUT', '/users/profile', { token: ctx.token, body: { name: 'Bonus=10 onwards' } });
    assert.equal(named.data.data.name, 'Bonus=10 onwards', 'the old regex filter turned this into "B10 onwards"');

    const admin = await makeUser({ role: 'admin' });
    const note = (ctaHref: string) => api('PUT', '/studio-note', { token: admin.token, body: { ctaHref } });
    assert.equal((await note('javascript:alert(1)')).status, 400);
    assert.equal((await note('//evil.test/x')).status, 400);
    assert.equal((await note('/products?collection=onam')).status, 200);
    assert.equal((await note('https://wa.me/917736830303')).status, 200);
  });

  it('B27: the customer block toggle cannot touch admins and returns no secrets', async () => {
    const admin = await makeUser({ role: 'admin' });
    const other = await makeUser({ role: 'admin' });
    const customer = await makeUser({ googleId: 'g-secret' });
    assert.equal((await api('PUT', `/users/admin/customers/${other.user.id}/toggle-status`, { token: admin.token })).status, 404);
    const res = await api('PUT', `/users/admin/customers/${customer.user.id}/toggle-status`, { token: admin.token });
    assert.equal(res.data.data.isActive, false);
    for (const secret of ['password', 'googleId', 'tokenVersion', 'addresses']) assert.ok(!(secret in res.data.data), `${secret} not returned`);
    assert.equal((await api('GET', '/users/profile', { token: customer.token })).status, 403, 'blocked customer is locked out');
  });

  describe('B18: newsletter', () => {
    it('answers with the email only and makes no outbound calls when integrations are off', async () => {
      const res = await api('POST', '/newsletter/subscribe', { body: { email: 'Reader@Example.com', source: 'home' } });
      assert.equal(res.status, 201);
      assert.deepEqual(res.data.data, { email: 'reader@example.com' });
      assert.deepEqual(outboundCalls, []);
    });

    it('is rate-limited', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await api('POST', '/newsletter/subscribe', { body: { email: `r${i}@example.com` } })).status);
      assert.equal(statuses[10], 429);
    });

    it('unsubscribes only with a valid signed link, and only on POST', async () => {
      await api('POST', '/newsletter/subscribe', { body: { email: 'leaving@example.com' } });
      const crypto = require('node:crypto');
      const token = crypto.createHmac('sha256', 'test-jwt-secret').update('newsletter-unsubscribe:leaving@example.com').digest('hex');

      assert.equal((await api('GET', '/newsletter/unsubscribe?email=leaving@example.com&token=nope')).status, 400);
      const page = await api('GET', `/newsletter/unsubscribe?email=leaving@example.com&token=${token}`);
      assert.equal(page.status, 200);
      assert.equal((await Newsletter.findOne({ email: 'leaving@example.com' })).isActive, true, 'opening the link changes nothing');

      const form = (t: string) => api('POST', '/newsletter/unsubscribe', {
        raw: new URLSearchParams({ email: 'leaving@example.com', token: t }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      assert.equal((await form('forged')).status, 400);
      assert.equal((await form(token)).status, 200);
      assert.equal((await Newsletter.findOne({ email: 'leaving@example.com' })).isActive, false);
    });
  });

  describe('B7/B14/B26: order emails', () => {
    it('are branded Genesis, carry no login token, and escape customer text', () => {
      const { renderOrderEmail } = require('../src/utils/orderEmail');
      const html: string = renderOrderEmail({
        order: { _id: 'ord1', createdAt: new Date(), items: [{ name: '<img src=x onerror=alert(1)>', size: 'M', quantity: 1, price: 24000 }], subtotal: 24000, discount: 0, shippingFee: 0, total: 24000, paymentMethod: 'razorpay' },
        customerName: '<script>x</script>',
        heading: 'Order Confirmation',
        message: 'Thanks',
        ctaLabel: 'View Order Details',
      });
      assert.doesNotMatch(html, /heedy/i);
      assert.match(html, /Genesis/);
      assert.doesNotMatch(html, /token=/);
      assert.match(html, /href="http:\/\/shop\.test\/profile"/);
      assert.doesNotMatch(html, /<script>|<img src=x/);
      assert.match(html, /Size M · Qty 1/);
    });
  });

  it('A7: archived pieces are hidden from the shop but visible to the admin', async () => {
    await makeProduct({ name: 'Visible' });
    await makeProduct({ name: 'Hidden', status: 'Archived' });
    const shop = await api('GET', '/products');
    assert.deepEqual(shop.data.data.map((p: any) => p.name), ['Visible']);
    const all = await api('GET', '/products?all=1');
    assert.equal(all.data.data.length, 2);
  });

  it('A8: renaming a category moves its pieces; deleting a used category is refused', async () => {
    const admin = await makeUser({ role: 'admin' });
    const created = await api('POST', '/categories', { token: admin.token, body: { name: 'Silk Sarees', image: 'https://res.cloudinary.com/demo/c.jpg' } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const p = await makeProduct({ category: 'Silk Sarees' });
    await api('PUT', `/categories/${created.data.data._id}`, { token: admin.token, body: { name: 'Kanjivaram' } });
    assert.equal((await Product.findById(p._id)).category, 'Kanjivaram');
    const del = await api('DELETE', `/categories/${created.data.data._id}`, { token: admin.token });
    assert.equal(del.status, 409);
    assert.match(del.data.message, /1 piece still uses/);
  });

  it('A11: product uploads refuse non-images and unknown field names before reaching Cloudinary', async () => {
    const admin = await makeUser({ role: 'admin' });
    const post = async (field: string, type: string) => {
      const form = new FormData();
      form.append('name', 'Test');
      form.append('category', 'Sarees');
      form.append(field, new Blob(['not an image'], { type }), 'x.txt');
      const res = await fetch(`${baseUrl}/api/v1/products`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}` }, body: form });
      return { status: res.status, body: await res.json() };
    };
    const wrongType = await post('imageFiles', 'text/plain');
    assert.equal(wrongType.status, 400);
    assert.match(wrongType.body.message, /JPG, PNG or WebP/);
    assert.equal((await post('somethingElse', 'image/png')).status, 400, 'only the known upload fields are accepted');
  });

  it('B4: createAdmin refuses to run without credentials from the environment', () => {
    const r = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', 'createAdmin.ts'], {
      cwd: path.join(__dirname, '..'),
      env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', NODE_ENV: 'test', JWT_SECRET: 'x', ADMIN_EMAIL: 'a@b.co', ADMIN_PASSWORD: 'short' },
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ADMIN_PASSWORD/);
  });
});
