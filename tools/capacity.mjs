// tools/capacity.mjs — `data/capacity.json`, the room-size baseline table (docs/MODS.md, docs/PLAYER_CAPACITY.md).
//
// The base table is the UPSTREAM baseline (four players, one pool, no grouping); the 4/8/10/16/20 policy this fork ships is
// the data pack `packs/capacity-20/`, which a server applies at boot. Keeping the two apart is what makes the capacity a
// mod: switching the pack off really returns a server to upstream behaviour.
//
//   node tools/capacity.mjs --write     regenerate data/capacity.json from the module's CAPACITY_BASELINE
//   node tools/capacity.mjs --check     fail if the file drifted from it, or if the shipped pack no longer applies cleanly
//
// The file is generated data even though it is small and readable: `data/*.json` is never edited by hand in this repository
// (AGENTS.md), so its owner is this tool rather than an editor.
//
// Exit codes: 0 = in step, 1 = drifted or the pack is broken, 2 = bad arguments.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPACITY_BASELINE, applyCapacityRules, resetCapacityRules } from '../shared/playerCapacity.js';

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'));
const TABLE = join(ROOT, 'data', 'capacity.json');
const PACK = join(ROOT, 'packs', 'capacity-20', 'patch.json');

/** The baseline as the file should hold it: plain numbers, layouts as arrays, keys in a stable order. */
function baselineTable() {
  return {
    version: CAPACITY_BASELINE.version,
    capacities: [...CAPACITY_BASELINE.capacities],
    defaultSeats: CAPACITY_BASELINE.defaultSeats,
    groupedPoolMinPlayers: CAPACITY_BASELINE.groupedPoolMinPlayers,
    maxUniteRounds: CAPACITY_BASELINE.maxUniteRounds,
    coopDraftCards: CAPACITY_BASELINE.coopDraftCards,
    poolGroupLayouts: Object.fromEntries(Object.entries(CAPACITY_BASELINE.poolGroupLayouts).map(([k, v]) => [k, [...v]])),
  };
}

const serialise = (table) => JSON.stringify(table, null, 2) + '\n';

/** @param {string[]} argv */
function main(argv) {
  const write = argv.includes('--write');
  const check = argv.includes('--check') || !write;
  if (!write && !check) { console.error('usage: node tools/capacity.mjs [--write | --check]'); return 2; }
  const expected = baselineTable();

  if (write) {
    writeFileSync(TABLE, serialise(expected));
    console.log(`capacity: wrote ${TABLE}`);
    return 0;
  }

  let problems = 0;
  /** @type {any} filled by the parse below (a failure returns before it is read) */
  let actual;
  try { actual = JSON.parse(readFileSync(TABLE, 'utf8')); }
  catch (error) { console.error(`✘ ${TABLE}: ${error.message}`); return 1; }
  const same = JSON.stringify({ ...actual, poolGroupLayouts: actual.poolGroupLayouts }) === JSON.stringify(expected);
  if (!same) {
    problems++;
    console.error('✘ data/capacity.json has drifted from the baseline in shared/playerCapacity.js — run --write');
    for (const key of Object.keys(expected)) {
      const a = JSON.stringify(actual[key]); const b = JSON.stringify(expected[key]);
      if (a !== b) console.error(`    ${key}: file ${a} ≠ baseline ${b}`);
    }
  }

  // The shipped pack must apply cleanly on top of that baseline: this is the pairing the whole feature rests on.
  try {
    const patch = JSON.parse(readFileSync(PACK, 'utf8'));
    resetCapacityRules();
    const result = applyCapacityRules(patch.capacity);
    if (result.rejected.length) { problems++; console.error(`✘ packs/capacity-20 rejected: ${result.rejected.join(', ')}`); }
    if (JSON.stringify(result.applied.length) === JSON.stringify(0)) { problems++; console.error('✘ packs/capacity-20 applied nothing'); }
    if (!problems) console.log(`capacity: baseline in step; packs/capacity-20 applies (${result.applied.length} fields, ${patch.capacity.capacities.join('/')})`);
  } catch (error) {
    problems++;
    console.error(`✘ ${PACK}: ${error.message}`);
  } finally { resetCapacityRules(); }
  return problems ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
