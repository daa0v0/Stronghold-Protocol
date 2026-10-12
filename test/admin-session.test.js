// The boundary the user asked about: without a login, nothing is readable; with one, the session is bounded, visible and
// revocable. `server/admin.js` mints a per-process cookie token at login, and this file pins the three properties that were
// missing and made a still-open session look like a leak:
//
//   1. every console answer is `no-store` — a cache must not be able to replay an authenticated payload;
//   2. a session expires (ADMIN_SESSION_TTL_MS, both in the cookie and checked here), so "logged in days ago" is not a way in;
//   3. logging out kills the session on the SERVER, so the old cookie is worthless immediately (not just deleted locally).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { ADMIN_SESSION_TTL_MS } from '../server/admin.js';

const SECRET = 'session-test-secret-value';
const API = ['/overview', '/rooms', '/logs', '/packs', '/mods'];

async function makeServer(extra = {}) {
  return startServer({ port: 0, host: '127.0.0.1', quiet: true, adminSecret: SECRET, adminSecretFile: '', ...extra });
}
/** @param {string} base @param {string} path */
async function call(base, path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  return { status: res.status, headers: res.headers, body: await res.text() };
}
async function loginCookie(srv, secret = SECRET) {
  const res = await call(srv.url, '/api/admin/login', { method: 'POST', body: { secret } });
  assert.equal(res.status, 200, res.body);
  return String(res.headers.get('set-cookie')).split(';')[0];
}

test('without a login every console answer is refused and nothing may be cached', async () => {
  const srv = await makeServer();
  try {
    for (const path of API) {
      const res = await call(srv.url, `/api/admin${path}`);
      assert.equal(res.status, 401, `${path} must not answer without a login`);
      assert.equal(res.headers.get('cache-control'), 'no-store', `${path} must not be cacheable`);
      assert.ok(!/rssMb|"rooms"|"packs"/.test(res.body), `${path} leaked a payload`);
    }
    // The shell itself is public (it holds the login form) and the static handler answers it `no-cache` — revalidate, which
    // is fine for a page with no data in it. What must never be storable is a PAYLOAD, which the loop above pins.
    const shell = await call(srv.url, '/admin');
    assert.equal(shell.status, 200);
    assert.match(String(shell.headers.get('cache-control')), /no-(store|cache)/);
    assert.match(shell.body, /id="login-secret"/);
    assert.match(shell.body, /id="dashboard" hidden/, 'the dashboard starts hidden, not merely covered');
  } finally { await srv.close(); }
});

test('a session is bounded: the cookie carries the lifetime and the server enforces it', async () => {
  let clock = 1_700_000_000_000;
  const srv = await makeServer({ adminNow: () => clock });
  try {
    const cookie = await loginCookie(srv);
    assert.equal((await call(srv.url, '/api/admin/overview', { cookie })).status, 200);
    const setCookie = String((await call(srv.url, '/api/admin/login', { method: 'POST', body: { secret: SECRET } })).headers.get('set-cookie'));
    assert.match(setCookie, new RegExp(`Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}\\b`), 'the browser is told the same lifetime');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);

    // an hour before the end it still works; one hour after, it is refused even though the token is unchanged
    clock += ADMIN_SESSION_TTL_MS - 3600_000;
    assert.equal((await call(srv.url, '/api/admin/overview', { cookie })).status, 200);
    clock += 2 * 3600_000;
    const expired = await call(srv.url, '/api/admin/overview', { cookie });
    assert.equal(expired.status, 401, 'an expired session must not answer');
    assert.equal(expired.headers.get('cache-control'), 'no-store');
    // logging in again starts a new session with the same token
    assert.equal((await call(srv.url, '/api/admin/overview', { cookie: await loginCookie(srv) })).status, 200);
  } finally { await srv.close(); }
});

test('logging out revokes the session on the server, not just in the browser', async () => {
  const srv = await makeServer();
  try {
    const cookie = await loginCookie(srv);
    assert.equal((await call(srv.url, '/api/admin/overview', { cookie })).status, 200);
    const out = await call(srv.url, '/api/admin/logout', { method: 'POST', cookie });
    assert.equal(out.status, 200);
    assert.match(String(out.headers.get('set-cookie')), /Max-Age=0/, 'the browser cookie is cleared');
    const after = await call(srv.url, '/api/admin/overview', { cookie });
    assert.equal(after.status, 401, 'and the token that was just used is dead');
    // a fresh login still works, and it is a DIFFERENT token
    const next = await loginCookie(srv);
    assert.notEqual(next, cookie, 'the session token rotates on logout');
    assert.equal((await call(srv.url, '/api/admin/overview', { cookie: next })).status, 200);
  } finally { await srv.close(); }
});

test('the overview reports the session it was asked with (so the panel can say why no password was asked)', async () => {
  let clock = 1_700_000_000_000;
  const srv = await makeServer({ adminNow: () => clock });
  try {
    const cookie = await loginCookie(srv);
    clock += 60_000;
    const ov = JSON.parse((await call(srv.url, '/api/admin/overview', { cookie })).body);
    assert.equal(ov.session.ttlMs, ADMIN_SESSION_TTL_MS);
    assert.equal(ov.session.since, 1_700_000_000_000);
    assert.equal(ov.session.expiresAt, 1_700_000_000_000 + ADMIN_SESSION_TTL_MS);
    assert.ok(!/secret/i.test(JSON.stringify(ov)), 'and it never carries the secret');
  } finally { await srv.close(); }
});
