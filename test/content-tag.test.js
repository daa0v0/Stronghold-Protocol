// The content identity of a server (docs/PACKS.md §4; shared/contentTag.js): which content packs are in force, and one
// short tag both sides compute for themselves.
//
// Two implementations must agree: the server hashes its registry, the client hashes the packs it read from
// GET /packs/index.json. So the tag covers only what both know — the app version and, per pack, type/id/version/size —
// and the tests below check the agreement against each other rather than against a literal, plus the /healthz report and
// the diagnostics line a bug report carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contentTag, contentPacks, contentSummary, isIdentityPack } from '../shared/contentTag.js';
import { scanPacks, createPackRegistry, packIndexOf } from '../server/packs.js';
import { startServer } from '../server/index.js';
import { buildDiagnostics } from '../public/js/diag.js';

const APP = '0.2.4';

const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sp-tag-${tag}-`));
const put = (dir, rel, body) => {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};
const dirsOf = (root) => ({ publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), packsDir: path.join(root, 'packs') });

test('contentTag: an identity, stable and order independent, sensitive to a version or a byte', () => {
  const a = { type: 'assets', id: 'art', version: '1.0.0', bytes: 100 };
  const b = { type: 'data', id: 'balance', version: '', bytes: 20 };
  const tag = contentTag(APP, [a, b]);
  assert.match(tag, /^c[0-9a-f]{12}$/);
  assert.equal(contentTag(APP, [b, a]), tag, 'the scan order never changes the tag');
  assert.equal(contentTag(APP, [{ ...a }, { ...b }]), tag);
  assert.notEqual(contentTag('0.2.5', [a, b]), tag, 'the app version is part of it');
  assert.notEqual(contentTag(APP, [{ ...a, version: '1.0.1' }, b]), tag);
  assert.notEqual(contentTag(APP, [{ ...a, bytes: 101 }, b]), tag, 'an edited file changes it even without a version bump');
  assert.notEqual(contentTag(APP, [a, { ...b, id: 'balance2' }]), tag);
  assert.equal(contentTag(APP, []), contentTag(APP, []), 'no packs: one tag, always the same');
  assert.notEqual(contentTag(APP, []), tag);

  // contentPacks: canonical, sorted, and reading an index entry's `size` as well as a registry pack's `bytes`
  assert.deepEqual(contentPacks([b, a]), [
    { type: 'assets', id: 'art', version: '1.0.0', size: 100 },
    { type: 'data', id: 'balance', version: '', size: 20 },
  ]);
  assert.deepEqual(contentPacks([{ type: 'lang', id: 'ja', size: 5 }]), [], 'a language is not a change to the game');
  assert.equal(isIdentityPack({ type: 'assets' }), true);
  assert.equal(isIdentityPack({ type: 'lang' }), false);
  assert.equal(isIdentityPack({ type: 'unknown' }), false);
  assert.deepEqual(contentPacks([{ nope: 1 }, null, { type: 'x' }]), [], 'entries without an id and a type are ignored');
  assert.equal(contentSummary([a, b]), '2 pack(s) (assets:art@1.0.0, data:balance)');
  assert.equal(contentSummary([]), '');
});

test('a pack scanned from disk reports its bytes, and the index carries them', () => {
  const root = tmpdir('bytes');
  try {
    put(root, 'packs/art/pack.json', { type: 'assets', name: 'A', version: '1', files: { map: 'map.json', media: ['a.png'] } });
    put(root, 'packs/art/map.json', { '/assets/x.png': '/packs/art/a.png' });
    fs.writeFileSync(path.join(root, 'packs', 'art', 'a.png'), Buffer.alloc(1234, 7));
    const scan = scanPacks(dirsOf(root), { app: APP });
    const pack = scan.packs.find((p) => p.id === 'art');
    assert.equal(pack.bytes, 1234 + fs.statSync(path.join(root, 'packs', 'art', 'map.json')).size);
    const entry = packIndexOf(scan.packs, { app: APP }).packs[0];
    assert.equal(entry.size, pack.bytes, 'the index carries the size, which is what lets a client compute the tag');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the client and the server compute the same tag from the same packs', async () => {
  const client = await import('../public/js/ui/contentPacks.js');
  const root = tmpdir('agree');
  try {
    put(root, 'packs/art/pack.json', { type: 'assets', name: 'Art', version: '1.2.0', files: { map: 'map.json', media: ['a.png'] } });
    put(root, 'packs/art/map.json', { '/assets/x.png': '/packs/art/a.png' });
    fs.writeFileSync(path.join(root, 'packs', 'art', 'a.png'), Buffer.alloc(64, 1));
    put(root, 'packs/bal/pack.json', { type: 'data', name: 'Balance', version: '0.3.0', app: '>=0.2.0', files: { patch: 'p.json' } });
    put(root, 'packs/bal/p.json', { config: { probe: 1 } });
    const registry = createPackRegistry(dirsOf(root), { app: APP, recheckMs: 0 });
    const server = registry.content();
    const index = registry.index();
    assert.deepEqual(server.packs.map((p) => `${p.type}:${p.id}@${p.version}`), ['assets:art@1.2.0', 'data:bal@0.3.0']);

    // an index service that answers with exactly what this server serves
    const fetchFake = async (url) => {
      if (url === '/packs/index.json') return { ok: true, status: 200, json: async () => index };
      if (url === '/healthz') return { ok: true, status: 200, json: async () => ({ ok: true, mods: { tag: server.tag, packs: server.packs } }) };
      return { ok: false, status: 404, json: async () => null };
    };
    const state = await client.loadContentTag({ fetchImpl: fetchFake });
    assert.equal(state.tag, server.tag, 'the two implementations agree');
    assert.equal(state.serverTag, server.tag);
    assert.equal(state.mismatch, false);
    assert.equal(state.loaded, true);
    assert.deepEqual(client.contentState().packs.map((p) => p.id), ['art', 'bal']);
    assert.equal(client.contentLabel(), 'assets:art@1.2.0, data:bal@0.3.0');

    // the server added a pack after this page loaded: its tag moves, the page's does not, and that is the mismatch
    put(root, 'packs/extra/pack.json', { type: 'data', name: 'Extra', files: { patch: 'p.json' } });
    put(root, 'packs/extra/p.json', { config: { probe: 2 } });
    registry.refresh(true);
    const later = registry.content();
    assert.notEqual(later.tag, server.tag);
    const stale = await client.loadContentTag({ fetchImpl: async (url) => (url === '/packs/index.json'
      ? { ok: true, status: 200, json: async () => index }
      : { ok: true, status: 200, json: async () => ({ mods: { tag: later.tag } }) }) });
    assert.equal(stale.mismatch, true, 'a stale page notices the server moved on');
    assert.equal(stale.tag, server.tag, 'the page still reports the content it actually loaded');

    // a server with no packs: an empty index and an empty tag still agree
    const empty = await client.loadContentTag({ fetchImpl: async (url) => (url === '/packs/index.json'
      ? { ok: true, status: 200, json: async () => ({ version: 1, app: APP, packs: [] }) }
      : { ok: true, status: 200, json: async () => ({ mods: { tag: contentTag(APP, []) } }) }) });
    assert.equal(empty.mismatch, false);
    assert.equal(empty.tag, contentTag(APP, []));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the client survives an unreadable index and an unreachable /healthz', async () => {
  const client = await import('../public/js/ui/contentPacks.js');
  const down = await client.loadContentTag({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => null }) });
  assert.equal(down.loaded, false);
  assert.match(down.error, /index HTTP 503/);
  // no /healthz: the packs are still reported, only the comparison is unavailable
  const noHealth = await client.loadContentTag({ fetchImpl: async (url) => (url === '/packs/index.json'
    ? { ok: true, status: 200, json: async () => ({ version: 1, app: APP, packs: [{ id: 'art', type: 'assets', name: 'A', version: '1', size: 7, files: { map: '/packs/art/map.json' } }] }) }
    : { ok: false, status: 404, json: async () => null }) });
  assert.equal(noHealth.loaded, true);
  assert.equal(noHealth.serverTag, '');
  assert.equal(noHealth.mismatch, false, 'nothing to compare against is not a mismatch');
  assert.equal(noHealth.tag, contentTag(APP, [{ type: 'assets', id: 'art', version: '1', size: 7 }]));
});

test('GET /healthz reports the packs and the tag of the running server', async () => {
  const packsDir = tmpdir('health');
  try {
    put(packsDir, 'probe/pack.json', { type: 'data', name: '探针', version: '2.0.0', files: { patch: 'p.json' } });
    put(packsDir, 'probe/p.json', { config: { packsProbe: true } });
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, packsDir });
    try {
      const health = await (await fetch(`${srv.url}/healthz`)).json();
      assert.equal(health.ok, true);
      assert.equal(health.mods.tag, srv.packs.content().tag);
      assert.deepEqual(health.mods.packs, [{ type: 'data', id: 'probe', version: '2.0.0', compatible: true }]);
      // and the tag the client would compute from the index this server serves is the same one
      const index = await (await fetch(`${srv.url}/packs/index.json`)).json();
      assert.equal(contentTag(index.app, index.packs), health.mods.tag);
    } finally { await srv.close(); }
  } finally { fs.rmSync(packsDir, { recursive: true, force: true }); }
});

test('without packs /healthz still reports a tag, so a page that loaded a pack can tell it is stale', async () => {
  const packsDir = tmpdir('empty');
  try {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, packsDir });
    try {
      const health = await (await fetch(`${srv.url}/healthz`)).json();
      assert.deepEqual(health.mods.packs, []);
      assert.equal(health.mods.tag, contentTag(APP, []));
    } finally { await srv.close(); }
  } finally { fs.rmSync(packsDir, { recursive: true, force: true }); }
});

test('the diagnostics report a modded server, and a stale page by name', () => {
  const base = { state: { connection: { status: 'open' } }, env: {}, version: '0.2.4', now: 1, pageStart: 0, entries: [] };
  const withPacks = { tag: 'c0123456789ab', serverTag: 'c0123456789ab', packs: [{ type: 'assets', id: 'art', version: '1.0.0' }] };
  const text = buildDiagnostics({ ...base, packs: withPacks });
  assert.match(text, /^content: tag c0123456789ab \| page matches the server \| assets:art@1\.0\.0$/m);

  const stale = buildDiagnostics({ ...base, packs: { ...withPacks, serverTag: 'cffffffffffff' } });
  assert.match(stale, /content: tag c0123456789ab \| SERVER cffffffffffff — this page is out of date, reload \| assets:art@1\.0\.0/);

  assert.doesNotMatch(buildDiagnostics(base), /^content:/m, 'an unmodded server says nothing');
  assert.doesNotMatch(buildDiagnostics({ ...base, packs: { tag: contentTag(APP, []), serverTag: '', packs: [] } }), /^content:/m);
  assert.doesNotMatch(buildDiagnostics({ ...base, packs: withPacks, attachBattle: false }), /playerId/, 'nothing new leaks in');
});
