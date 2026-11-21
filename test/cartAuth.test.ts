// Google sign-in (find-or-create, safe linking) and the cart a guest brings
// with them: merge rules, idempotency, unavailable pieces, the public quote.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, stopStack, resetDb, api, makeUser, makeProduct, stubFetch, json } from './helpers';

const { User } = require('../src/models/User');
const { Cart } = require('../src/models/Cart');
const { Product } = require('../src/models/Product');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

/** Pretend Google: `token` belongs to this Google account. */
const googleKnows = (token: string, info: Record<string, unknown>, profile: Record<string, unknown> = {}) => {
  stubFetch('https://oauth2.googleapis.com/tokeninfo', (url) =>
    url.searchParams.get('access_token') === token ? json({ aud: CLIENT_ID, email_verified: 'true', ...info }) : json({ error: 'invalid_token' }, 400)
  );
  stubFetch('https://www.googleapis.com/oauth2/v3/userinfo', () => json({ sub: info.sub, ...profile }));
};
const google = (token: string, mode?: string) => api('POST', '/auth/google', { body: { accessToken: token, ...(mode ? { mode } : {}) } });

const merge = (token: string, items: unknown[], mergeId?: string) =>
  api('POST', '/cart/merge', { token, body: { items, ...(mergeId ? { mergeId } : {}) } });
const lines = (cart: any) =>
  cart.items.map((i: any) => `${i.product.name}/${i.size}×${i.quantity}`).sort();

describe('Google sign-in and the guest cart', () => {
  before(startStack);
  after(stopStack);
  beforeEach(resetDb);

  it('G1: an existing customer is signed in from any Google button, keeping their account as it is', async () => {
    const existing = await makeUser({ email: 'meera@example.com', name: 'Meera K' });
    googleKnows('tok_meera', { sub: 'g-meera', email: 'Meera@Example.com' }, { name: 'Meera From Google', picture: 'https://lh3.googleusercontent.com/a/meera' });

    for (const mode of ['signin', 'register', undefined]) {
      const res = await google('tok_meera', mode);
      assert.equal(res.status, 200, `mode ${mode}: ${JSON.stringify(res.data)}`);
      assert.equal(res.data.data._id, existing.user.id);
      assert.equal(res.data.data.isNewUser, false);
      assert.ok(res.data.data.token);
    }
    assert.equal(await User.countDocuments({}), 1, 'no duplicate account');
    const user = await User.findById(existing.user.id);
    assert.equal(user.name, 'Meera K', 'their own name is kept');
    assert.equal(user.googleId, 'g-meera', 'Google linked to the account');
    assert.equal(user.avatar, 'https://lh3.googleusercontent.com/a/meera', 'missing picture filled in');
    assert.equal(user.addresses.length, 2, 'addresses kept');
  });

  it('G2: a new customer gets an account straight from the sign-in page', async () => {
    googleKnows('tok_new', { sub: 'g-new', email: 'New.Shopper@Example.com' }, { name: 'New Shopper', picture: 'https://lh3.googleusercontent.com/a/new' });
    const res = await google('tok_new', 'signin');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.data.isNewUser, true);
    const user = await User.findById(res.data.data._id);
    assert.equal(user.email, 'new.shopper@example.com');
    assert.equal(user.googleId, 'g-new');
    assert.equal(user.name, 'New Shopper');
    assert.equal(user.avatar, 'https://lh3.googleusercontent.com/a/new');
    assert.equal(user.role, 'customer');
    assert.equal(user.isActive, true);
    assert.equal(user.isVerified, true);
    // The session works right away: the new customer can use their cart.
    assert.equal((await api('GET', '/cart', { token: res.data.data.token })).status, 200);
  });

  it('G3: an email already linked to a different Google account is refused, not re-linked', async () => {
    const existing = await makeUser({ email: 'kavya@example.com', googleId: 'g-original' });
    googleKnows('tok_other', { sub: 'g-impostor', email: 'kavya@example.com' });
    const res = await google('tok_other', 'signin');
    assert.equal(res.status, 409);
    assert.equal(res.data.data?.token, undefined);
    assert.equal((await User.findById(existing.user.id)).googleId, 'g-original');
  });

  it('G4: several first sign-ins at once still make one account', async () => {
    googleKnows('tok_race', { sub: 'g-race', email: 'race@example.com' }, { name: 'Race' });
    const results = await Promise.all([google('tok_race'), google('tok_race'), google('tok_race')]);
    for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(new Set(results.map((r) => r.data.data._id)).size, 1);
    assert.equal(await User.countDocuments({ email: 'race@example.com' }), 1);
  });

  it('C1: a guest cart merges into the account cart: same piece + size adds up, nothing is overwritten', async () => {
    const ctx = await makeUser();
    const a = await makeProduct({ name: 'Product A', variants: [{ volume: 'M', price: 24000, images: [] }, { volume: 'L', price: 25000, images: [] }] });
    const b = await makeProduct({ name: 'Product B', variants: [{ volume: 'M', price: 9000, images: [] }] });
    const c = await makeProduct({ name: 'Product C', variants: [{ volume: 'S', price: 5000, images: [] }] });
    // Already in the account: A/M ×1 and C/S ×2.
    await api('POST', '/cart', { token: ctx.token, body: { productId: a.id, quantity: 1, size: 'M' } });
    await api('POST', '/cart', { token: ctx.token, body: { productId: c.id, quantity: 2, size: 'S' } });

    const res = await merge(ctx.token, [
      { productId: a.id, quantity: 2, size: 'M' },
      { productId: b.id, quantity: 1, size: 'M' },
      { productId: b.id, quantity: 1, size: 'M' }, // the same line twice in the guest cart
      { productId: a.id, quantity: 1, size: 'L' }, // a different size is a different line
      { productId: c.id, quantity: 19, size: 'S' }, // 2 + 19 would pass the per-line limit
    ], 'guest-cart-0001');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(lines(res.data.data), ['Product A/L×1', 'Product A/M×3', 'Product B/M×2', 'Product C/S×20']);
    assert.deepEqual(res.data.data.removed, []);
    assert.equal(res.data.data.mergeIds, undefined, 'bookkeeping is not sent to the browser');
  });

  it('C2: the same guest cart merged twice (retry, second tab) adds nothing the second time', async () => {
    const ctx = await makeUser();
    const p = await makeProduct({ variants: [{ volume: 'M', price: 24000, images: [] }] });
    const guest = [{ productId: p.id, quantity: 2, size: 'M' }];
    const results = await Promise.all([merge(ctx.token, guest, 'guest-cart-0002'), merge(ctx.token, guest, 'guest-cart-0002')]);
    for (const r of results) assert.equal(r.status, 200);
    const again = await merge(ctx.token, guest, 'guest-cart-0002');
    assert.equal(again.data.message, 'Cart already merged');
    const cart = await api('GET', '/cart', { token: ctx.token });
    assert.deepEqual(lines(cart.data.data), ['Thamara/M×2']);
    // A different guest cart is a new merge.
    await merge(ctx.token, guest, 'guest-cart-0003');
    assert.deepEqual(lines((await api('GET', '/cart', { token: ctx.token })).data.data), ['Thamara/M×4']);
    assert.equal((await merge(ctx.token, guest, 'bad id!')).status, 400);
  });

  it('C3: pieces that can no longer be bought are skipped on merge and reported by name', async () => {
    const ctx = await makeUser();
    const ok = await makeProduct({ name: 'Still Here', variants: [{ volume: 'M', price: 24000, images: [] }] });
    const archived = await makeProduct({ name: 'Archived Piece', status: 'Archived' });
    const enquiry = await makeProduct({ name: 'Enquiry Only', variants: [{ volume: 'M', price: 0, images: [] }] });
    const res = await merge(ctx.token, [
      { productId: ok.id, quantity: 1, size: 'M' },
      { productId: archived.id, quantity: 1, size: 'M' },
      { productId: enquiry.id, quantity: 1, size: 'M' },
      { productId: ok.id, quantity: 1, size: 'XXL' }, // size withdrawn
      { productId: '0123456789abcdef01234567', quantity: 1, size: 'M' }, // deleted piece
    ], 'guest-cart-0004');
    assert.equal(res.status, 200);
    assert.deepEqual(lines(res.data.data), ['Still Here/M×1']);
    assert.deepEqual(res.data.data.removed.sort(), ['Archived Piece', 'Enquiry Only', 'Still Here'].sort());
  });

  it('C4: a piece withdrawn after it was added leaves the saved cart with a notice, not a checkout error', async () => {
    const ctx = await makeUser();
    const p = await makeProduct({ name: 'Going Away', variants: [{ volume: 'M', price: 24000, images: [] }] });
    const keep = await makeProduct({ name: 'Staying', variants: [{ volume: 'M', price: 9000, images: [] }] });
    await api('POST', '/cart', { token: ctx.token, body: { productId: p.id, quantity: 1, size: 'M' } });
    await api('POST', '/cart', { token: ctx.token, body: { productId: keep.id, quantity: 1, size: 'M' } });
    await Product.updateOne({ _id: p._id }, { $set: { status: 'Archived' } });

    const res = await api('GET', '/cart', { token: ctx.token });
    assert.deepEqual(lines(res.data.data), ['Staying/M×1']);
    assert.deepEqual(res.data.data.removed, ['Going Away']);
    assert.deepEqual((await api('GET', '/cart', { token: ctx.token })).data.data.removed, [], 'reported once');
    const added = await api('POST', '/cart', { token: ctx.token, body: { productId: p.id, quantity: 1, size: 'M' } });
    assert.equal(added.status, 404, 'cannot be added back');
  });

  it('C5: guests get current prices from the public quote, which reads the catalogue only', async () => {
    const p = await makeProduct({ name: 'Priced', images: [], variants: [{ volume: 'M', price: 26000, images: ['https://res.cloudinary.com/demo/image/upload/m.jpg'] }] });
    const gone = await makeProduct({ name: 'Gone', status: 'Archived' });
    const res = await api('POST', '/cart/quote', {
      body: { items: [{ productId: p.id, quantity: 2, size: 'M' }, { productId: gone.id, quantity: 1, size: 'M' }] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const [priced, unavailable] = res.data.data.items;
    assert.deepEqual(
      { name: priced.name, price: priced.price, quantity: priced.quantity, size: priced.size, image: priced.image, available: priced.available },
      { name: 'Priced', price: 26000, quantity: 2, size: 'M', image: 'https://res.cloudinary.com/demo/image/upload/m.jpg', available: true }
    );
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.name, 'Gone');
    assert.equal(await Cart.countDocuments({}), 0, 'no cart stored for a guest');

    const tooMany = Array.from({ length: 51 }, () => ({ productId: p.id, quantity: 1, size: 'M' }));
    assert.equal((await api('POST', '/cart/quote', { body: { items: tooMany } })).status, 400);
    assert.equal((await api('POST', '/cart/quote', { body: { items: [{ productId: 'nope', quantity: 1 }] } })).status, 400);
    assert.equal((await api('POST', '/cart/quote', { body: { items: [{ productId: p.id, quantity: 21, size: 'M' }] } })).status, 400);
  });

  it('C6: each customer only ever reaches their own cart', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const p = await makeProduct();
    await api('POST', '/cart', { token: a.token, body: { productId: p.id, quantity: 1, size: 'M' } });
    assert.deepEqual((await api('GET', '/cart', { token: b.token })).data.data.items, []);
    await merge(b.token, [{ productId: p.id, quantity: 2, size: 'M' }], 'guest-cart-0006');
    assert.deepEqual(lines((await api('GET', '/cart', { token: a.token })).data.data), ['Thamara/M×1'], "B's merge left A's cart alone");
    assert.equal((await api('GET', '/cart')).status, 401, 'no token, no saved cart');
    assert.equal((await api('POST', '/cart/merge', { body: { items: [] } })).status, 401);
  });
});
