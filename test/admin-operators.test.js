// 运维账号后台 (docs/ADMIN.md): several operators work with their OWN account instead of one shared secret. The
// assertions cover the identity contract — an account logs in with its own password, the console knows WHO is acting,
// a published announcement records that identity in `author` (players see it), account management is OWNER-only, and
// a password reset / ban / deletion ends that operator's sessions at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';

const SECRET = 'unit-test-admin-secret-value';

async function makeServer() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stronghold-admin-op-'));
  const srv = await startServer({
    port: 0, host: '127.0.0.1', quiet: true, adminSecret: SECRET,
    announcementsDir: path.join(dir, 'announcements'),
    serverSettingsDir: path.join(dir, 'runtime'),
    adminAccountsFile: path.join(dir, 'runtime', 'admin-accounts.json'),
  });
  const close = srv.close.bind(srv);
  srv.close = async () => { await close(); await rm(dir, { recursive: true, force: true }); };
  srv.dir = dir;
  return srv;
}

async function call(base, path, { method = 'GET', body, cookie, bearer } = {}) {
  const headers = { connection: 'close' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(base + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, text, json, setCookie: res.headers.get('set-cookie') };
}

/** Owner login (the shared secret). */
async function ownerCookie(base) {
  const res = await call(base, '/api/admin/login', { method: 'POST', body: { secret: SECRET } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.identity.kind, 'owner');
  return String(res.setCookie).split(';')[0];
}

/** Operator-account login. */
async function accountCookie(base, id, password) {
  const res = await call(base, '/api/admin/login', { method: 'POST', body: { id, password } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.identity.kind, 'account');
  assert.equal(res.json.identity.id, id);
  return String(res.setCookie).split(';')[0];
}

async function createOperator(base, cookie, id, password, name) {
  const res = await call(base, '/api/admin/operators/create', { method: 'POST', cookie, body: { id, password, name } });
  assert.equal(res.status, 200, `${id}: ${res.text}`);
  return res.json;
}

test('an operator account logs in with its own password and the session says who is acting', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const owner = await ownerCookie(base);
    await createOperator(base, owner, 'alice', 'alice-password-1', '小爱');

    const alice = await accountCookie(base, 'alice', 'alice-password-1');
    const session = await call(base, '/api/admin/session', { cookie: alice });
    assert.equal(session.status, 200, session.text);
    assert.deepEqual(session.json.identity, { kind: 'account', id: 'alice', name: '小爱' });

    // A wrong password and a disabled account are refused; an unknown id is refused the same way.
    assert.equal((await call(base, '/api/admin/login', { method: 'POST', body: { id: 'alice', password: 'wrong' } })).status, 401);
    assert.equal((await call(base, '/api/admin/login', { method: 'POST', body: { id: 'nobody', password: 'whatever1' } })).status, 401);
    // The console's single input fills BOTH fields, so an account login that carries the credential only as `secret`
    // (what the panel used to send) must work exactly like the documented `{ id, password }` shape.
    const secretField = await call(base, '/api/admin/login', { method: 'POST', body: { id: 'alice', secret: 'alice-password-1' } });
    assert.equal(secretField.status, 200, secretField.text);
    assert.equal(secretField.json.identity.id, 'alice');
    // The console itself works with an account session (no shared secret needed).
    assert.equal((await call(base, '/api/admin/overview', { cookie: alice })).status, 200);
    assert.equal((await call(base, '/api/admin/rooms', { cookie: alice })).status, 200);
  } finally { await srv.close(); }
});

test('a published announcement records the operator, and players see the id in small type', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const owner = await ownerCookie(base);
    await createOperator(base, owner, 'bob', 'bob-password-1');
    const bob = await accountCookie(base, 'bob', 'bob-password-1');

    const published = await call(base, '/api/admin/announcements/publish', {
      method: 'POST', cookie: bob, body: { id: 'welcome', title: '开服公告', markdown: '正文。' },
    });
    assert.equal(published.status, 200, published.text);
    assert.equal(published.json.item.author, 'bob');

    // The PUBLIC payload carries the author: the client shows it under the title.
    const list = await call(base, '/api/announcements');
    assert.equal(list.json.items[0].author, 'bob');
    const detail = await call(base, '/api/announcements/welcome');
    assert.equal(detail.json.author, 'bob');

    // A correction keeps the original publishing operator, and the id/date/position survive.
    const before = (await call(base, '/api/announcements')).json.items[0];
    const fixed = await call(base, '/api/admin/announcements/update', {
      method: 'POST', cookie: bob, body: { id: 'welcome', title: '开服公告（改）', markdown: '改过的正文。' },
    });
    assert.equal(fixed.status, 200, fixed.text);
    const after = (await call(base, '/api/announcements')).json.items[0];
    assert.equal(after.author, 'bob');
    assert.equal(after.publishedAt, before.publishedAt);
    assert.notEqual(after.revision, before.revision);
    assert.equal((await call(base, '/api/announcements/welcome')).json.markdown, '改过的正文。');

    // A publication by the owner (bearer) is attributed to the owner; the CLI keeps author null.
    const ownerPub = await call(base, '/api/admin/announcements/publish', {
      method: 'POST', bearer: SECRET, body: { id: 'ops', title: '运维提示', markdown: 'x' },
    });
    assert.equal(ownerPub.json.item.author, 'owner');
  } finally { await srv.close(); }
});

test('account management is owner-only, and a reset / ban / delete ends that operator sessions', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const owner = await ownerCookie(base);
    const created = await createOperator(base, owner, 'carol', 'carol-password-1');
    assert.deepEqual(created.account, { id: 'carol', name: 'carol', createdAt: created.account.createdAt, disabled: false, lastLoginAt: null });

    const carol = await accountCookie(base, 'carol', 'carol-password-1');

    // A non-owner identity may use the console but must not touch the account list.
    const forbidden = await call(base, '/api/admin/operators', { cookie: carol });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json.error, 'OWNER_ONLY');
    for (const leaf of ['/operators/create', '/operators/password', '/operators/disabled', '/operators/delete']) {
      assert.equal((await call(base, `/api/admin${leaf}`, { method: 'POST', cookie: carol, body: { id: 'carol', password: 'x' } })).status, 403);
    }

    // The owner sees the account list without any credential material.
    const list = await call(base, '/api/admin/operators', { cookie: owner });
    assert.equal(list.status, 200, list.text);
    assert.equal(list.json.total, 1);
    assert.equal(list.json.accounts[0].id, 'carol');
    assert.equal(JSON.stringify(list.json).includes('passwordHash'), false);

    // Resetting the password drops the sessions: the old cookie stops working, the new one works.
    const reset = await call(base, '/api/admin/operators/password', { method: 'POST', cookie: owner, body: { id: 'carol', password: 'carol-password-2' } });
    assert.equal(reset.status, 200, reset.text);
    assert.equal((await call(base, '/api/admin/session', { cookie: carol })).status, 401);
    const carol2 = await accountCookie(base, 'carol', 'carol-password-2');

    // Disabling also drops the sessions, and the account cannot log in again until it is re-enabled.
    const off = await call(base, '/api/admin/operators/disabled', { method: 'POST', cookie: owner, body: { id: 'carol', disabled: true } });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.account.disabled, true);
    assert.equal((await call(base, '/api/admin/session', { cookie: carol2 })).status, 401);
    assert.equal((await call(base, '/api/admin/login', { method: 'POST', body: { id: 'carol', password: 'carol-password-2' } })).status, 401);
    const on = await call(base, '/api/admin/operators/disabled', { method: 'POST', cookie: owner, body: { id: 'carol', disabled: false } });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.account.disabled, false);
    assert.equal((await call(base, '/api/admin/login', { method: 'POST', body: { id: 'carol', password: 'carol-password-2' } })).status, 200);

    // Deleting ends the sessions and frees the id for a new account.
    const carol3 = await accountCookie(base, 'carol', 'carol-password-2');
    const del = await call(base, '/api/admin/operators/delete', { method: 'POST', cookie: owner, body: { id: 'carol' } });
    assert.equal(del.status, 200, del.text);
    assert.equal((await call(base, '/api/admin/session', { cookie: carol3 })).status, 401);
    assert.equal((await call(base, '/api/admin/operators/delete', { method: 'POST', cookie: owner, body: { id: 'carol' } })).status, 404);
    await createOperator(base, owner, 'carol', 'carol-password-3');

    // The account file is persisted outside the served tree and carries no plaintext password.
    const raw = await readFile(path.join(srv.dir, 'runtime', 'admin-accounts.json'), 'utf8');
    assert.equal(raw.includes('carol-password-3'), false);
    assert.equal(JSON.parse(raw).version, 1);
    assert.equal(Object.keys(JSON.parse(raw).accounts).length, 1);
  } finally { await srv.close(); }
});

test('operator input is validated and a failure never takes the console down', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const owner = await ownerCookie(base);
    const bad = [
      { id: 'ab', password: 'long-enough-1' },              // too short
      { id: 'Bad ID!', password: 'long-enough-1' },
      { id: 'dave', password: 'short' },                    // password too short
      { id: 'dave', password: 'long-enough-1', name: '  ' },// blank display name
    ];
    for (const body of bad) {
      const res = await call(base, '/api/admin/operators/create', { method: 'POST', cookie: owner, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    await createOperator(base, owner, 'dave', 'dave-password-1');
    assert.equal((await call(base, '/api/admin/operators/create', { method: 'POST', cookie: owner, body: { id: 'dave', password: 'dave-password-1' } })).status, 400);
    assert.equal((await call(base, '/api/admin/operators/create', { method: 'POST', cookie: owner, body: { id: 'eve', password: 'eve-password-1' } })).status, 200);
    // The console keeps answering after every refusal.
    assert.equal((await call(base, '/api/admin/overview', { cookie: owner })).status, 200);
    assert.equal((await call(base, '/api/admin/operators', { cookie: owner })).json.total, 2);
  } finally { await srv.close(); }
});
