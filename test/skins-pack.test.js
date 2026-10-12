// The 干员皮肤 content pack (docs/SKINS.md, docs/PACKS.md §4): the skins' CONTENT is a data pack —
// packs/stronghold-skins/ — while the FEATURE stays in the code and the art stays public/assets/.
//
// Two halves have to stay in step, and that is what this file pins: the base tables must carry no skins (or the pack would
// be decoration), the pack must carry exactly the content the base tables used to hold, and a server must serve the pack's
// version — with the pack switched off, the skins really are gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPackRegistry } from '../server/packs.js';
import { applyDataPacks } from '../server/dataPacks.js';
import { loadData, DATA_FILES, DATA_DIR } from '../server/data.js';
import { serveDirs } from '../server/http/config.js';
import { startServer } from '../server/index.js';
import { writeServerSettings } from '../server/serverSettings.js';

const PACK_ID = 'stronghold-skins';
const silent = { info() {}, warn() {}, error() {} };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const dirs = () => serveDirs({});
/** The tables a server with the repository's packs/ folder really simulates and serves with. */
function served(policy = null) {
  const d = dirs();
  const registry = createPackRegistry(d, { log: silent, policy: policy ? () => policy : undefined });
  return applyDataPacks(loadData(d.dataDir, { log: silent }), registry.list('data'), { log: silent, known: DATA_FILES });
}
const withSkins = (assets) => Object.entries(assets.chars || {}).filter(([, v]) => v.skins && Object.keys(v.skins).length);
const countSkins = (entries) => entries.reduce((n, [, v]) => n + Object.keys(v.skins).length, 0);
const countSpine = (entries) => entries.reduce((n, [, v]) => n + Object.values(v.skins).filter((s) => s && s.spine).length, 0);

test('the pack ships, is discovered, and is a well-formed data pack', () => {
  const registry = createPackRegistry(dirs(), { log: silent });
  const entry = registry.index().packs.find((p) => p.id === PACK_ID);
  assert.ok(entry, `${PACK_ID} is not in the pack index — did the folder lose its pack.json?`);
  assert.equal(entry.type, 'data');
  assert.equal(entry.compatible, true, 'a pack made for this app version must be compatible');
  assert.equal(entry.patches, 2, 'one patch entry per table it patches (assets and skins)');
  assert.equal(registry.report().skipped.filter((s) => s.where.includes(PACK_ID)).length, 0, 'nothing about it is skipped');
  assert.deepEqual(registry.list('data').map((p) => p.id), ['capacity-20', PACK_ID], 'the data packs this repository ships');
});

test('the base tables carry no skins any more — the pack is not decoration', () => {
  const assets = readJson(path.join(DATA_DIR, 'assets.json'));
  const catalogue = readJson(path.join(DATA_DIR, 'skins.json'));
  assert.equal(withSkins(assets).length, 0, 'data/assets.json still has chars[].skins blocks');
  assert.deepEqual(catalogue.chars, {}, 'data/skins.json still lists operators');
  assert.deepEqual(catalogue.counts, { chars: 0, skins: 0 });
  assert.ok(Object.keys(assets.chars).length > 200, 'and the rest of the manifest is untouched');
});

test('applied, the pack restores exactly the content the base tables used to hold', () => {
  const applied = served();
  const assets = applied.tables.assets;
  const catalogue = applied.tables.skins;
  const entries = withSkins(assets);
  assert.equal(entries.length, 172, 'operators with skins');
  assert.equal(countSkins(entries), 271, 'catalogue skins with art');
  assert.equal(countSpine(entries), 172, 'skins that carry a battle model');
  assert.deepEqual(catalogue.counts, { chars: 172, skins: 271 });
  assert.equal(Object.keys(catalogue.chars).length, 172);

  // The two halves describe the same thing: every catalogue skin has a manifest entry, and every entry is catalogued.
  let listed = 0;
  for (const [charId, list] of Object.entries(catalogue.chars)) {
    for (const skin of list) {
      assert.ok(assets.chars[charId]?.skins?.[skin.id], `${charId}/${skin.id} is catalogued but has no art entry`);
      listed++;
    }
  }
  assert.equal(listed, 271);
  for (const [charId, rec] of entries) {
    const known = new Set((catalogue.chars[charId] || []).map((s) => s.id));
    for (const skinId of Object.keys(rec.skins)) assert.ok(known.has(skinId), `${charId}/${skinId} has art but is not catalogued`);
  }
  // No art moves into the pack: the entries point at the same /assets/ URLs the owner's extraction provides.
  const avatar = Object.values(entries[0][1].skins).find((s) => s.avatar)?.avatar;
  assert.match(String(avatar), /^\/assets\//, 'the pack carries paths, not art (public/assets/ is not in git)');
});

test('a server serves the pack’s catalogue, and switching the pack off really removes the skins', async () => {
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-skinspack-'));
  try {
    const on = await startServer({ port: 0, host: '127.0.0.1', quiet: true, serverSettingsDir: settingsDir });
    try {
      const health = await (await fetch(`${on.url}/healthz`)).json();
      assert.ok(health.mods.packs.some((p) => p.id === PACK_ID), 'the pack is part of the content identity');
      const catalogue = await (await fetch(`${on.url}/data/skins.json`)).json();
      assert.deepEqual(catalogue.counts, { chars: 172, skins: 271 }, 'the served catalogue is the pack’s');
      const assets = await (await fetch(`${on.url}/data/assets.json`)).json();
      assert.equal(countSkins(withSkins(assets)), 271, 'and so is the served manifest');
      // Other tables are still served as they were written.
      const config = await (await fetch(`${on.url}/data/config.json`)).json();
      assert.ok(Object.keys(config).length > 5);
    } finally { await on.close(); }

    writeServerSettings(settingsDir, { packs: { off: [PACK_ID], allow: [] } });
    const off = await startServer({ port: 0, host: '127.0.0.1', quiet: true, serverSettingsDir: settingsDir });
    try {
      const health = await (await fetch(`${off.url}/healthz`)).json();
      assert.ok(!health.mods.packs.some((p) => p.id === PACK_ID), 'a switched-off pack is out of the identity');
      const catalogue = await (await fetch(`${off.url}/data/skins.json`)).json();
      assert.deepEqual(catalogue.counts, { chars: 0, skins: 0 }, 'no pack, no skins: the content really is the pack');
      const assets = await (await fetch(`${off.url}/data/assets.json`)).json();
      assert.equal(withSkins(assets).length, 0);
      assert.ok(Object.keys(assets.chars).length > 200, 'the operators themselves are base data, not pack data');
    } finally { await off.close(); }
  } finally { fs.rmSync(settingsDir, { recursive: true, force: true }); }
});
