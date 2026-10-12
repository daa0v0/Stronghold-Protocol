// 运维后台 (docs/ADMIN.md): the operator console's HTTP surface. The point of most of these assertions is the SAFETY
// contract — no secret means no console at all, the secret never reaches a client, the console keeps working while the
// server protects itself, and every write is bounded and throttled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { ADMIN_MIN_SECRET_LEN, ADMIN_RECOMMENDED_SECRET_LEN } from '../server/admin.js';
import { TestClient } from './helpers/wsClient.js';

const SECRET = 'unit-test-admin-secret-value';
/** A path no machine has a secret at: the default source (docs/ADMIN.md §2) must not leak in from the developer's box. */
const NO_SECRET_FILE = path.join(os.tmpdir(), 'sp-admin-test-no-such-secret');

/** Start a server on a random port, optionally with the console enabled. */
async function makeServer(opts = {}) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, adminSecret: opts.adminSecret ?? '',
    adminSecretFile: opts.adminSecretFile ?? NO_SECRET_FILE, ...opts.extra });
  return srv;
}

/** @param {string} base @param {string} path */
async function call(base, path, { method = 'GET', body, cookie, bearer, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(base + path, {
    method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, text, json, setCookie: res.headers.get('set-cookie') };
}

/** Log in and return the cookie. */
async function login(base) {
  const res = await call(base, '/api/admin/login', { method: 'POST', body: { secret: SECRET } });
  assert.equal(res.status, 200);
  return String(res.setCookie).split(';')[0];
}

test('no ADMIN_SECRET: the console does not exist (no default password)', async () => {
  const srv = await makeServer();
  try {
    assert.equal(srv.admin.status().enabled, false);
    assert.match(srv.admin.status().problem, /ADMIN_SECRET/);
    for (const path of ['/admin', '/admin/', '/admin/admin.js', '/api/admin/overview', '/api/admin/login']) {
      assert.equal((await call(srv.url, path)).status, 404, `${path} must not exist`);
    }
    // the game is unaffected
    assert.equal((await call(srv.url, '/healthz')).status, 200);
  } finally { await srv.close(); }
});

test('a short secret is refused, so the console stays off', async () => {
  const srv = await makeServer({ adminSecret: 'short' });
  try {
    assert.equal(srv.admin.status().enabled, false);
    assert.match(srv.admin.status().problem, new RegExp(String(ADMIN_MIN_SECRET_LEN)));
    assert.equal((await call(srv.url, '/api/admin/overview')).status, 404);
  } finally { await srv.close(); }
});

test('a password-length secret is accepted: warned about once, never refused', async () => {
  // The user's point: the console is protected by a password, so the minimum has to be one. Six characters is the floor
  // (well under what the per-address login throttle could be walked through), twelve is where the warning stops.
  const logs = [];
  const capture = { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: () => {} };
  const password = 'abc123';
  assert.ok(password.length >= ADMIN_MIN_SECRET_LEN && password.length < ADMIN_RECOMMENDED_SECRET_LEN);
  const srv = await makeServer({ adminSecret: password, extra: { log: capture } });
  try {
    assert.equal(srv.admin.status().enabled, true, 'a 6-character password opens the console');
    const login = await call(srv.url, '/api/admin/login', { method: 'POST', body: { secret: password } });
    assert.equal(login.status, 200, 'and it logs in');
    const warn = String(logs.find((l) => l.includes('只有')));
    assert.match(warn, /只有 6 个字符/);
    assert.match(warn, /公网/, 'and says where it is not enough');
  } finally { await srv.close(); }
});

test('the console logs WHY it is off, so a 404 is never the only symptom', async () => {
  // The 404 is deliberate and must look like any other unknown path (docs/ADMIN.md §1), which leaves the console as the
  // only place that can explain it. Reported by a user who saw "404 Not found" and had nothing to go on.
  const logs = [];
  const capture = { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
  const line = () => String(logs.find((l) => l.includes('[admin]')));
  const saved = { s: process.env.ADMIN_SECRET, f: process.env.ADMIN_SECRET_FILE };
  delete process.env.ADMIN_SECRET;
  delete process.env.ADMIN_SECRET_FILE;
  try {
    const off = await makeServer({ adminSecret: undefined, extra: { log: capture } });
    await off.close();
    assert.match(line(), /后台关闭/, 'the reason is stated in the console');
    assert.match(line(), /ADMIN_SECRET/, 'and names the variable that is missing');
    assert.match(line(), /ADMIN\.md/, 'and where to read how to turn it on');

    logs.length = 0;
    process.env.ADMIN_SECRET = 'x'.repeat(32);
    const on = await makeServer({ adminSecret: undefined, extra: { log: capture } });
    await on.close();
    assert.match(line(), /后台已启用/, 'and an enabled console says so too');
    assert.match(line(), /ADMIN_SECRET/, 'naming where the secret came from');
  } finally {
    if (saved.s === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = saved.s;
    if (saved.f === undefined) delete process.env.ADMIN_SECRET_FILE; else process.env.ADMIN_SECRET_FILE = saved.f;
  }
});

test('the secret can come from ADMIN_SECRET_FILE (systemd credentials / docker secrets)', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sp-admin-secret-'));
  const file = path.join(dir, 'secret');
  writeFileSync(file, `${SECRET}\n`);
  const previous = process.env.ADMIN_SECRET_FILE;
  process.env.ADMIN_SECRET_FILE = file;
  const srv = await makeServer({ adminSecret: undefined, extra: { adminSecret: undefined } });
  try {
    // makeServer passes adminSecret: '' which means "use the environment"
    assert.equal(srv.admin.status().enabled, true);
    assert.equal(srv.admin.status().secretSource, 'file');
    assert.equal((await call(srv.url, '/api/admin/overview', { bearer: SECRET })).status, 200);
  } finally {
    await srv.close();
    if (previous === undefined) delete process.env.ADMIN_SECRET_FILE; else process.env.ADMIN_SECRET_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('login flow: 401 without, 401 on a wrong secret, cookie (HttpOnly, SameSite=Strict) on success, logout clears', async () => {
  const srv = await makeServer({ adminSecret: SECRET });
  try {
    const unauth = await call(srv.url, '/api/admin/overview');
    assert.equal(unauth.status, 401);
    assert.equal(unauth.json.error, 'UNAUTHORIZED');
    assert.equal(unauth.text.includes(SECRET), false, 'the secret must never appear in a response');

    const wrong = await call(srv.url, '/api/admin/login', { method: 'POST', body: { secret: 'x'.repeat(24) } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error, 'BAD_SECRET');

    const cookie = await login(srv.url);
    assert.match(cookie, /^sp_admin=[0-9a-f]{48}$/);
    assert.equal(cookie.includes(SECRET), false, 'the cookie must not carry the secret');

    const res = await call(srv.url, '/api/admin/login', { method: 'POST', body: { secret: SECRET } });
    assert.match(String(res.setCookie), /HttpOnly/);
    assert.match(String(res.setCookie), /SameSite=Strict/);
    assert.match(String(res.setCookie), /Path=\//);

    assert.equal((await call(srv.url, '/api/admin/overview', { cookie })).status, 200);
    assert.equal((await call(srv.url, '/api/admin/overview', { bearer: SECRET })).status, 200);

    const out = await call(srv.url, '/api/admin/logout', { method: 'POST', body: {} });
    assert.equal(out.status, 200);
    assert.match(String(out.setCookie), /sp_admin=;/);
  } finally { await srv.close(); }
});

test('repeated wrong secrets are throttled (429 + Retry-After)', async () => {
  const srv = await makeServer({ adminSecret: SECRET });
  try {
    let last = null;
    for (let i = 0; i < 9; i++) last = await call(srv.url, '/api/admin/login', { method: 'POST', body: { secret: 'bad-' + i } });
    assert.equal(last.status, 429);
    assert.equal(last.json.error, 'TOO_MANY_ATTEMPTS');
    // the correct secret is refused too while the window holds: the throttle is on the source, not on the guess
    assert.equal((await call(srv.url, '/api/admin/login', { method: 'POST', body: { secret: SECRET } })).status, 429);
  } finally { await srv.close(); }
});

test('the console shell is served and its files exist', async () => {
  const srv = await makeServer({ adminSecret: SECRET });
  try {
    const page = await call(srv.url, '/admin');
    assert.equal(page.status, 200);
    assert.match(page.text, /运维后台/);
    assert.match(page.text, /\/admin\/admin\.js/);
    for (const asset of ['/admin/admin.js', '/admin/admin.css']) {
      assert.equal((await call(srv.url, asset)).status, 200, asset);
    }
    // /admin/ is the same page
    assert.equal((await call(srv.url, '/admin/')).status, 200);
  } finally { await srv.close(); }
});

test('overview reports the host, the lobby counters and never the secret', async () => {
  const srv = await makeServer({ adminSecret: SECRET });
  try {
    const cookie = await login(srv.url);
    const { status, json, text } = await call(srv.url, '/api/admin/overview', { cookie });
    assert.equal(status, 200);
    assert.equal(text.includes(SECRET), false);
    assert.equal(json.version.app, '0.2.4');
    assert.equal(typeof json.version.build, 'string');
    assert.equal(json.version.node, process.version);
    assert.equal(typeof json.host.hostname, 'string');
    assert.equal(typeof json.process.rssMb, 'number');
    assert.deepEqual(Object.keys(json.lobby).sort(), ['bots', 'humans', 'matches', 'rooms', 'spectators']);
    assert.equal(json.lobby.rooms, 0);
    assert.deepEqual(json.network.connections, 0);
    assert.equal(typeof json.logs.buffered, 'number');
    assert.equal(json.maintenance.active, false);
  } finally { await srv.close(); }
});

test('rooms list a real room, with its capacity and the running match’s fixed groups', async () => {
  const srv = await makeServer({ adminSecret: SECRET });
  const client = await TestClient.connect(srv.url.replace('http', 'ws') + '/ws');
  try {
    await client.hello('ConsoleProbe');
    await client.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 20 });
    await client.waitFor('room.state');
    const cookie = await login(srv.url);

    let { json } = await call(srv.url, '/api/admin/rooms', { cookie });
    assert.equal(json.rooms.length, 1);
    const room = json.rooms[0];
    assert.equal(room.capacity, 20);
    assert.equal(room.mode, 'coop');
    assert.equal(room.difficulty, 'NORMAL');
    assert.equal(room.humans, 1);
    assert.equal(room.bots, 0);
    assert.equal(room.inMatch, false);
    assert.equal(room.seats.length, 20);
    assert.equal(room.seats[0].name, 'ConsoleProbe');
    assert.equal(room.phase, undefined, 'no match yet → no phase');

    // start it: the console then shows the phase and the fixed A–E groups
    await client.request({ t: 'room.ready', ready: true });
    await client.request({ t: 'room.start' });
    await client.waitFor('m.public', (m) => Array.isArray(m.players), 8000);
    ({ json } = await call(srv.url, '/api/admin/rooms', { cookie }));
    const live = json.rooms[0];
    assert.equal(live.inMatch, true);
    assert.equal(typeof live.phase, 'string');
    assert.equal(live.poolGroups.length, 1, 'one human → one pool group');
    assert.deepEqual(live.poolGroups[0].playerIds.length, 1);
  } finally { await client.close(); await srv.close(); }
});

test('closing a room from the console returns its players to the lobby', async () => {
  const srv = await makeServer({ adminSecret: SECRET });
  const client = await TestClient.connect(srv.url.replace('http', 'ws') + '/ws');
  try {
    await client.hello('Evicted');
    const created = await client.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
    assert.equal(created.t, 'ok');
    const state = await client.waitFor('room.state');
    const cookie = await login(srv.url);
    const res = await call(srv.url, '/api/admin/rooms/close', { method: 'POST', body: { code: state.code }, cookie });
    assert.equal(res.status, 200);
    const closed = await client.waitFor('room.closed', () => true, 4000);
    assert.equal(closed.reason, 'admin');
    const { json } = await call(srv.url, '/api/admin/rooms', { cookie });
    assert.deepEqual(json.rooms, []);
    const missing = await call(srv.url, '/api/admin/rooms/close', { method: 'POST', body: { code: 'ZZZZ' }, cookie });
    assert.equal(missing.status, 404);
  } finally { await client.close(); await srv.close(); }
});

test('broadcast reaches every connected client as a toast and a ticker line', async () => {
  const srv = await makeServer({ adminSecret: SECRET });
  const a = await TestClient.connect(srv.url.replace('http', 'ws') + '/ws');
  const b = await TestClient.connect(srv.url.replace('http', 'ws') + '/ws');
  try {
    await a.hello('Alice');
    await b.hello('Bob');
    const cookie = await login(srv.url);
    const res = await call(srv.url, '/api/admin/broadcast', { method: 'POST', body: { text: '22:30 维护重启', kind: 'warn' }, cookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.connections, 2);
    for (const client of [a, b]) {
      const toast = await client.waitFor('m.toast', (m) => m.text === '22:30 维护重启', 4000);
      assert.equal(toast.kind, 'warn');
      const ticker = await client.waitFor('m.ticker', (m) => m.text === '22:30 维护重启', 4000);
      assert.equal(ticker.type, 'CUSTOM');
      assert.equal(ticker.playerId, null);
    }
    const empty = await call(srv.url, '/api/admin/broadcast', { method: 'POST', body: { text: '   ' }, cookie });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error, 'EMPTY_TEXT');
    const tooLong = await call(srv.url, '/api/admin/broadcast', { method: 'POST', body: { text: 'x'.repeat(400) }, cookie });
    assert.equal(tooLong.status, 200, 'a long message is truncated, not refused');
    assert.equal((await a.waitFor('m.ticker', (m) => m.text.length === 200, 4000)).text.length, 200);
  } finally { await a.close(); await b.close(); await srv.close(); }
});

test('maintenance mode: public traffic is refused, the console keeps working, and it does not auto-resume', async () => {
  const srv = await makeServer({ adminSecret: SECRET });
  const client = await TestClient.connect(srv.url.replace('http', 'ws') + '/ws');
  try {
    await client.hello('Frozen');
    const cookie = await login(srv.url);
    assert.equal((await call(srv.url, '/api/announcements')).status, 200);

    const on = await call(srv.url, '/api/admin/maintenance', { method: 'POST', body: { on: true }, cookie });
    assert.equal(on.status, 200);
    assert.deepEqual(on.json, { ok: true, active: true });
    await new Promise((r) => setTimeout(r, 250)); // the switch is applied after the answer is flushed

    assert.equal((await call(srv.url, '/api/announcements')).status, 503, 'public traffic refused');
    assert.equal((await call(srv.url, '/healthz')).status, 200, 'health checks keep working for the orchestrator');
    const overview = await call(srv.url, '/api/admin/overview', { cookie });
    assert.equal(overview.status, 200, 'the operator keeps the console');
    assert.equal(overview.json.maintenance.active, true);
    assert.equal(overview.json.maintenance.reason, 'maintenance');
    assert.equal(overview.json.maintenance.source, 'admin');
    assert.equal(overview.json.maintenance.retryAt, 0, 'a maintenance window has no automatic end');

    // the maintenance freeze is announced to clients through the server's own emergency frame
    const frame = await client.waitFor('m.emergency', (m) => m.active === true, 4000);
    assert.equal(frame.reason, 'maintenance');

    const off = await call(srv.url, '/api/admin/maintenance', { method: 'POST', body: { on: false }, cookie });
    assert.equal(off.status, 200);
    assert.equal((await call(srv.url, '/api/announcements')).status, 200, 'public traffic restored');
    assert.equal((await call(srv.url, '/api/admin/overview', { cookie })).json.maintenance.active, false);

    const bad = await call(srv.url, '/api/admin/maintenance', { method: 'POST', body: {}, cookie });
    assert.equal(bad.status, 400);
  } finally { await client.close(); await srv.close(); }
});

test('logs: the ring captures the server’s own lines and `since` returns only newer ones', async () => {
  const srv = await makeServer({ adminSecret: SECRET });
  try {
    const cookie = await login(srv.url);
    // make the server log something (creating and disposing an empty room logs a line)
    const client = await TestClient.connect(srv.url.replace('http', 'ws') + '/ws');
    await client.hello('LogProbe');
    await client.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
    await client.waitFor('room.state');
    await client.close();
    await new Promise((r) => setTimeout(r, 300));

    const all = await call(srv.url, '/api/admin/logs?since=0&limit=200', { cookie });
    assert.equal(all.status, 200);
    assert.ok(all.json.entries.length > 0);
    assert.ok(all.json.nextSeq >= all.json.entries.length);
    const entry = all.json.entries.at(-1);
    assert.equal(typeof entry.seq, 'number');
    assert.equal(typeof entry.at, 'number');
    assert.ok(['info', 'warn', 'error', 'debug'].includes(entry.level));
    assert.equal(typeof entry.text, 'string');

    const newer = await call(srv.url, '/api/admin/logs?since=' + all.json.nextSeq, { cookie });
    assert.deepEqual(newer.json.entries, [], 'nothing after the last seq');
    assert.equal(newer.json.nextSeq, all.json.nextSeq);
  } finally { await srv.close(); }
});

test('the console refuses bad input and unknown endpoints', async () => {
  const srv = await makeServer({ adminSecret: SECRET });
  try {
    const cookie = await login(srv.url);
    const big = await call(srv.url, '/api/admin/broadcast', { method: 'POST', cookie, raw: JSON.stringify({ text: 'x'.repeat(9000) }) });
    assert.equal(big.status, 413);
    const malformed = await call(srv.url, '/api/admin/broadcast', { method: 'POST', cookie, raw: 'not json' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.error, 'BAD_BODY');
    const unknown = await call(srv.url, '/api/admin/nope', { cookie });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error, 'NOT_FOUND');
    const method = await call(srv.url, '/api/admin/overview', { method: 'PUT', cookie });
    assert.equal(method.status, 405);
    const uiMethod = await call(srv.url, '/admin', { method: 'POST', body: {} });
    assert.equal(uiMethod.status, 405);
  } finally { await srv.close(); }
});
