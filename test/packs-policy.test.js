// The owner's content-pack policy (docs/PACKS.md §4): which packs a server loads at all, and which incompatible one the
// owner has confirmed. Set through the shared settings file — `runtime/server-settings.json`, written by the CLI or, for
// this one setting, by the /admin 内容包 panel (server/admin.js) — and applied by the registry on the next scan.
//
// What matters here: a pack turned off never loads, is never served and leaves the content tag; an incompatible pack that
// changes the game is held back until it is confirmed, while an incompatible *language* pack keeps loading (it only
// changes text, and the strings it lacks fall back); and a policy change takes effect although no pack file changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isIdentityPack } from '../shared/contentTag.js';
import { createPackRegistry, scanPacks } from '../server/packs.js';
import { createServerSettings, readServerSettings, writeServerSettings, validPackPolicy, SERVER_SETTINGS_FILE } from '../server/serverSettings.js';import { startServer } from '../server/index.js';

const APP = '0.2.4';
const SECRET = 'a'.repeat(32);

const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sp-policy-${tag}-`));
const put = (dir, rel, body) => {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};
const dirsOf = (root) => ({ publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), packsDir: path.join(root, 'packs') });
const silent = { info() {}, warn() {}, error() {} };

/** A tree with a compatible assets pack, a data pack, an incompatible assets pack and an incompatible language pack. */
function policyRoot() {
  const root = tmpdir('root');
  put(root, 'packs/art/pack.json', { type: 'assets', name: 'Art', version: '2.0.0', files: { map: 'm.json', media: ['a.png'] } });
  put(root, 'packs/art/m.json', { '/assets/y.png': '/packs/art/a.png' });
  fs.writeFileSync(path.join(root, 'packs/art/a.png'), Buffer.alloc(32, 5));
  put(root, 'packs/good/pack.json', { type: 'data', name: 'Good', version: '1.0.0', files: { patch: 'p.json' } });
  put(root, 'packs/good/p.json', { config: { good: true } });
  put(root, 'packs/old/pack.json', { type: 'assets', name: 'Old', version: '1.0.0', app: '0.1.x', files: { map: 'm.json', media: ['a.png'] } });
  put(root, 'packs/old/m.json', { '/assets/x.png': '/packs/old/a.png' });
  fs.writeFileSync(path.join(root, 'packs/old/a.png'), Buffer.alloc(16, 3));
  put(root, 'packs/tr/pack.json', { type: 'lang', lang: 'qaa', name: 'TR', app: '0.1.x', files: { ui: 'ui.json' } });
  put(root, 'packs/tr/ui.json', { 开始: 'Qaa' });
  return root;
}

test('validPackPolicy: only off / allow, valid ids, no duplicates', () => {
  for (const ok of [null, undefined, false, {}, { off: [] }, { allow: ['hd-art'] }, { off: ['a'], allow: ['b'] }]) {
    assert.equal(validPackPolicy(ok), true, JSON.stringify(ok));
  }
  for (const bad of ['x', 7, [], { nope: [] }, { off: 'x' }, { off: ['bad id!'] }, { off: ['a', 'a'] },
    { off: Array.from({ length: 600 }, (_, i) => `p${i}`) }]) {
    assert.equal(validPackPolicy(bad), false, JSON.stringify(bad).slice(0, 40));
  }
});

test('the policy round-trips through the settings file, and a bad one is refused', () => {
  const dir = tmpdir('settings');
  try {
    writeServerSettings(dir, { packs: { off: ['hd-art'], allow: ['old-pack'] } });
    const read = readServerSettings(dir);
    assert.deepEqual([...read.packs.off], ['hd-art']);
    assert.deepEqual([...read.packs.allow], ['old-pack']);
    assert.equal(read.maxAiPerRoom, null, 'the other settings keep their defaults');
    // a malformed policy never reaches the file
    assert.throws(() => writeServerSettings(dir, { packs: { off: ['not an id'] } }), /内容包策略无效/);
    assert.deepEqual([...readServerSettings(dir).packs.off], ['hd-art'], 'the file is untouched');
    // a hand-edited file with a bad policy is refused as a whole (the last valid value keeps running)
    const file = path.join(dir, SERVER_SETTINGS_FILE);
    fs.writeFileSync(file, JSON.stringify({ version: 1, maxAiPerRoom: null, packs: { off: ['../etc'] } }));
    assert.throws(() => readServerSettings(dir), /服务器配置格式无效/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the controller reports a policy change to its owner (onChange), like the other settings', () => {
  const dir = tmpdir('change');
  try {
    const seen = [];
    const ctl = createServerSettings({ dir, log: silent, pollMs: 0, onChange: (next, prev) => seen.push([next.packs?.off?.length ?? 0, prev.packs]) });
    assert.equal(ctl.get().packs, undefined, 'an untouched server has no pack policy key at all');
    writeServerSettings(dir, { packs: { off: ['hd-art'] } });
    assert.equal(ctl.poll(), true, 'the poll sees the new policy');
    assert.deepEqual([...ctl.get().packs.off], ['hd-art']);
    assert.deepEqual(seen, [[1, undefined]], 'the previous state had no pack policy key');
    assert.equal(ctl.poll(), false, 'nothing changed the second time');
    ctl.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a pack turned off is not loaded, not served and leaves the content tag (a live type)', () => {
  const root = policyRoot();
  try {
    const dirs = dirsOf(root);
    let policy = null;
    const reg = createPackRegistry(dirs, { app: APP, recheckMs: 0, policy: () => policy, log: silent });
    assert.deepEqual(reg.list().map((p) => p.id), ['art', 'good', 'tr'], 'incompatible game content waits, the language pack loads');
    assert.deepEqual(reg.report().denied.map((d) => `${d.id}:${d.reason}`), ['old:unconfirmed']);
    assert.equal(reg.servable('old', 'a.png'), null, 'a held-back pack serves nothing');
    const before = reg.content().tag;

    policy = { off: ['art'] };
    reg.refresh();
    assert.deepEqual(reg.list().map((p) => p.id), ['good', 'tr']);
    assert.deepEqual(reg.report().denied.map((d) => `${d.id}:${d.reason}`), ['art:off', 'old:unconfirmed']);
    assert.equal(reg.index().packs.some((p) => p.id === 'art'), false, 'the index no longer lists it');
    assert.equal(reg.servable('art', 'a.png'), null);
    assert.notEqual(reg.content().tag, before, 'the tag follows what is really loaded');
    assert.equal(reg.content().languages, 1);
    assert.equal(reg.overview().packs.find((p) => p.id === 'art').live, true);

    // a data pack is NOT live: switching it at runtime is recorded but has no effect in this process, because the tables
    // the simulation and /data/<name>.json use were fixed at start (the panel asks for a restart instead)
    policy = { off: ['art', 'good'] };
    reg.refresh();
    assert.equal(reg.list().map((p) => p.id).includes('good'), true, 'still in force until a restart');
    assert.equal(reg.overview().packs.find((p) => p.id === 'good').enabled, true);
    assert.equal(reg.overview().packs.find((p) => p.id === 'good').live, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an incompatible pack that changes the game loads only once the owner confirms it', () => {
  const root = policyRoot();
  try {
    const dirs = dirsOf(root);
    let policy = null;
    const reg = createPackRegistry(dirs, { app: APP, recheckMs: 0, policy: () => policy, log: silent });
    const unconfirmed = reg.content().tag;
    assert.deepEqual(reg.list('assets').map((p) => p.id), ['art'], 'the compatible assets pack loads');
    assert.equal(reg.overview().packs.find((p) => p.id === 'old').reason, 'unconfirmed');
    assert.equal(reg.overview().packs.find((p) => p.id === 'old').enabled, false);
    assert.equal(reg.overview().packs.find((p) => p.id === 'old').compatible, false);

    policy = { allow: ['old'] };
    reg.refresh();
    assert.deepEqual(reg.list('assets').map((p) => p.id), ['art', 'old']);
    assert.deepEqual(reg.report().denied, []);
    assert.ok(reg.servable('old', 'a.png'));
    assert.notEqual(reg.content().tag, unconfirmed);
    assert.equal(reg.overview().packs.find((p) => p.id === 'old').enabled, true);
    assert.equal(reg.overview().policy.allow[0], 'old');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a policy change invalidates the scan cache even when no pack file changed', () => {
  const root = policyRoot();
  try {
    const dirs = dirsOf(root);
    let policy = null;
    // recheckMs > 0: the registry would otherwise answer from its cache for a while, and the folder signature is the
    // same before and after the switch — the policy has to be part of the key (server/packs.js refresh).
    const reg = createPackRegistry(dirs, { app: APP, recheckMs: 60_000, policy: () => policy, log: silent });
    assert.deepEqual(reg.list().map((p) => p.id), ['art', 'good', 'tr']);
    policy = { off: ['art'] };
    assert.deepEqual(reg.list().map((p) => p.id), ['good', 'tr'], 'the new policy is in force without waiting for recheckMs');
    policy = null;
    assert.deepEqual(reg.list().map((p) => p.id), ['art', 'good', 'tr']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('only a pack that changes the game can be turned off, and scanPacks itself stays policy-free', () => {
  const root = policyRoot();
  try {
    assert.equal(isIdentityPack({ type: 'assets' }), true);
    assert.equal(isIdentityPack({ type: 'lang' }), false);
    // a tool (tools/packs.mjs) scans without a policy: it must still LIST the incompatible pack and flag it
    const scan = scanPacks(dirsOf(root), { app: APP });
    assert.deepEqual(scan.packs.map((p) => p.id).sort(), ['art', 'good', 'old', 'tr']);
    assert.equal(scan.skipped.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/** Start a server with the console enabled and a temporary packs/ + settings dir. */
async function makeServer(extra = {}) {
  return startServer({ port: 0, host: '127.0.0.1', quiet: true, adminSecret: SECRET, ...extra });
}
async function call(base, path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, text, json };
}
async function login(base) {
  const res = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET }) });
  assert.equal(res.status, 200);
  return String(res.headers.get('set-cookie')).split(';')[0];
}

test('the /admin 内容包 panel: read the packs, flip a switch, see the index follow', async () => {
  const root = policyRoot();
  const settingsDir = tmpdir('runtime');
  try {
    const srv = await makeServer({ packsDir: path.join(root, 'packs'), serverSettingsDir: settingsDir });
    try {
      const base = srv.url;
      assert.equal((await call(base, '/api/admin/packs')).status, 401, 'needs the secret');
      const loginRes = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET }) });
      const cookie = String(loginRes.headers.get('set-cookie')).split(';')[0];
      assert.ok(cookie.startsWith('sp_admin='));
      assert.equal(typeof await login(base), 'string', 'a second login is another session token, and also works');

      const list = await call(base, '/api/admin/packs', { cookie });
      assert.equal(list.status, 200);
      const byId = (body) => Object.fromEntries(body.packs.map((p) => [p.id, p]));
      const first = byId(list.json);
      assert.equal(first.old.reason, 'unconfirmed');
      assert.equal(first.old.enabled, false);
      assert.equal(first.good.enabled, true);
      assert.equal(first.tr.enabled, true, 'the language pack from the temporary packs/ folder is on');
      assert.equal(first.en.enabled, true, 'and so are the shipped languages');
      assert.equal(first.tr.compatible, false, 'listed as outside its app range, and still loaded');
      assert.equal(list.json.tag, srv.packs.content().tag);
      assert.equal(list.json.policy, null, 'no policy yet');
      assert.equal(list.json.languages >= 5, true, 'the panel says how many language packs there are');
      const indexIds = async () => ((await (await fetch(base + '/packs/index.json')).json()).packs || []).map((p) => p.id);
      assert.ok((await indexIds()).includes('good'), 'the data pack is in force at start');

      // 确认加载 old (an assets pack: live, so it takes effect at once)
      const on = await call(base, '/api/admin/packs', { method: 'POST', cookie, body: { id: 'old', confirmed: true } });
      assert.equal(on.status, 200);
      assert.deepEqual(on.json.policy, { off: [], allow: ['old'] });
      assert.equal(byId(on.json).old.enabled, true);
      assert.equal(on.json.restartRequired, false, 'an assets pack applies while the server runs');
      assert.equal((await call(base, '/packs/old/a.png')).status, 200);
      const withOld = await (await fetch(base + '/healthz')).json();
      assert.deepEqual(withOld.mods.packs.map((p) => p.id), ['art', 'old', 'good'], 'now the tag covers it');

      // 停用 old again: a live pack leaves the index and its files stop being served
      const offOld = await call(base, '/api/admin/packs', { method: 'POST', cookie, body: { id: 'old', enabled: false } });
      assert.equal(offOld.status, 200);
      assert.deepEqual(offOld.json.policy, { off: ['old'], allow: ['old'] });
      assert.equal(byId(offOld.json).old.enabled, false);
      assert.equal((await indexIds()).includes('old'), false);
      assert.equal((await call(base, '/packs/old/a.png')).status, 404);

      // 停用 good (a data pack): recorded, but the tables were fixed at start — the panel says a restart is needed and the
      // index keeps listing it, so the index, the tag and /data/config.json can never disagree
      const offData = await call(base, '/api/admin/packs', { method: 'POST', cookie, body: { id: 'good', enabled: false } });
      assert.equal(offData.status, 200);
      assert.equal(offData.json.restartRequired, true);
      assert.equal(byId(offData.json).good.enabled, true, 'still in force in this process');
      assert.equal((await indexIds()).includes('good'), true);
      assert.equal((await call(base, '/packs/good/p.json')).status, 200);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(settingsDir, SERVER_SETTINGS_FILE), 'utf8')).packs, { off: ['old', 'good'], allow: ['old'] });
      // …and a fresh process (a new registry, the policy as saved) really does leave it out
      const restarted = (await import('../server/packs.js')).createPackRegistry(
        { publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), packsDir: path.join(root, 'packs') },
        { app: '0.2.4', recheckMs: 0, log: { info() {}, warn() {} }, policy: () => readServerSettings(settingsDir).packs });
      assert.equal(restarted.list('data').length, 0, 'the data pack is off after a restart');

      // a language pack cannot be turned off; an unknown id is 404; an unknown key is 400
      const lang = await call(base, '/api/admin/packs', { method: 'POST', cookie, body: { id: 'tr', enabled: false } });
      assert.equal(lang.status, 409);
      assert.equal(lang.json.error, 'LANGUAGE_LOCKED');
      assert.equal((await call(base, '/api/admin/packs', { method: 'POST', cookie, body: { id: 'nope', enabled: false } })).status, 404);
      assert.equal((await call(base, '/api/admin/packs', { method: 'POST', cookie, body: {} })).status, 400);
      assert.equal((await call(base, '/api/admin/packs', { method: 'POST', cookie, body: { off: ['tr'] } })).status, 409, 'the whole-policy form checks it too');

      // the whole policy can be cleared at once (the CLI's shape), and everything comes back
      const all = await call(base, '/api/admin/packs', { method: 'POST', cookie, body: { off: [], allow: [] } });
      assert.equal(all.status, 200);
      assert.equal(all.json.policy, null, 'an empty policy is stored as null');
      assert.equal((await call(base, '/packs/good/p.json')).status, 200);
      assert.equal((await indexIds()).includes('good'), true);
    } finally { await srv.close(); }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(settingsDir, { recursive: true, force: true });
  }
});
