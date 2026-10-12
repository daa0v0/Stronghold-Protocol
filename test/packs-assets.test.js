// The "assets" content pack (docs/PACKS.md §4): art, audio and font replacements a server picks up from packs/<id>/.
//
// An assets pack rewrites the resource URLs of this server, so the client applies its map to the loaded
// data/assets.json — a skin, a reskinned operator, a swapped BGM or a font, with no change to the game's code. It is the
// first type whose files are not all JSON, so the file allowlist has to stay exact: a pack may only point at the files
// its own manifest names, and nothing else in its folder is ever served.
//
// The pack format itself lives in shared/packs.js; the registry in server/packs.js. These tests cover the discovery,
// the index entry (the map is listed, the media pool is not), the allowlist, every way a map can be wrong, the
// two-packs-one-URL conflict, and the client's reading of the index.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACK_TYPES, normalizeManifest, readPackIndex, isPackPath } from '../shared/packs.js';
import { scanPacks, createPackRegistry, packIndexOf } from '../server/packs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = '0.2.4';

const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sp-assets-${tag}-`));
const put = (dir, rel, body) => {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};
/** A file we made ourselves (never game art: a pack's media is the owner's, and this is a test fixture). */
const putBytes = (dir, rel, bytes) => {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), Buffer.from(bytes));
};
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const dirsOf = (root) => ({ publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), packsDir: path.join(root, 'packs') });
const reasons = (scan) => Object.fromEntries(scan.skipped.map((s) => [s.where, s.problems.join('; ')]));

/** A temporary checkout with one good assets pack (`art`) and one that only adds a sound (`bgm`). */
function assetsRoot() {
  const dir = tmpdir('root');
  put(dir, 'packs/art/pack.json', {
    type: 'assets', name: '替换立绘', version: '1.0.0', app: '>=0.2.0', authors: ['Tester'],
    files: { map: 'map.json', media: ['img/amiya.png', 'img/bgm.mp3'] },
  });
  put(dir, 'packs/art/map.json', {
    '/assets/char/amiya.png': '/packs/art/img/amiya.png',
    '/assets/audio/bgm/lobby.mp3': '/packs/art/img/bgm.mp3',
  });
  putBytes(dir, 'packs/art/img/amiya.png', PNG);
  putBytes(dir, 'packs/art/img/bgm.mp3', Uint8Array.from([0x49, 0x44, 0x33, 1, 2, 3]));
  put(dir, 'packs/art/notes.html', '<script>alert(1)</script>');
  putBytes(dir, 'packs/art/img/unnamed.png', PNG); // not named by the manifest: never served
  put(dir, 'packs/bgm/pack.json', { type: 'assets', name: 'BGM', files: { map: 'map.json', media: ['a.mp3'] } });
  put(dir, 'packs/bgm/map.json', { '/assets/audio/bgm/combat.mp3': '/packs/bgm/a.mp3' });
  putBytes(dir, 'packs/bgm/a.mp3', Uint8Array.from([0x49, 0x44, 0x33, 9]));
  return dir;
}

test('an assets pack loads: the map is listed, the media pool is served but never listed', () => {
  const root = assetsRoot();
  try {
    const scan = scanPacks(dirsOf(root), { app: APP });
    assert.deepEqual(scan.skipped, [], 'nothing is skipped');
    const art = scan.packs.find((p) => p.id === 'art');
    assert.equal(art.type, 'assets');
    assert.deepEqual(art.overrides, ['/assets/char/amiya.png', '/assets/audio/bgm/lobby.mp3']);
    assert.deepEqual(art.files.media.map((f) => f.rel), ['img/amiya.png', 'img/bgm.mp3']);

    const index = packIndexOf(scan.packs, { app: APP });
    const entry = index.packs.find((p) => p.id === 'art');
    assert.equal(entry.type, 'assets');
    assert.equal(entry.overrides, 2);
    assert.deepEqual(Object.keys(entry.files), ['map'], 'the pool stays out of an index every visitor fetches');
    assert.equal(entry.files.map, '/packs/art/map.json');
    assert.equal(entry.name, '替换立绘');
    assert.deepEqual(index.packs.map((p) => p.id).sort(), ['art', 'bgm'], 'sorted by type then id');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the file allowlist stays exact: the map and the pool are servable, anything else never is', () => {
  const root = assetsRoot();
  try {
    const dirs = dirsOf(root);
    const reg = createPackRegistry(dirs, { app: APP, recheckMs: 0 });
    assert.equal(reg.servable('art', 'map.json'), path.join(dirs.packsDir, 'art', 'map.json'));
    assert.equal(reg.servable('art', 'img/amiya.png'), path.join(dirs.packsDir, 'art', 'img', 'amiya.png'));
    assert.equal(reg.servable('art', 'img/bgm.mp3'), path.join(dirs.packsDir, 'art', 'img', 'bgm.mp3'));
    assert.equal(reg.servable('art', 'pack.json'), null, 'a manifest is not served');
    assert.equal(reg.servable('art', 'notes.html'), null, 'a file the manifest does not name is not served');
    assert.equal(reg.servable('art', 'img/unnamed.png'), null, 'nor is a media file outside the pool');
    assert.equal(reg.servable('art', '../secret.txt'), null);
    assert.equal(reg.servable('nope', 'map.json'), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a map value must be one of the pack’s own media files', () => {
  const root = tmpdir('bad');
  try {
    put(root, 'packs/p/pack.json', { type: 'assets', files: { map: 'map.json', media: ['a.png'] } });
    putBytes(root, 'packs/p/a.png', PNG);
    // the game's own art, another pack, a traversal, an empty value, a non-string: all refused, with the reason
    put(root, 'packs/p/map.json', {
      '/assets/x.png': '/assets/char/amiya.png',
      '/assets/y.png': '/packs/other/a.png',
      '/assets/z.png': '/packs/p/../p/a.png',
      '/assets/w.png': '',
      '/assets/v.png': 3,
    });
    const why = reasons(scanPacks(dirsOf(root), { app: APP }));
    assert.match(why['packs/p/'], /files\.map "\/assets\/x\.png": \/assets\/char\/amiya\.png is not one of this pack's media files/);
    assert.match(why['packs/p/'], /"\/assets\/y\.png": \/packs\/other\/a\.png is not one of this pack's media files/);
    assert.match(why['packs/p/'], /"\/assets\/z\.png": \/packs\/p\/\.\.\/p\/a\.png is not one of this pack's media files/);
    assert.match(why['packs/p/'], /"\/assets\/w\.png": the value is not a string/);
    assert.match(why['packs/p/'], /"\/assets\/v\.png": the value is not a string/);

    // a key that is not a path on this server
    put(root, 'packs/p/map.json', { 'https://example.com/x.png': '/packs/p/a.png' });
    assert.match(reasons(scanPacks(dirsOf(root), { app: APP }))['packs/p/'], /not a path on this server/);

    // a good map loads once the values point at the pool
    put(root, 'packs/p/map.json', { '/assets/x.png': '/packs/p/a.png' });
    assert.deepEqual(reasons(scanPacks(dirsOf(root), { app: APP })), {});
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('roles: the map and the pool are required, a pool takes many files (or one), unknown extensions are refused', () => {
  const root = tmpdir('roles');
  try {
    const scan = () => scanPacks(dirsOf(root), { app: APP });
    const packOf = () => scan().packs.find((p) => p.id === 'a');
    const write = (files) => put(root, 'packs/a/pack.json', { type: 'assets', files });
    putBytes(root, 'packs/a/a.png', PNG);
    put(root, 'packs/a/map.json', {});

    // both roles are required: a map with nothing to point at, or files nothing points at, are refused
    write({ media: ['a.png'] });
    assert.match(reasons(scan())['packs/a/'], /no "files\.map"/);
    write({ map: 'map.json' });
    assert.match(reasons(scan())['packs/a/'], /no "files\.media"/);

    // the good case, and the map file itself must be there
    write({ map: 'map.json', media: ['a.png'] });
    assert.deepEqual(reasons(scan()), {});
    assert.deepEqual(packOf().overrides, [], 'an empty map is a valid (if pointless) pack');
    fs.rmSync(path.join(root, 'packs', 'a', 'map.json'));
    assert.match(reasons(scan())['packs/a/'], /files\.map: .* is missing/);
    put(root, 'packs/a/map.json', {});

    // one path instead of a list is fine (a pool of one)
    write({ map: 'map.json', media: 'a.png' });
    assert.deepEqual(reasons(scan()), {});
    assert.deepEqual(packOf().files.media.map((f) => f.rel), ['a.png']);

    // an extension the type does not allow (a pack is data, never a program)
    putBytes(root, 'packs/a/run.exe', Uint8Array.from([0x4d, 0x5a]));
    write({ map: 'map.json', media: ['run.exe'] });
    assert.match(reasons(scan())['packs/a/'], /"files\.media": "run\.exe" must be a .* file/);

    // a named file that is not there
    write({ map: 'map.json', media: ['a.png', 'gone.png'] });
    assert.match(reasons(scan())['packs/a/'], /files\.media: gone\.png is missing/);

    // a plain role never takes a list (the lang type's shape is unchanged)
    const many = normalizeManifest({ type: 'lang', lang: 'qaa', files: { ui: ['a.json', 'b.json'] } }, { id: 'qaa', type: 'lang', lang: 'qaa', folder: true });
    assert.match(many.problems.join('; '), /"files\.ui" takes one path, not a list/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('two packs rewriting the same URL both load, the later id wins, and the conflict is reported', () => {
  const root = tmpdir('conflict');
  try {
    for (const id of ['aaa', 'zzz']) {
      put(root, `packs/${id}/pack.json`, { type: 'assets', files: { map: 'map.json', media: ['a.png'] } });
      put(root, `packs/${id}/map.json`, { '/assets/char/amiya.png': `/packs/${id}/a.png` });
      putBytes(root, `packs/${id}/a.png`, PNG);
    }
    const scan = scanPacks(dirsOf(root), { app: APP });
    assert.deepEqual(scan.packs.map((p) => p.id), ['aaa', 'zzz'], 'both load (the client applies them in index order)');
    const conflict = scan.warnings.find((w) => /already rewritten by aaa/.test(w.warning));
    assert.ok(conflict, 'the conflict is reported');
    assert.equal(conflict.where, 'packs/zzz/');
    assert.match(conflict.warning, /this pack wins: the index is sorted by id/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a client reads the assets entries of the index: the map URL is required, off-site URLs are dropped', () => {
  const index = { version: 1, app: APP, packs: [
    { id: 'art', type: 'assets', name: 'x', overrides: 2, files: { map: '/packs/art/map.json' } },
    { id: 'many', type: 'assets', name: 'y', files: { map: '/packs/many/map.json', media: ['/packs/many/a.png', '/packs/many/b.png'] } },
    { id: 'nomap', type: 'assets', name: 'z', files: {} },
    { id: 'evil', type: 'assets', name: 'e', files: { map: 'https://example.com/map.json' } },
    { id: 'en', type: 'lang', lang: 'en', name: 'English', files: { ui: '/i18n/en.json' } },
    { id: 'bad id!', type: 'assets', name: 'b', files: { map: '/packs/x/map.json' } },
  ] };
  const got = readPackIndex(index, 'assets');
  assert.deepEqual(got.map((e) => e.id), ['art', 'many'], 'no map / an off-site map / a bad id are dropped');
  assert.equal(got[0].files.map, '/packs/art/map.json');
  assert.deepEqual(got[1].files.media, ['/packs/many/a.png', '/packs/many/b.png'], 'a pool given as URLs keeps its list');
  assert.deepEqual(readPackIndex(index).map((e) => e.id), ['art', 'many', 'en'], 'without a type: every supported pack');
  assert.equal(PACK_TYPES.assets.status, 'supported');
  assert.equal(PACK_TYPES.assets.live, true, 'a dropped-in pack shows without a restart');
  assert.ok(isPackPath('img/amiya.png') && !isPackPath('../a.png'));
});

test('an assets pack dropped in while the server runs shows on the next look', () => {
  const root = tmpdir('live');
  try {
    const dirs = dirsOf(root);
    const reg = createPackRegistry(dirs, { app: APP, recheckMs: 0 });
    assert.deepEqual(reg.list('assets'), []);
    put(root, 'packs/new/pack.json', { type: 'assets', files: { map: 'map.json', media: ['a.png'] } });
    put(root, 'packs/new/map.json', { '/assets/x.png': '/packs/new/a.png' });
    putBytes(root, 'packs/new/a.png', PNG);
    assert.deepEqual(reg.list('assets').map((p) => p.id), ['new']);
    assert.equal(reg.index().packs.find((p) => p.id === 'new').overrides, 1);
    fs.rmSync(path.join(root, 'packs', 'new'), { recursive: true, force: true });
    assert.deepEqual(reg.list('assets'), [], 'a removed pack leaves');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the shipped checkout has no assets packs yet, and its language packs are untouched', () => {
  const served = createPackRegistry(
    { publicDir: path.join(ROOT, 'public'), dataDir: path.join(ROOT, 'data'), packsDir: path.join(ROOT, 'packs') },
    { app: APP },
  );
  assert.deepEqual(served.list('assets'), [], 'packs/ ships only its README');
  assert.ok(served.list('lang').length >= 4, 'the language packs still load');
  const entry = served.index().packs.find((p) => p.type === 'lang');
  assert.equal(typeof entry.files.ui, 'string', 'the lang index shape is a string, as it always was');
});

// ---- the client half (public/js/ui/assetPacks.js + the data.js transform hook) --------------------------------------

/** A manifest shaped like data/assets.json: a few URLs in the places the game actually reads them from. */
const fakeManifest = () => ({
  chars: {
    char_x: {
      avatar: '/assets/char/avatar/char_x.png',
      portrait: '/assets/char/portrait/char_x.png',
      spine: { front: { skel: '/assets/spine/op/char_x/front/char_x.skel', atlas: '/assets/spine/op/char_x/front/char_x.atlas', textures: ['/assets/spine/op/char_x/front/char_x.png'] } },
      skins: { 'char_x@a#1': { avatar: '/assets/char/skin_avatar/char_x_a_1.png' } },
    },
  },
  audio: { bgm: { lobby: { loop: '/assets/audio/bgm/lobby.mp3' } } },
  items: { item_x: '/assets/item/item_x.png' },
});

test('the client rewrites the loaded manifest: replacement and addition alike, deep, and version-stamped', async () => {
  const packs = await import('../public/js/ui/assetPacks.js');
  const index = { version: 1, app: APP, packs: [{ id: 'art', type: 'assets', name: 'Art', version: '2.1.0', files: { map: '/packs/art/map.json' } }] };
  const map = {
    '/assets/char/avatar/char_x.png': '/packs/art/img/new.png',                 // replace
    '/assets/spine/op/char_x/front/char_x.skel': '/packs/art/spine/new.skel',   // deep: inside the spine record
    '/assets/audio/bgm/lobby.mp3': '/packs/art/bgm.mp3',                        // the manifest's own audio entries
    '/assets/char/avatar/char_new.png': '/packs/art/img/new.png',               // add: a URL nothing points at yet
  };
  const asked = [];
  const fetchFake = async (url) => {
    asked.push(url);
    const body = url === '/packs/index.json' ? index : url === '/packs/art/map.json' ? map : null;
    return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => null };
  };
  const report = await packs.loadAssetPacks({ fetchImpl: fetchFake });
  assert.deepEqual(asked, ['/packs/index.json', '/packs/art/map.json']);
  assert.deepEqual(report.packs, [{ id: 'art', name: 'Art', version: '2.1.0', overrides: 4 }]);
  assert.deepEqual(report.conflicts, []);
  assert.equal(report.count, 4);
  assert.equal(packs.assetOverride('/assets/char/avatar/char_x.png'), '/packs/art/img/new.png?v=2.1.0');

  const manifest = fakeManifest();
  const changed = packs.applyAssetOverrides(manifest);
  assert.equal(changed, 3, 'the "add" key changes nothing on its own: nothing points at it yet');
  assert.equal(manifest.chars.char_x.avatar, '/packs/art/img/new.png?v=2.1.0');
  assert.equal(manifest.chars.char_x.spine.front.skel, '/packs/art/spine/new.skel?v=2.1.0');
  assert.equal(manifest.chars.char_x.spine.front.atlas, '/assets/spine/op/char_x/front/char_x.atlas', 'an unmapped URL is left alone');
  assert.equal(manifest.audio.bgm.lobby.loop, '/packs/art/bgm.mp3?v=2.1.0');
  assert.equal(manifest.chars.char_x.skins['char_x@a#1'].avatar, '/assets/char/skin_avatar/char_x_a_1.png');
  assert.equal(packs.applyAssetOverrides(manifest), 0, 'a second pass changes nothing');
});

test('two client-side packs: the later index entry wins, the conflict is reported, and neither breaks the other', async () => {
  const packs = await import('../public/js/ui/assetPacks.js');
  const index = { version: 1, app: APP, packs: [
    { id: 'aaa', type: 'assets', name: 'A', version: '1', files: { map: '/packs/aaa/map.json' } },
    { id: 'zzz', type: 'assets', name: 'Z', version: '1', files: { map: '/packs/zzz/map.json' } },
  ] };
  const fetchFake = async (url) => {
    const body = url === '/packs/index.json' ? index
      : url === '/packs/aaa/map.json' ? { '/assets/a.png': '/packs/aaa/a.png', '/assets/same.png': '/packs/aaa/same.png' }
        : url === '/packs/zzz/map.json' ? { '/assets/same.png': '/packs/zzz/same.png', '/assets/z.png': '/packs/zzz/z.png' }
          : null;
    return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => null };
  };
  const report = await packs.loadAssetPacks({ fetchImpl: fetchFake });
  assert.deepEqual(report.packs.map((p) => p.id), ['aaa', 'zzz']);
  assert.equal(report.count, 3);
  assert.equal(packs.assetOverride('/assets/a.png'), '/packs/aaa/a.png?v=1');
  assert.equal(packs.assetOverride('/assets/same.png'), '/packs/zzz/same.png?v=1', 'the later id wins');
  assert.deepEqual(report.conflicts, [{ url: '/assets/same.png', packs: ['aaa', 'zzz'] }]);
});

test('the client survives a broken index, a missing map and a map of the wrong shape', async () => {
  const packs = await import('../public/js/ui/assetPacks.js');
  const miss = await packs.loadAssetPacks({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => null }) });
  assert.equal(miss.loaded, false);
  assert.match(miss.error, /index HTTP 500/);
  assert.equal(packs.applyAssetOverrides(fakeManifest()), 0, 'nothing is rewritten without packs');

  const index = { version: 1, app: APP, packs: [
    { id: 'gone', type: 'assets', name: 'G', files: { map: '/packs/gone/map.json' } },
    { id: 'weird', type: 'assets', name: 'W', files: { map: '/packs/weird/map.json' } },
    { id: 'ok', type: 'assets', name: 'O', version: '1', files: { map: '/packs/ok/map.json' } },
  ] };
  const fetchFake = async (url) => {
    if (url === '/packs/index.json') return { ok: true, status: 200, json: async () => index };
    if (url === '/packs/weird/map.json') return { ok: true, status: 200, json: async () => [1, 2] };
    if (url === '/packs/ok/map.json') return { ok: true, status: 200, json: async () => ({ '/assets/a.png': '/packs/ok/a.png', '/assets/bad.png': 7 }) };
    return { ok: false, status: 404, json: async () => null };
  };
  const report = await packs.loadAssetPacks({ fetchImpl: fetchFake });
  assert.deepEqual(report.packs.map((p) => p.id), ['ok'], 'a missing or malformed map is skipped, the others still load');
  assert.equal(report.count, 1, 'a non-string target is ignored');
  assert.equal(packs.assetOverride('/assets/a.png'), '/packs/ok/a.png?v=1');
});

test('the data store runs the transform as the manifest arrives, so a pack is applied in the same load', async () => {
  const { createDataStore, onManifest } = await import('../public/js/data.js');
  const packs = await import('../public/js/ui/assetPacks.js');
  await packs.loadAssetPacks({
    fetchImpl: async (url) => (url === '/packs/index.json'
      ? { ok: true, status: 200, json: async () => ({ version: 1, app: APP, packs: [{ id: 'art', type: 'assets', name: 'A', version: '9', files: { map: '/packs/art/map.json' } }] }) }
      : { ok: true, status: 200, json: async () => ({ '/assets/char/avatar/char_x.png': '/packs/art/a.png' }) }),
  });
  const store = createDataStore({ base: '/data/', fetch: async () => ({ ok: true, status: 200, json: async () => fakeManifest() }) });
  const off = store.onManifest('assets', (m) => { packs.applyAssetOverrides(m); });
  const got = await store.load('assets');
  assert.equal(got.chars.char_x.avatar, '/packs/art/a.png?v=9', 'rewritten by the time the store hands it out');
  assert.equal(store.get('assets').chars.char_x.avatar, '/packs/art/a.png?v=9');
  off();
  assert.equal(typeof onManifest, 'function', 'the singleton exposes the same hook');
});
