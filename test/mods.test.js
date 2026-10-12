// 代码 mod (docs/PACKS.md §4): a folder under mods/ that the server OWNER installs and enables.
//
// The two things that matter most here are the safety rules, so they are what the tests check hardest: a folder dropped in
// runs NOTHING until its id is in the owner's settings, a broken mod is reported without keeping the server from booting,
// and a pack-shaped manifest (or an entry pointing outside its folder) is refused rather than imported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanMods, loadMods, modsReport } from '../server/mods.js';
import { startServer } from '../server/index.js';
import { writeServerSettings, readServerSettings } from '../server/serverSettings.js';

const SECRET = 'm'.repeat(32);
const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sp-mods-${tag}-`));
const put = (dir, rel, body) => {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};
const silent = { info() {}, warn() {}, error() {} };

/** An entry that records that it ran, into a marker file the test owns, and can be told to throw. */
function entrySource(marker, { fail = false, inspectData = false } = {}) {
  return [
    `import fs from 'node:fs';`,
    `export async function setup(ctx) {`,
    `  ${fail ? `throw new Error('boom from ' + ctx.id);` : ''}`,
    `  const seen = { id: ctx.id, version: ctx.version, hasData: !!ctx.data, hasPacks: !!ctx.packs, tables: ctx.data ? Object.keys(ctx.data).length : 0 };`,
    `  ${inspectData ? `seen.configKeys = ctx.data?.config ? Object.keys(ctx.data.config).length : -1;` : ''}`,
    `  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(seen));`,
    `}`,
  ].join('\n');
}

test('scanMods: a manifest and an entry inside the folder, and nothing else', () => {
  const dir = tmpdir('scan');
  try {
    put(dir, 'good/mod.json', { id: 'good', name: 'Good', version: '1.0.0', entry: 'main.mjs' });
    put(dir, 'good/main.mjs', 'export function setup() {}');
    put(dir, 'sub/mod.json', { entry: 'lib/main.js' });
    put(dir, 'sub/lib/main.js', 'export function setup() {}');
    const scan = scanMods(dir);
    assert.deepEqual(scan.mods.map((m) => m.id), ['good', 'sub']);
    assert.deepEqual(scan.skipped, []);
    assert.equal(scan.mods[1].entry, 'lib/main.js');

    // every way a manifest can be wrong, each refused with a reason
    put(dir, 'nomanifest/main.mjs', 'export function setup() {}');
    put(dir, 'badid!/mod.json', { entry: 'main.mjs' });
    put(dir, 'noentry/mod.json', { name: 'No entry' });
    put(dir, 'escape/mod.json', { entry: '../outside.mjs' });
    put(dir, 'wrongext/mod.json', { entry: 'main.txt' });
    put(dir, 'wrongext/main.txt', 'x');
    put(dir, 'missing/mod.json', { entry: 'main.mjs' });
    put(dir, 'packish/mod.json', { type: 'assets', entry: 'main.mjs' });
    put(dir, 'packish/main.mjs', 'export function setup() {}');
    put(dir, 'notjson/mod.json', '{ nope');
    put(dir, 'extra/mod.json', { entry: 'main.mjs', colour: 'red' });
    put(dir, 'extra/main.mjs', 'export function setup() {}');
    const again = scanMods(dir);
    const why = Object.fromEntries(again.skipped.map((s) => [s.where, s.problems.join('; ')]));
    assert.match(why['mods/nomanifest/'], /no mod\.json/);
    assert.match(why['mods/badid!/'], /folder name "badid!" is not a mod id/);
    assert.match(why['mods/noentry/'], /no "entry"/);
    assert.match(why['mods/escape/'], /not a path inside the mod folder/);
    assert.match(why['mods/wrongext/'], /"entry" must be a \.mjs \/ \.js file/);
    assert.match(why['mods/missing/'], /"entry": main\.mjs is missing/);
    assert.match(why['mods/packish/'], /"type" is a content-pack field/);
    assert.match(why['mods/notjson/'], /not valid JSON/);
    assert.deepEqual(again.mods.map((m) => m.id), ['extra', 'good', 'sub'], 'the folders are scanned in name order');
    assert.deepEqual(again.warnings, [{ where: 'mods/extra/', warning: '"colour" is not a mod field (ignored)' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadMods: nothing runs unless the owner enabled it, and one broken mod does not stop the others', async () => {
  const dir = tmpdir('load');
  try {
    const ranGood = path.join(dir, 'good.ran');
    const ranBad = path.join(dir, 'bad.ran');
    const ranAlso = path.join(dir, 'also.ran');
    put(dir, 'good/mod.json', { entry: 'main.mjs', version: '2.0.0' });
    put(dir, 'good/main.mjs', entrySource(ranGood, { inspectData: true }));
    put(dir, 'bad/mod.json', { entry: 'main.mjs' });
    put(dir, 'bad/main.mjs', entrySource(ranBad, { fail: true }));
    put(dir, 'also/mod.json', { entry: 'main.mjs' });
    put(dir, 'also/main.mjs', entrySource(ranAlso));
    const scan = scanMods(dir);

    // fail closed: folders present, nothing enabled
    const off = await loadMods(scan.mods, { enabled: [], log: silent });
    assert.deepEqual(off, { loaded: [], failed: [] });
    assert.equal(fs.existsSync(ranGood), false, 'a dropped-in folder must never execute');

    // enabled: the good and the also run, the broken one is reported and skipped
    const on = await loadMods(scan.mods, { enabled: ['good', 'bad', 'also'], data: { config: { a: 1, b: 2 } }, log: silent });
    assert.deepEqual(on.loaded.map((m) => m.id), ['also', 'good'], 'in id order, the broken one skipped');
    assert.deepEqual(on.failed, [{ id: 'bad', error: 'boom from bad' }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(ranGood, 'utf8')), { id: 'good', version: '2.0.0', hasData: true, hasPacks: false, tables: 1, configKeys: 2 });
    assert.equal(fs.existsSync(ranAlso), true);
    assert.equal(fs.existsSync(ranBad), false, 'the mod threw before it could write');

    // an entry that exports nothing usable is a failure, not a crash
    put(dir, 'empty/mod.json', { entry: 'main.mjs' });
    put(dir, 'empty/main.mjs', 'export const nothing = 1;');
    const empty = await loadMods(scanMods(dir).mods, { enabled: ['empty'], log: silent });
    assert.match(empty.failed[0].error, /must export a setup\(ctx\) function/);

    const report = modsReport(scanMods(dir), { enabled: ['good', 'bad'] }, on);
    assert.deepEqual(report.enabled, ['good', 'bad']);
    // `running` comes from the runtime (this process really loaded `also` and `good`); `enabled` from the settings
    assert.deepEqual(report.mods.map((m) => `${m.id}:${m.enabled ? 'on' : 'off'}:${m.running ? 'running' : m.error ? 'failed' : 'idle'}`),
      ['also:off:running', 'bad:on:failed', 'empty:off:idle', 'good:on:running']);
    assert.deepEqual(report.skipped, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** Start a server whose mods/ and settings live in temporary folders. */
async function makeServer({ modsDir, settingsDir }) {
  return startServer({ port: 0, host: '127.0.0.1', quiet: true, modsDir, serverSettingsDir: settingsDir, adminSecret: SECRET });
}
async function call(base, path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

test('a real server: mods are listed, nothing runs until enabled, and /healthz says what runs', async () => {
  const modsDir = tmpdir('server');
  const settingsDir = tmpdir('settings');
  const marker = path.join(modsDir, 'hello.ran');
  try {
    put(modsDir, 'hello/mod.json', { name: 'Hello', version: '1.2.3', entry: 'main.mjs' });
    put(modsDir, 'hello/main.mjs', entrySource(marker, { inspectData: true }));
    put(modsDir, 'broken/mod.json', { entry: 'main.mjs' });
    put(modsDir, 'broken/main.mjs', entrySource(path.join(modsDir, 'broken.ran'), { fail: true }));

    const off = await makeServer({ modsDir, settingsDir });
    try {
      assert.deepEqual(off.mods.mods.map((m) => m.id), ['broken', 'hello']);
      assert.equal(off.mods.mods.every((m) => !m.enabled && !m.running), true, 'nothing runs by default');
      assert.equal(fs.existsSync(marker), false);
      const health = await (await fetch(`${off.url}/healthz`)).json();
      assert.equal(health.mods.code, undefined, 'an unmodded server says nothing about code mods');
    } finally { await off.close(); }

    // the owner enables one; a restart loads it (and the broken one is reported, not fatal)
    writeServerSettings(settingsDir, { mods: { enabled: ['hello', 'broken'] } });
    const on = await makeServer({ modsDir, settingsDir });
    try {
      assert.deepEqual(on.mods.mods.map((m) => `${m.id}:${m.enabled ? 'on' : 'off'}:${m.running ? 'run' : m.error ? 'fail' : 'idle'}`),
        ['broken:on:fail', 'hello:on:run']);
      assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).id, 'hello', 'the enabled mod ran at start');
      const health = await (await fetch(`${on.url}/healthz`)).json();
      assert.deepEqual(health.mods.code, [{ id: 'hello', version: '1.2.3' }], 'a code mod is reported apart from the pack tag');
      assert.match(health.mods.tag, /^c[0-9a-f]{12}$/, 'the pack tag is still there');
    } finally { await on.close(); }
  } finally {
    fs.rmSync(modsDir, { recursive: true, force: true });
    fs.rmSync(settingsDir, { recursive: true, force: true });
  }
});

test('the /admin 代码 mod panel: list, flip a switch, and always say a restart is needed', async () => {
  const modsDir = tmpdir('admin');
  const settingsDir = tmpdir('admin-settings');
  const marker = path.join(modsDir, 'admin.ran');
  try {
    put(modsDir, 'mymod/mod.json', { name: 'My mod', version: '0.1.0', entry: 'main.mjs', app: '>=0.2.4' });
    put(modsDir, 'mymod/main.mjs', entrySource(marker));
    const srv = await makeServer({ modsDir, settingsDir });
    try {
      assert.equal((await call(srv.url, '/api/admin/mods')).status, 401, 'needs the secret');
      const login = await fetch(`${srv.url}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET }) });
      const cookie = String(login.headers.get('set-cookie')).split(';')[0];

      const list = await call(srv.url, '/api/admin/mods', { cookie });
      assert.equal(list.status, 200);
      assert.deepEqual(list.json.mods.map((m) => `${m.id}:${m.enabled ? 'on' : 'off'}:${m.running ? 'run' : 'idle'}`), ['mymod:off:idle']);
      assert.equal(list.json.policy, null);

      const on = await call(srv.url, '/api/admin/mods', { method: 'POST', cookie, body: { id: 'mymod', enabled: true } });
      assert.equal(on.status, 200);
      assert.equal(on.json.restartRequired, true, 'a code mod cannot be loaded into a running process');
      assert.deepEqual(on.json.policy, { enabled: ['mymod'] });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(settingsDir, 'server-settings.json'), 'utf8')).mods, { enabled: ['mymod'] });
      assert.equal(fs.existsSync(marker), false, 'and it still has not run in this process');
      // The switch must be reported as it is NOW (the browser check found this: reading the boot-time report made the panel
      // still say 未启用 right after enabling), while `running` stays the fact of this process.
      assert.equal(on.json.mods[0].enabled, true, 'the switch is on');
      assert.equal(on.json.mods[0].running, false, 'but this process has not loaded it');
      const reread = await call(srv.url, '/api/admin/mods', { cookie });
      assert.deepEqual([reread.json.mods[0].enabled, reread.json.mods[0].running], [true, false], 'and a fresh read agrees');

      const off = await call(srv.url, '/api/admin/mods', { method: 'POST', cookie, body: { id: 'mymod', enabled: false } });
      assert.deepEqual(off.json.policy, null, 'an empty list is stored as no policy');
      assert.equal(readServerSettings(settingsDir).mods, null);
      assert.equal((await call(srv.url, '/api/admin/mods', { method: 'POST', cookie, body: { id: 'nope', enabled: true } })).status, 404);
      assert.equal((await call(srv.url, '/api/admin/mods', { method: 'POST', cookie, body: {} })).status, 400);
      assert.equal((await call(srv.url, '/api/admin/mods', { method: 'POST', cookie, body: { enabled: ['ghost'] } })).status, 404);
    } finally { await srv.close(); }
  } finally {
    fs.rmSync(modsDir, { recursive: true, force: true });
    fs.rmSync(settingsDir, { recursive: true, force: true });
  }
});
