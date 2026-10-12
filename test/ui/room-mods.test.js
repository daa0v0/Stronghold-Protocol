// The client half of the per-room content packs (docs/PACKS.md §4): the create-room panel's helpers, the page applying a
// room's selection to its own art, and the room's own tag against what this page applied.
//
// Two implementations have to agree: the server tags a room's subset (server/packs.js `tagOf`) and the page tags the same
// subset from the index it read (ui/contentPacks.js `contentTagOf`). The tests below check them against each other, and
// drive the panel's pure helpers rather than a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modChoices, modsForCreate, roomContentOk } from '../../public/js/ui/roomMods.js';
import { createPackRegistry } from '../../server/packs.js';

const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sp-roomui-${tag}-`));
const put = (dir, rel, body) => {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};
/** The fixture writes its pack folders at the root of a temporary directory, which IS the packs/ folder here. */
const dirsOf = (root) => ({ publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), packsDir: root });
const silent = { info() {}, warn() {}, error() {} };

/** Two live packs (assets) and one that is not live (data) — the shape the panel has to present. */
function packsRoot() {
  const dir = tmpdir('packs');
  for (const id of ['art', 'art2']) {
    put(dir, `${id}/pack.json`, { type: 'assets', name: id, version: '1.0.0', files: { map: 'm.json', media: ['a.png'] } });
    put(dir, `${id}/m.json`, { [`/assets/${id}.png`]: `/packs/${id}/a.png`, '/assets/shared.png': `/packs/${id}/a.png` });
    fs.writeFileSync(path.join(dir, id, 'a.png'), Buffer.alloc(16, 1));
  }
  put(dir, 'bal/pack.json', { type: 'data', name: 'Balance', version: '2.0.0', files: { patch: 'p.json' } });
  put(dir, 'bal/p.json', { config: { probe: true } });
  return dir;
}

test('modChoices: only a pack that changes the game is a choice, and a non-live one is locked', () => {
  const entries = [
    { id: 'art', type: 'assets', name: 'Art', version: '1.0.0' },
    { id: 'bal', type: 'data', name: 'Balance', version: '2.0.0' },
    { id: 'ja', type: 'lang', name: 'Japanese' },
    { id: 'future', type: 'unknown' },
  ];
  const { toggle, locked } = modChoices(entries);
  assert.deepEqual(toggle.map((m) => m.id), ['art'], 'a live pack is toggleable');
  assert.deepEqual(locked.map((m) => m.id), ['bal'], 'a data pack is shown, but locked');
  assert.equal(modChoices([]).toggle.length + modChoices([]).locked.length, 0);
  assert.deepEqual(modChoices(entries).toggle[0], { id: 'art', type: 'assets', name: 'Art', version: '1.0.0' });
});

test('modsForCreate: everything enabled means no field at all, a narrowed set is explicit', () => {
  const choices = { toggle: [{ id: 'art' }, { id: 'art2' }], locked: [{ id: 'bal' }] };
  assert.equal(modsForCreate(['art', 'art2'], choices), undefined, 'the untouched case sends nothing');
  assert.deepEqual(modsForCreate(['art'], choices), ['art', 'bal'], 'a locked pack is always in the list');
  assert.deepEqual(modsForCreate([], choices), ['bal'], 'even with every toggle off, the fixed pack stays');
  assert.deepEqual(modsForCreate(['art2', 'bal', 'art'], choices), undefined, 'order and the locked one do not matter');
});

test('roomContentOk: nothing to compare against is not a mismatch', () => {
  assert.equal(roomContentOk('c1', 'c1'), true);
  assert.equal(roomContentOk('c1', 'c2'), false);
  assert.equal(roomContentOk('', 'c1'), true, 'an older server (or a frame not yet arrived) has no tag');
  assert.equal(roomContentOk('c1', ''), true, 'a page that knows nothing yet is not wrong');
});

test('the page applies a room’s selection to its own art, refetching the manifest only when it changes', async () => {
  const root = packsRoot();
  try {
    const registry = createPackRegistry(dirsOf(root), { log: silent });
    const index = registry.index();
    // serve each pack's map from the files it actually ships
    const fetchImpl = async (url) => {
      if (url === '/packs/index.json') return { ok: true, status: 200, json: async () => index };
      const entry = index.packs.find((p) => p.files && p.files.map === url);
      if (!entry) return { ok: false, status: 404, json: async () => null };
      const rel = url.slice(`${'/packs/'}${entry.id}/`.length);
      return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(path.join(root, entry.id, ...rel.split('/')), 'utf8')) };
    };
    const packs = await import('../../public/js/ui/assetPacks.js');
    const report = await packs.loadAssetPacks({ fetchImpl });
    assert.deepEqual(report.packs.map((p) => p.id), ['art', 'art2']);
    assert.deepEqual(packs.appliedMods(), ['art', 'art2'], 'at boot every pack the server loaded is in force');
    assert.equal(packs.assetOverride('/assets/shared.png'), '/packs/art2/a.png?v=1.0.0', 'the later id wins, as on the server');

    // a room that keeps only the first pack: the shared URL goes back to it, and the manifest is refetched once
    let dropped = 0;
    packs.applyRoomMods(['art'], { invalidate: () => { dropped++; } });
    assert.deepEqual(packs.appliedMods(), ['art']);
    assert.equal(dropped, 1, 'the manifest is refetched (the transform runs on load)');
    assert.equal(packs.assetOverride('/assets/shared.png'), '/packs/art/a.png?v=1.0.0');
    assert.equal(packs.assetOverride('/assets/art2.png'), null, 'a dropped pack no longer replaces anything');

    // the same selection again: nothing to do
    packs.applyRoomMods(['art'], { invalidate: () => { dropped++; } });
    assert.equal(dropped, 1, 'an unchanged selection costs no request');

    // leaving the room restores everything
    packs.applyRoomMods(null, { invalidate: () => { dropped++; } });
    assert.deepEqual(packs.appliedMods(), ['art', 'art2']);
    assert.equal(packs.assetOverride('/assets/shared.png'), '/packs/art2/a.png?v=1.0.0');
    assert.equal(dropped, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the page and the server tag a room’s subset identically', async () => {
  const root = packsRoot();
  try {
    const registry = createPackRegistry(dirsOf(root), { log: silent });
    const index = registry.index();
    const fetchImpl = async (url) => {
      if (url === '/packs/index.json') return { ok: true, status: 200, json: async () => index };
      if (url === '/healthz') return { ok: true, status: 200, json: async () => ({ mods: { tag: registry.content().tag } }) };
      return { ok: false, status: 404, json: async () => null };
    };
    const content = await import('../../public/js/ui/contentPacks.js');
    const state = await content.loadContentTag({ fetchImpl });
    assert.equal(state.tag, registry.content().tag, 'the whole set agrees');
    for (const ids of [['art'], ['art2'], ['art', 'bal'], []]) {
      assert.equal(content.contentTagOf(ids), registry.tagOf(ids).tag, `subset ${ids.join('+') || 'none'}`);
    }
    assert.deepEqual(content.contentEntries().map((e) => e.id).sort(), ['art', 'art2', 'bal']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
