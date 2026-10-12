// The "data" content pack (docs/PACKS.md §4): data patches the server applies at start.
//
// A pack ships `{ "<data file>": <merge patch> }` (RFC 7386) and the server merges it into the tables it loaded. The
// point of the type is agreement: the same patched tables are what /data/<name>.json serves, so a browser reads what the
// server simulates with — a data pack is never a client-side change. `live: false`: the simulation's data is fixed for
// the life of the process, so a pack added while the server runs takes effect at the next start.
//
// These tests cover the merge semantics (add / replace / delete / arrays), what a patch may not do (replace or delete a
// whole table, name a file that is not a data file), the frozen base staying untouched, the index entry, and a real
// server boot with a pack in a temporary packs/ folder serving the patched table while the file on disk stays as it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACK_TYPES, readPackIndex } from '../shared/packs.js';
import { scanPacks, createPackRegistry, packIndexOf } from '../server/packs.js';
import { mergePatch, collectDataPatches, applyDataPacks, dataPackTag } from '../server/dataPacks.js';
import { startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = '0.2.4';

const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sp-data-${tag}-`));
const put = (dir, rel, body) => {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};
const dirsOf = (root) => ({ publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), packsDir: path.join(root, 'packs') });
const reasons = (scan) => Object.fromEntries(scan.skipped.map((s) => [s.where, s.problems.join('; ')]));
const silent = { info() {}, warn() {}, error() {} };

test('mergePatch: objects merge, scalars and arrays replace, null deletes, nothing is mutated', () => {
  const base = { a: { b: 1, c: 2 }, list: [1, 2, 3], keep: 'x', gone: true };
  const patched = mergePatch(base, { a: { c: 9, d: 3 }, list: [7], gone: null });
  assert.deepEqual(patched, { a: { b: 1, c: 9, d: 3 }, list: [7], keep: 'x' });
  assert.deepEqual(base, { a: { b: 1, c: 2 }, list: [1, 2, 3], keep: 'x', gone: true }, 'the base is untouched');
  assert.deepEqual(mergePatch({ a: 1 }, { a: 2 }), { a: 2 });
  assert.deepEqual(mergePatch({ a: { b: 1 } }, { a: { b: { c: 2 } } }), { a: { b: { c: 2 } } }, 'a scalar becomes an object');
  assert.deepEqual(mergePatch(null, { a: 1 }), { a: 1 }, 'no base: the patch stands alone');
  assert.equal(mergePatch({ a: 1 }, null), null, 'a null patch deletes (refused at the top level by applyDataPacks)');
});

test('a data pack loads and its patch files are validated against the data files the game has', () => {
  const root = tmpdir('bad');
  try {
    const scan = () => scanPacks(dirsOf(root), { app: APP });
    put(root, 'packs/p/pack.json', { type: 'data', name: 'P', files: { patch: 'patch.json' } });

    // a good one
    put(root, 'packs/p/patch.json', { config: { probe: true }, chess: { chess_x: { name: 'X' } } });
    assert.deepEqual(reasons(scan()), {});
    assert.equal(scan().packs.find((p) => p.id === 'p').patches.length, 2);
    assert.equal(packIndexOf(scan().packs, { app: APP }).packs[0].patches, 2, 'the index says how many tables it patches');

    // a table the game does not have
    put(root, 'packs/p/patch.json', { nope: { a: 1 } });
    assert.match(reasons(scan())['packs/p/'], /"nope" is not a data file \(config, chess, /);

    // a patch that would replace or delete a whole table
    for (const value of [null, [1, 2], 7, 'x']) {
      put(root, 'packs/p/patch.json', { config: value });
      assert.match(reasons(scan())['packs/p/'], /"config" must map to an object \(a merge patch\), not/);
    }

    // the patch file itself
    put(root, 'packs/p/patch.json', '[1,2]');
    assert.match(reasons(scan())['packs/p/'], /not a JSON object of data file → patch/);
    fs.rmSync(path.join(root, 'packs', 'p', 'patch.json'));
    assert.match(reasons(scan())['packs/p/'], /files\.patch: patch\.json is missing/);
    put(root, 'packs/p/pack.json', { type: 'data', name: 'P' });
    assert.match(reasons(scan())['packs/p/'], /no "files\.patch"/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('applyDataPacks: only what a pack touches changes, and a patch that would break a table is refused', () => {
  const frozen = Object.freeze({ a: Object.freeze({ n: 1 }), b: Object.freeze({ keep: true }) });
  const packs = [
    { id: 'aaa', patches: [{ file: 'a', patch: { n: 2, extra: 'x' } }] },
    { id: 'zzz', patches: [{ file: 'a', patch: { zzz: true } }] },
    { id: 'bad', patches: [{ file: 'a', patch: { n: { deep: 1 } } }] },
  ];
  const warnings = [];
  const r = applyDataPacks(frozen, packs, { log: { info() {}, warn: (m) => warnings.push(m) }, known: ['a', 'b'] });
  assert.deepEqual(r.tables.a, { n: { deep: 1 }, extra: 'x', zzz: true }, 'packs merge in order, the later id last');
  assert.equal(r.tables.b, frozen.b, 'an untouched table is the very same object (the file is served byte for byte)');
  assert.deepEqual(r.applied, [{ file: 'a', packs: ['aaa', 'zzz', 'bad'] }]);
  assert.deepEqual([...r.overrides.keys()], ['a']);

  // a patch for a table this game does not have is ignored (the `known` list is DATA_FILES), and nothing is applied
  const unknown = applyDataPacks(frozen, [{ id: 'x', patches: [{ file: 'nope', patch: { a: 1 } }] }], { known: ['a', 'b'], log: { warn() {} } });
  assert.deepEqual(unknown.applied, []);
  assert.equal(unknown.tables, frozen, 'nothing applied: the tables are the loaded ones');
  assert.equal(unknown.overrides.size, 0);

  // collectDataPatches: one entry per file, with every pack that patches it
  const byFile = collectDataPatches([{ id: 'p1', patches: [{ file: 'a', patch: { x: 1 } }] }, { id: 'p2', patches: [{ file: 'a', patch: { y: 2 } }, { file: 'b', patch: { z: 3 } }] }]);
  assert.deepEqual([...byFile.keys()], ['a', 'b']);
  assert.deepEqual(byFile.get('a'), { file: 'a', patch: { x: 1, y: 2 }, packs: ['p1', 'p2'] });

  // the tag: empty without patches, stable for a set, independent of the order the pack files were scanned in
  assert.equal(dataPackTag({ applied: [] }, (t) => t), '');
  const hash = (t) => `${t.length}`.padStart(12, '0');
  const tag1 = dataPackTag({ applied: [{ file: 'b', packs: ['p1'] }, { file: 'a', packs: ['p1', 'p2'] }] }, hash);
  const tag2 = dataPackTag({ applied: [{ file: 'a', packs: ['p1', 'p2'] }, { file: 'b', packs: ['p1'] }] }, hash);
  assert.equal(tag1, tag2);
});

test('the index and the client read a data entry: the patch URL, the count, and live: false', () => {
  assert.equal(PACK_TYPES.data.status, 'supported');
  assert.equal(PACK_TYPES.data.live, false, 'the simulation data is fixed for the life of the process');
  const index = { version: 1, app: APP, packs: [
    { id: 'bal', type: 'data', name: 'Balance', patches: 3, files: { patch: '/packs/bal/patch.json' } },
    { id: 'nopatch', type: 'data', name: 'X', files: {} },
    { id: 'art', type: 'assets', name: 'A', files: { map: '/packs/art/map.json' } },
  ] };
  const got = readPackIndex(index, 'data');
  assert.deepEqual(got.map((e) => e.id), ['bal'], 'an entry without its patch file is dropped');
  assert.equal(got[0].patches, 3);
  assert.equal(got[0].files.patch, '/packs/bal/patch.json');
});

test('a real server boot: the patched table is what it serves, and the file on disk is untouched', async () => {
  const packsDir = tmpdir('boot');
  try {
    put(packsDir, 'probe/pack.json', { type: 'data', name: '探针', version: '1.0.0', app: '>=0.2.0', authors: ['t'], files: { patch: 'patch.json' } });
    put(packsDir, 'probe/patch.json', { config: { packsProbe: { from: 'probe' } } });
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, packsDir });
    try {
      assert.deepEqual(srv.dataPacks.applied, [{ file: 'config', packs: ['probe'] }]);
      assert.equal(srv.dataPacks.tag.length, 12);
      assert.deepEqual(srv.dataPacks.overrides.get('config').packsProbe, { from: 'probe' });

      const served = await (await fetch(`${srv.url}/data/config.json`)).json();
      assert.deepEqual(served.packsProbe, { from: 'probe' }, 'the client is served the patched table');
      const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
      assert.equal(onDisk.packsProbe, undefined, 'the file on disk is never written to');

      const other = await (await fetch(`${srv.url}/data/chess.json`)).text();
      assert.equal(other, fs.readFileSync(path.join(ROOT, 'data', 'chess.json'), 'utf8'), 'an unpatched table is served byte for byte');
      const index = await (await fetch(`${srv.url}/packs/index.json`)).json();
      assert.equal(index.packs.find((p) => p.id === 'probe').patches, 1);
    } finally { await srv.close(); }
  } finally { fs.rmSync(packsDir, { recursive: true, force: true }); }
});

test('without a pack nothing changes: the tables are the loaded ones and no tag is computed', async () => {
  const packsDir = tmpdir('none');
  try {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, packsDir });
    try {
      assert.deepEqual(srv.dataPacks.applied, []);
      assert.equal(srv.dataPacks.tag, '');
      assert.equal(srv.dataPacks.overrides.size, 0);
      const served = await (await fetch(`${srv.url}/data/config.json`)).text();
      assert.equal(served, fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
    } finally { await srv.close(); }
  } finally { fs.rmSync(packsDir, { recursive: true, force: true }); }
});

test('the registry and the applier agree on what a pack declares', () => {
  const root = tmpdir('agree');
  try {
    put(root, 'packs/p/pack.json', { type: 'data', files: { patch: ['a.json', 'b.json'] } });
    put(root, 'packs/p/a.json', { config: { one: 1 } });
    put(root, 'packs/p/b.json', { chess: { two: 2 }, config: { two: 2 } });
    const packs = createPackRegistry(dirsOf(root), { app: APP, recheckMs: 0 }).list('data');
    assert.equal(packs.length, 1);
    assert.deepEqual(packs[0].patches, [{ file: 'config', patch: { one: 1 } }, { file: 'chess', patch: { two: 2 } }, { file: 'config', patch: { two: 2 } }]);
    const r = applyDataPacks({ config: {}, chess: {} }, packs, { known: ['config', 'chess'], log: silent });
    assert.deepEqual(r.tables, { config: { one: 1, two: 2 }, chess: { two: 2 } }, 'two patch files, merged per table');
    assert.deepEqual(r.applied, [{ file: 'config', packs: ['p'] }, { file: 'chess', packs: ['p'] }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
