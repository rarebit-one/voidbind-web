// Unit suite for the login flow + token-carrying helpers. Zero heavy deps:
// node:test + node:assert with an injected mock `fetch`, so the start -> poll ->
// token contract is proven without a network or a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  startWebLogin,
  pollUntilApproved,
  authFetch,
  sseUrl,
  joinUrl,
  signIn,
  POLL_INTERVAL_MS,
} from '../src/index.js';

// A tiny mock-fetch factory: hand it a route table keyed by "METHOD path" and it
// returns a fetch-shaped function that records calls and replies with JSON.
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(url);
    const key = method + ' ' + u.pathname;
    calls.push({ url, key, init });
    const handler = routes[key];
    if (!handler) return { ok: false, status: 404, async json() { return {}; } };
    const r = typeof handler === 'function' ? handler(calls.length) : handler;
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      async json() { return r.body; },
    };
  };
  fn.calls = calls;
  return fn;
}

const BASE = 'https://rp.example';

test('joinUrl trims trailing slash and ensures a leading slash', () => {
  assert.equal(joinUrl('https://rp.example/', 'login'), 'https://rp.example/login');
  assert.equal(joinUrl('https://rp.example', '/login'), 'https://rp.example/login');
  assert.equal(joinUrl('https://rp.example///', '/login/abc'), 'https://rp.example/login/abc');
});

test('startWebLogin POSTs /login and maps id/qr/expiresAt', async () => {
  const fetchImpl = mockFetch({
    'POST /login': {
      body: { id: 'login-123', qr: 'voidbind:login?rp=https%3A%2F%2Frp.example&id=login-123', expiresAt: 1730000000 },
    },
  });
  const out = await startWebLogin({ baseUrl: BASE, fetchImpl });
  assert.equal(out.loginId, 'login-123');
  assert.match(out.qrPayload, /^voidbind:login\?rp=.*&id=login-123$/);
  assert.equal(out.expiresAt, 1730000000);
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
  assert.equal(fetchImpl.calls[0].key, 'POST /login');
});

test('startWebLogin throws on a non-OK start', async () => {
  const fetchImpl = mockFetch({ 'POST /login': { ok: false, status: 503, body: {} } });
  await assert.rejects(() => startWebLogin({ baseUrl: BASE, fetchImpl }), /HTTP 503/);
});

test('pollUntilApproved resolves with the session token once approved', async () => {
  let n = 0;
  const fetchImpl = mockFetch({
    'GET /login/login-123': () => {
      n += 1;
      if (n < 3) return { body: { status: 'pending' } };
      return { body: { status: 'approved', token: 'sess-tok-abc', user: 'jaryl' } };
    },
  });
  const out = await pollUntilApproved({ baseUrl: BASE, loginId: 'login-123', intervalMs: 1, fetchImpl });
  assert.deepEqual(out, { token: 'sess-tok-abc', user: 'jaryl' });
  assert.equal(n, 3, 'should have polled until approval');
});

test('pollUntilApproved rejects on expiry', async () => {
  const fetchImpl = mockFetch({ 'GET /login/x': { body: { status: 'expired' } } });
  await assert.rejects(
    () => pollUntilApproved({ baseUrl: BASE, loginId: 'x', intervalMs: 1, fetchImpl }),
    /expired/,
  );
});

test('pollUntilApproved rejects on denial', async () => {
  const fetchImpl = mockFetch({ 'GET /login/x': { body: { status: 'denied' } } });
  await assert.rejects(
    () => pollUntilApproved({ baseUrl: BASE, loginId: 'x', intervalMs: 1, fetchImpl }),
    /denied/,
  );
});

test('pollUntilApproved rejects when the broker forgets the login (404)', async () => {
  const fetchImpl = mockFetch({}); // every route 404s
  await assert.rejects(
    () => pollUntilApproved({ baseUrl: BASE, loginId: 'gone', intervalMs: 1, fetchImpl }),
    /no longer exists/,
  );
});

test('pollUntilApproved unwinds promptly when aborted', async () => {
  const controller = new AbortController();
  const fetchImpl = mockFetch({ 'GET /login/x': { body: { status: 'pending' } } });
  const p = pollUntilApproved({ baseUrl: BASE, loginId: 'x', intervalMs: 50, signal: controller.signal, fetchImpl });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(() => p, (e) => e.name === 'AbortError');
});

test('authFetch attaches a Bearer header and preserves other init', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200 }; };
  const af = authFetch('sess-tok-abc', fetchImpl);
  await af('https://rp.example/api/features', { headers: { Accept: 'application/json' }, method: 'GET' });
  assert.equal(seen[0].init.headers.Authorization, 'Bearer sess-tok-abc');
  assert.equal(seen[0].init.headers.Accept, 'application/json');
  assert.equal(seen[0].init.method, 'GET');
});

test('authFetch with no token is a passthrough (no Authorization header)', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return { ok: true }; };
  await authFetch('', fetchImpl)('https://rp.example/api/x');
  assert.equal(seen[0].init.headers.Authorization, undefined);
});

test('sseUrl appends ?token= (and & when the path already has a query)', () => {
  assert.equal(
    sseUrl(BASE, '/api/live/flights', 'sess-tok-abc'),
    'https://rp.example/api/live/flights?token=sess-tok-abc',
  );
  assert.equal(
    sseUrl(BASE, '/api/live/flights?since=1', 'a b'),
    'https://rp.example/api/live/flights?since=1&token=a%20b',
  );
  assert.equal(sseUrl(BASE, '/api/live/flights', ''), 'https://rp.example/api/live/flights');
});

test('signIn ties start -> (render) -> poll into a single token result', async () => {
  let n = 0;
  const fetchImpl = mockFetch({
    'POST /login': { body: { id: 'L1', qr: 'voidbind:login?rp=x&id=L1' } },
    'GET /login/L1': () => {
      n += 1;
      return n < 2 ? { body: { status: 'pending' } } : { body: { status: 'approved', token: 'T', user: 'kate' } };
    },
  });
  const phases = [];
  const fakeEl = { innerHTML: '', setAttribute() {} };
  const out = await signIn({
    baseUrl: BASE,
    qrElement: fakeEl,
    intervalMs: 1,
    fetchImpl,
    onStatus: (s) => phases.push(s.phase),
  });
  assert.deepEqual(out, { token: 'T', user: 'kate' });
  assert.ok(fakeEl.innerHTML.includes('<svg'), 'the QR should have been rendered into the element');
  assert.deepEqual(phases, ['starting', 'awaiting-approval', 'approved']);
});

test('POLL_INTERVAL_MS matches allthing signin.html (1s)', () => {
  assert.equal(POLL_INTERVAL_MS, 1000);
});
