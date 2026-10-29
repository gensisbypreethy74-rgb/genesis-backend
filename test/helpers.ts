/**
 * Test harness: a throwaway local mongod, the real Express app on a random
 * port, and a fetch stub so no test can reach Google, Razorpay, SendGrid or
 * Zoho. The real .env is never loaded (config/env.ts skips it under NODE_ENV=test).
 */
import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Must be set before anything imports src/config/env.
Object.assign(process.env, {
  NODE_ENV: 'test',
  JWT_SECRET: 'test-jwt-secret',
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  RAZORPAY_KEY_ID: 'rzp_test_dummy',
  RAZORPAY_KEY_SECRET: 'test_key_secret',
  RAZORPAY_WEBHOOK_SECRET: 'test_webhook_secret',
  FRONTEND_URL: 'http://shop.test',
  CORS_ORIGIN: 'http://shop.test,http://admin.test',
});
for (const key of ['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL', 'ZOHO_CLIENT_ID', 'ZOHO_REFRESH_TOKEN', 'CLOUDINARY_API_SECRET']) {
  delete process.env[key];
}

import mongoose from 'mongoose';

const realFetch = globalThis.fetch;
type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
const handlers: { match: (url: URL) => boolean; handle: Handler }[] = [];
export const outboundCalls: string[] = [];

/** Answer outbound requests whose URL starts with `prefix`. */
export const stubFetch = (prefix: string, handle: Handler) => {
  handlers.unshift({ match: (u) => u.href.startsWith(prefix), handle });
};
export const clearFetchStubs = () => {
  handlers.length = 0;
  outboundCalls.length = 0;
};

globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  outboundCalls.push(url.href);
  const h = handlers.find((x) => x.match(url));
  if (!h) throw new Error(`Unexpected outbound request in test: ${url.origin}${url.pathname}`);
  return h.handle(url, init);
}) as typeof fetch;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const mongodBinary = () => {
  if (process.env.MONGOD_BIN) return process.env.MONGOD_BIN;
  const win = 'C:/Program Files/MongoDB/Server/8.0/bin/mongod.exe';
  return fs.existsSync(win) ? win : 'mongod';
};

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });

let mongod: ChildProcess | undefined;
let dbPath = '';
let server: import('node:http').Server | undefined;
export let baseUrl = '';

export async function startStack() {
  dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-test-db-'));
  const port = await freePort();
  mongod = spawn(mongodBinary(), ['--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1', '--quiet'], { stdio: 'ignore' });
  const uri = `mongodb://127.0.0.1:${port}/genesis_test`;
  for (let i = 0; ; i++) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 1000 });
      break;
    } catch (e) {
      if (i > 30) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const app = require('../src/app').default;
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server!.address() as net.AddressInfo).port}`;
  // Build every declared index (the replay/lookup ones matter to the tests).
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}

export async function stopStack() {
  await new Promise((r) => (server ? server.close(r) : r(null)));
  await mongoose.disconnect();
  mongod?.kill();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(dbPath, { recursive: true, force: true, maxRetries: 5 });
}

export async function resetDb() {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  clearFetchStubs();
  // Each test starts with fresh rate-limit budgets.
  const limiters = require('../src/middlewares/rateLimiter');
  for (const l of Object.values(limiters) as any[]) for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) l.resetKey?.(ip);
}

export async function api(method: string, p: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${baseUrl}/api/v1${p}`, { method, headers, body });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, headers: res.headers };
}

export const hmac = (payload: string, secret: string) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

export async function makeUser(overrides: Record<string, unknown> = {}) {
  const { User } = require('../src/models/User');
  const jwt = require('jsonwebtoken');
  const user = await User.create({
    name: 'Asha Menon',
    email: `asha${crypto.randomUUID().slice(0, 8)}@example.com`,
    password: 'Customer-Pass-123',
    role: 'customer',
    isActive: true,
    addresses: [
      { street: '12 Marine Drive', apartment: 'Flat 4B', landmark: 'Near the boat jetty', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' },
      { city: 'Kochi', state: 'Kerala' }, // no PIN code
    ],
    ...overrides,
  });
  const token = jwt.sign({ id: user._id.toString(), role: user.role, tv: user.tokenVersion ?? 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return { user, token, addressId: user.addresses[0]._id.toString(), incompleteAddressId: user.addresses[1]._id.toString() };
}

export async function makeProduct(overrides: Record<string, unknown> = {}) {
  const { Product } = require('../src/models/Product');
  return Product.create({
    name: 'Thamara',
    category: 'Sarees',
    images: ['https://res.cloudinary.com/demo/image/upload/thamara.jpg'],
    variants: [
      { volume: 'M', price: 24000, images: [], stock: 2 },
      { volume: 'L', price: 25000, images: [] }, // stock not tracked
    ],
    ...overrides,
  });
}
