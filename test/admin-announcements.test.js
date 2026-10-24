// 公告管理后台 (docs/ADMIN.md): the operator's announcement console. The assertions cover the SAFETY contract first —
// the console needs the admin secret like every other admin route, and no deployment without announcements answers a
// plausible-looking empty list — then the store contract that must survive adding an HTTP writer: an id is never
// reused (a correction goes through update), the index stays hash-verified, pinning is exclusive, and a notice reaches
// the running server's spool rather than a second send path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { ANNOUNCEMENT_INDEX_FILE } from '../shared/announcements.js';
import { ANNOUNCEMENT_NOTICE_COMMAND_DIR } from '../server/announcementNotices.js';

const SECRET = 'unit-test-admin-secret-value';

/**
 * Start a server on a random port with the console enabled. Every server gets its OWN announcements directory: the
 * index and the notice spool live there, and a shared one would make the tests see each other's notices.
 */
async function makeServer(opts = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stronghold-admin-ann-'));
  const srv = await startServer({
    port: 0, host: '127.0.0.1', quiet: true, adminSecret: opts.adminSecret ?? SECRET,
    announcementsDir: path.join(dir, 'announcements'),
    serverSettingsDir: path.join(dir, 'runtime'),
    ...opts.extra,
  });
  const close = srv.close.bind(srv);
  srv.close = async () => { await close(); await rm(dir, { recursive: true, force: true }); };
  srv.dir = dir;
  return srv;
}

/** @param {string} base @param {string} path */
async function call(base, path, { method = 'GET', body, cookie, bearer, raw } = {}) {
  const headers = { connection: 'close' };
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

async function login(base) {
  const res = await call(base, '/api/admin/login', { method: 'POST', body: { secret: SECRET } });
  assert.equal(res.status, 200);
  return String(res.setCookie).split(';')[0];
}

test('the announcement console needs the admin secret', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    // Unauthenticated reads AND writes are both refused: a guessable id must not be enough to publish.
    assert.equal((await call(base, '/api/admin/announcements')).status, 401);
    assert.equal((await call(base, '/api/admin/announcements/pin', { method: 'POST', body: { id: 'x' } })).status, 401);
    assert.equal((await call(base, '/api/admin/announcements/publish', {
      method: 'POST', body: { title: 't', markdown: 'm' },
    })).status, 401);
    // A bearer token is accepted too (scripts and curl).
    const list = await call(base, '/api/admin/announcements', { bearer: SECRET });
    assert.equal(list.status, 200);
    assert.equal(list.json.ok, true);
    assert.deepEqual(list.json.items, []);
  } finally { await srv.close(); }
});

test('publish, pin and unpin go through the shared store and keep the index hash-verified', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const cookie = await login(base);

    const published = await call(base, '/api/admin/announcements/publish', {
      method: 'POST', cookie, body: { title: '开服公告', markdown: '## 欢迎\n\n今晚维护。', pin: true },
    });
    assert.equal(published.status, 200, published.text);
    // The server generated the id (the console leaves it blank on purpose): `ann-<base36 time>-<uuid prefix>`.
    assert.match(published.json.item.id, /^ann-[0-9a-z]+-[0-9a-f-]{9,}$/);
    assert.equal(published.json.item.title, '开服公告');

    const listed = await call(base, '/api/admin/announcements', { cookie });
    assert.equal(listed.json.items.length, 1);
    assert.equal(listed.json.pinnedId, published.json.item.id);
    assert.equal(listed.json.items[0].pinned, true);

    // Pinning another one moves the pin; at most one announcement is ever pinned.
    const second = await call(base, '/api/admin/announcements/publish', {
      method: 'POST', cookie, body: { id: 'maintenance-1', title: '维护', markdown: '今晚 02:00 维护。' },
    });
    assert.equal(second.status, 200, second.text);
    const pinned = await call(base, '/api/admin/announcements/pin', { method: 'POST', cookie, body: { id: 'maintenance-1' } });
    assert.equal(pinned.status, 200, pinned.text);
    const afterPin = await call(base, '/api/admin/announcements', { cookie });
    assert.equal(afterPin.json.pinnedId, 'maintenance-1');
    assert.equal(afterPin.json.items.filter((i) => i.pinned).length, 1);

    const unpinned = await call(base, '/api/admin/announcements/unpin', { method: 'POST', cookie, body: {} });
    assert.equal(unpinned.status, 200);
    assert.equal((await call(base, '/api/admin/announcements', { cookie })).json.pinnedId, null);

    // The on-disk index carries the sha256 of each body: an HTTP publish leaves the CLI's verification intact.
    const indexPath = path.join(srv.dir, 'announcements', ANNOUNCEMENT_INDEX_FILE);
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    assert.equal(index.items.length, 2);
    for (const item of index.items) {
      const body = await readFile(path.join(srv.dir, 'announcements', `${item.id}.md`));
      assert.equal(body.length, item.bytes, `${item.id} byte count`);
      assert.equal(createHash('sha256').update(body).digest('hex'), item.sha256, `${item.id} sha256`);
    }
  } finally { await srv.close(); }
});

test('an id is never reused, update corrects it in place, and bad input is refused without taking the server down', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const cookie = await login(base);

    const first = await call(base, '/api/admin/announcements/publish', {
      method: 'POST', cookie, body: { id: 'welcome', title: '开服', markdown: '正文' },
    });
    assert.equal(first.status, 200, first.text);

    // Publishing the same id again is refused: a publication is permanent, a correction goes through update.
    const again = await call(base, '/api/admin/announcements/publish', {
      method: 'POST', cookie, body: { id: 'welcome', title: '改了', markdown: '别的正文' },
    });
    assert.equal(again.status, 400);
    assert.match(again.json.error, /已存在/);

    // update corrects the title and the body; the id, the date and the position survive.
    const fixed = await call(base, '/api/admin/announcements/update', {
      method: 'POST', cookie, body: { id: 'welcome', title: '开服（已修正）', markdown: '改好的正文。' },
    });
    assert.equal(fixed.status, 200, fixed.text);
    const read = await call(base, `/api/admin/announcements?id=welcome`, { cookie });
    assert.equal(read.status, 200, read.text);
    assert.equal(read.json.item.title, '开服（已修正）');
    assert.equal(read.json.item.markdown, '改好的正文。');
    assert.equal(read.json.item.publishedAt, first.json.item.publishedAt);
    assert.notEqual(read.json.item.revision, first.json.item.revision, 'a correction moves the revision');
    // The newest publication is the catalog revision, so a correction of it re-notifies players.
    assert.equal((await call(base, '/api/admin/announcements', { cookie })).json.revision, read.json.item.revision);

    // Refused: unknown id, empty title, empty body, an illegal id, pinning something that does not exist, notifying an unknown id.
    const badUpdate = [
      { id: 'nope', title: '标题', markdown: 'x' },
      { id: 'welcome', title: '', markdown: 'x' },
      { id: 'welcome', title: '标题', markdown: '   ' },
      { id: 'Bad ID!', title: '标题', markdown: 'x' },
    ];
    for (const body of badUpdate) {
      const res = await call(base, '/api/admin/announcements/update', { method: 'POST', cookie, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const badPublish = [
      { id: 'a', title: '', markdown: 'x' },
      { id: 'b', title: '标题', markdown: '   ' },
      { id: 'Bad ID!', title: '标题', markdown: 'x' },
    ];
    for (const body of badPublish) {
      const res = await call(base, '/api/admin/announcements/publish', { method: 'POST', cookie, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await call(base, '/api/admin/announcements/pin', { method: 'POST', cookie, body: { id: 'nope' } })).status, 400);
    assert.equal((await call(base, '/api/admin/announcements/notify', { method: 'POST', cookie, body: { id: 'nope' } })).status, 400);

    // Every one of those left the server answering, and the correction itself survived.
    assert.equal((await call(base, '/healthz')).status, 200);
    const final = await call(base, '/api/admin/announcements', { cookie });
    assert.equal(final.json.items.length, 1);
    assert.equal(final.json.items[0].title, '开服（已修正）');
  } finally { await srv.close(); }
});

test('notify writes the spool command the running server polls', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const cookie = await login(base);
    await call(base, '/api/admin/announcements/publish', {
      method: 'POST', cookie, body: { id: 'maintenance', title: '维护', markdown: '立即维护' },
    });

    const res = await call(base, '/api/admin/announcements/notify', { method: 'POST', cookie, body: { id: 'maintenance' } });
    assert.equal(res.status, 200, res.text);
    assert.ok(res.json.msgid, 'a message id comes back so the operator can correlate');

    // The command landed in the on-disk spool — the same channel tools/announcements.mjs uses, not a second send path.
    const dir = path.join(srv.dir, 'announcements', ANNOUNCEMENT_NOTICE_COMMAND_DIR);
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    const command = JSON.parse(await readFile(path.join(dir, files[0]), 'utf8'));
    assert.equal(command.id, 'maintenance');
    assert.equal(command.version, 1);
  } finally { await srv.close(); }
});

test('a large Markdown body is accepted on publish but the generic write cap still holds elsewhere', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const cookie = await login(base);

    // Well past the 8 KB generic cap: publishing carries a document, so this leaf gets the wider limit.
    const big = '维护通知。\n\n' + '细节说明。'.repeat(3000);
    assert.ok(Buffer.byteLength(big) > 8 * 1024);
    const published = await call(base, '/api/admin/announcements/publish', {
      method: 'POST', cookie, body: { title: '长公告', markdown: big },
    });
    assert.equal(published.status, 200, published.text.slice(0, 200));

    // An unrelated write endpoint still refuses an oversized body — publish must not widen it for everyone.
    const overflow = await call(base, '/api/admin/rooms/close', { method: 'POST', cookie, raw: JSON.stringify({ code: 'x'.repeat(9000) }) });
    assert.equal(overflow.status, 413);

    // And publish itself refuses an absurd one rather than buffering it (raw: fetch will not send a 400 KB string body).
    const huge = await call(base, '/api/admin/announcements/publish', {
      method: 'POST', cookie, raw: JSON.stringify({ title: 'x', markdown: 'y'.repeat(100 * 1024) }),
    });
    assert.equal(huge.status, 413);
    assert.equal((await call(base, '/healthz')).status, 200);
  } finally { await srv.close(); }
});

test('the catalog is read-only over GET: an unknown endpoint or a wrong method is refused', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const cookie = await login(base);
    // A known leaf with the wrong method is 405, not 404: the operator can tell a typo from a mistake.
    assert.equal((await call(base, '/api/admin/announcements', { method: 'POST', cookie, body: {} })).status, 405);
    assert.equal((await call(base, '/api/admin/announcements/publish', { cookie })).status, 405);
    // An unknown leaf below the prefix stays 404.
    assert.equal((await call(base, '/api/admin/announcements/delete', { method: 'POST', cookie, body: { id: 'welcome' } })).status, 404);
  } finally { await srv.close(); }
});