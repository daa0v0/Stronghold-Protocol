// The 20-player capacity as a mod (docs/MODS.md): the CAPABILITY is structural — the frozen v1 wire carries MAX_SEATS
// seats, the simulation runs that many units and the renderer draws them — while the POLICY (which room sizes a lobby
// offers, its default, and the grouping/unite rules a big room needs) ships as the data pack `packs/capacity-20/`.
//
// This file pins both halves: the base table is the upstream baseline (so switching the pack off really is upstream), the
// pack restores exactly the policy this fork had in code before, and a server serves whatever the packs produced.
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
import { validateC2S } from '../shared/protocol.js';
import {
  CAPACITY_BASELINE, applyCapacityRules, capacityAllowed, capacityOptions, coopDraftCardCount, defaultSeats,
  groupedPoolMinPlayers, maxUniteRounds, poolGroupSizes, resetCapacityRules, uniteRoundLimit,
} from '../shared/playerCapacity.js';
import { useCapacityPack } from './helpers/capacity.js';

const PACK_ID = 'capacity-20';
const silent = { info() {}, warn() {}, error() {} };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const FORK_POLICY = { capacities: [4, 8, 10, 16, 20], defaultSeats: 8 };

test('the pack ships, is discovered, and is a well-formed data pack', () => {
  const registry = createPackRegistry(serveDirs({}), { log: silent });
  const entry = registry.index().packs.find((p) => p.id === PACK_ID);
  assert.ok(entry, `${PACK_ID} is not in the pack index — did the folder lose its pack.json?`);
  assert.equal(entry.type, 'data');
  assert.equal(entry.compatible, true);
  assert.equal(entry.patches, 1, 'one patch entry (it patches the single table `capacity`)');
  assert.deepEqual(registry.list('data').map((p) => p.id).sort(), [PACK_ID, 'stronghold-skins']);
});

test('the base table is the upstream baseline, so the pack is what makes this a 20-player server', () => {
  const base = readJson(path.join(DATA_DIR, 'capacity.json'));
  assert.deepEqual(base.capacities, CAPACITY_BASELINE.capacities, 'data/capacity.json must stay the baseline');
  assert.equal(base.defaultSeats, CAPACITY_BASELINE.defaultSeats);
  resetCapacityRules();
  assert.deepEqual(capacityOptions(), [4], 'without the pack a lobby offers four players only');
  assert.equal(defaultSeats(), 4);
  assert.equal(capacityAllowed(20), false, 'and the protocol refuses a 20-player room');
  assert.equal(capacityAllowed(4), true);
  // refused as a FIELD (the request is well formed, the value is not offered), never by throwing
  assert.match(String(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'HARD', capacity: 20 })), /capacity/);
  assert.equal(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'HARD', capacity: 4 }), null);
});

test('applied, the pack restores exactly the policy this fork used to hold in code', () => {
  resetCapacityRules();
  const applied = useCapacityPack();
  assert.deepEqual(applied.rejected, []);
  assert.deepEqual(capacityOptions(), FORK_POLICY.capacities);
  assert.equal(defaultSeats(), FORK_POLICY.defaultSeats);
  assert.equal(groupedPoolMinPlayers(), 6);
  assert.equal(maxUniteRounds(), 5);
  assert.equal(coopDraftCardCount(), 6);
  for (const n of [1, 2, 3, 4, 5]) assert.deepEqual(poolGroupSizes(n), [n], `${n} players share one pool`);
  assert.deepEqual(poolGroupSizes(6), [3, 3]);
  assert.deepEqual(poolGroupSizes(9), [4, 5]);
  assert.deepEqual(poolGroupSizes(20), [4, 4, 4, 4, 4]);
  assert.equal(uniteRoundLimit(poolGroupSizes(20).length), 5);
  assert.equal(capacityAllowed(9), false, 'a size the pack does not offer stays invalid');
  assert.equal(capacityAllowed(16), true);
});

test('every value is validated on its own: a broken pack loses that value, not the server', () => {
  resetCapacityRules();
  const result = applyCapacityRules({
    capacities: [4, 9], defaultSeats: 99, groupedPoolMinPlayers: 1, maxUniteRounds: 0, coopDraftCards: 'six',
  });
  assert.deepEqual(capacityOptions(), [4, 9], 'a sound list is kept');
  assert.equal(defaultSeats(), 4, 'an impossible default falls back to the smallest offered size');
  assert.equal(groupedPoolMinPlayers(), CAPACITY_BASELINE.groupedPoolMinPlayers);
  assert.equal(maxUniteRounds(), CAPACITY_BASELINE.maxUniteRounds);
  assert.equal(coopDraftCardCount(), CAPACITY_BASELINE.coopDraftCards);
  assert.deepEqual(result.rejected.sort(), ['coopDraftCards', 'defaultSeats', 'groupedPoolMinPlayers', 'maxUniteRounds'].sort());
  // A size the pack offers keeps the layout the baseline table carries (a patch merges, so a layout can be retuned but
  // never removed) — and if one were ever missing, poolGroupSizes derives a split instead of failing the match start.
  assert.deepEqual(poolGroupSizes(9), [4, 5]);
  resetCapacityRules();
});

test('a server serves the pack’s policy, and switching the pack off really returns to the baseline', async () => {
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-capacity-pack-'));
  try {
    const on = await startServer({ port: 0, host: '127.0.0.1', quiet: true, serverSettingsDir: settingsDir });
    try {
      const served = await (await fetch(`${on.url}/data/capacity.json`)).json();
      assert.deepEqual(served.capacities, FORK_POLICY.capacities, 'the served table is the pack’s');
      assert.equal(served.defaultSeats, FORK_POLICY.defaultSeats);
      assert.deepEqual(capacityOptions(), FORK_POLICY.capacities, 'and the running server agrees');
      assert.equal(defaultSeats(), FORK_POLICY.defaultSeats);
      const health = await (await fetch(`${on.url}/healthz`)).json();
      assert.ok(health.mods.packs.some((p) => p.id === PACK_ID), 'the pack is part of the content identity');
    } finally { await on.close(); }

    writeServerSettings(settingsDir, { packs: { off: [PACK_ID], allow: [] } });
    const off = await startServer({ port: 0, host: '127.0.0.1', quiet: true, serverSettingsDir: settingsDir });
    try {
      const served = await (await fetch(`${off.url}/data/capacity.json`)).json();
      assert.deepEqual(served.capacities, [4], 'no pack, upstream rooms');
      assert.deepEqual(capacityOptions(), [4]);
      assert.equal(defaultSeats(), 4);
      const health = await (await fetch(`${off.url}/healthz`)).json();
      assert.ok(!health.mods.packs.some((p) => p.id === PACK_ID));
      // The structural ceiling is untouched: the table is what changed, not the wire.
      assert.equal(DATA_FILES.includes('capacity'), true);
    } finally { await off.close(); }
  } finally { fs.rmSync(settingsDir, { recursive: true, force: true }); }
});

test('the served table is what a client applies (the same story as the skins pack)', () => {
  const dirs = serveDirs({});
  const registry = createPackRegistry(dirs, { log: silent });
  const applied = applyDataPacks(loadData(dirs.dataDir, { log: silent }), registry.list('data'), { log: silent, known: DATA_FILES });
  resetCapacityRules();
  const result = applyCapacityRules(applied.tables.capacity);
  assert.deepEqual(result.rejected, [], 'the served table applies without a single rejected field');
  assert.deepEqual(capacityOptions(), FORK_POLICY.capacities);
  assert.deepEqual(poolGroupSizes(13), [5, 4, 4]);
  resetCapacityRules();
});
