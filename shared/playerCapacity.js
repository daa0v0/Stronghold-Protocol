// Capacity rules shared by the server and the browser — the POLICY half of the player capacity.
//
// What lives here and what does not (docs/MODS.md, docs/PLAYER_CAPACITY.md):
//
//   * the CAPABILITY is structural and always present: the wire can carry MAX_SEATS seats (shared/constants.js), the
//     simulation runs a 20-unit roster and the renderer draws it. A pack cannot change any of that, because the frozen v1
//     position table is what the server and every browser agree on;
//   * the POLICY is what this module holds — which room sizes a lobby offers, its default, and from how many players the
//     card pool splits into fixed groups, how many rounds the Unite vote may run, how many helpers it may bring and how
//     many draft cards a group gets. It ships as the data table `data/capacity.json` (a `data` pack can patch it, and the
//     server serves the patched version to browsers), and the built-in values below are the UPSTREAM baseline: four
//     players, one shared pool, no grouping — the state you get with the 20-player pack switched off.
//
// Both sides call `applyCapacityRules(table)` once the table is loaded (server: at boot after the packs are applied,
// client: after `data.load('capacity')`), so the lobby, the protocol validators and the match rules all agree.
import { BASE_SEATS, MAX_SEATS, MAX_DRAFT_CARDS } from './constants.js';

/** The upstream baseline: four players, a single shared pool. Also the shape of `data/capacity.json`. */
export const CAPACITY_BASELINE = Object.freeze({
  version: 1,
  capacities: Object.freeze([4]),
  defaultSeats: 4,
  groupedPoolMinPlayers: 6,
  maxUniteRounds: 5,
  coopDraftCards: MAX_DRAFT_CARDS,
  // Kept even in the baseline so a pack only has to raise `capacities` to use it (and so a pack may retune the split).
  poolGroupLayouts: Object.freeze({
    6: Object.freeze([3, 3]), 7: Object.freeze([4, 3]), 8: Object.freeze([4, 4]), 9: Object.freeze([4, 5]),
    10: Object.freeze([4, 3, 3]), 11: Object.freeze([4, 4, 3]), 12: Object.freeze([4, 4, 4]), 13: Object.freeze([5, 4, 4]),
    14: Object.freeze([4, 4, 3, 3]), 15: Object.freeze([4, 4, 4, 3]), 16: Object.freeze([4, 4, 4, 4]),
    17: Object.freeze([5, 4, 4, 4]), 18: Object.freeze([4, 4, 4, 3, 3]), 19: Object.freeze([4, 4, 4, 4, 3]),
    20: Object.freeze([4, 4, 4, 4, 4]),
  }),
});

/** @returns {{ capacities: number[], defaultSeats: number, groupedPoolMinPlayers: number, maxUniteRounds: number,
 *   maxUniteHelpers: number, coopDraftCards: number, poolGroupLayouts: Record<number, number[]> }} */
const cloneBaseline = () => ({
  capacities: [...CAPACITY_BASELINE.capacities],
  defaultSeats: CAPACITY_BASELINE.defaultSeats,
  groupedPoolMinPlayers: CAPACITY_BASELINE.groupedPoolMinPlayers,
  maxUniteRounds: CAPACITY_BASELINE.maxUniteRounds,
  maxUniteHelpers: CAPACITY_BASELINE.maxUniteRounds * 2,
  coopDraftCards: CAPACITY_BASELINE.coopDraftCards,
  poolGroupLayouts: Object.fromEntries(Object.entries(CAPACITY_BASELINE.poolGroupLayouts).map(([k, v]) => [Number(k), [...v]])),
});

/** @type {ReturnType<typeof cloneBaseline>} */
let rules = cloneBaseline();

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Apply a `data/capacity.json` table (docs/MODS.md). Every field is optional and validated on its own: a pack that gets one
 * value wrong loses that value, not the console, the lobby or the match. Unknown keys are ignored.
 * @param {any} table
 * @returns {{ applied: string[], rejected: string[] }}
 */
export function applyCapacityRules(table) {
  const next = cloneBaseline();
  const applied = [];
  const rejected = [];
  const source = table && typeof table === 'object' && !Array.isArray(table) ? table : {};
  if (!table || typeof table !== 'object') rejected.push('table');

  const capacities = Array.isArray(source.capacities)
    ? [...new Set(source.capacities)].filter((n) => isInt(n, 1, MAX_SEATS)).sort((a, b) => a - b) : null;
  if (capacities && capacities.length) { next.capacities = capacities; applied.push('capacities'); }
  else if (source.capacities !== undefined) rejected.push('capacities');

  if (isInt(source.defaultSeats, 1, MAX_SEATS) && next.capacities.includes(source.defaultSeats)) {
    next.defaultSeats = source.defaultSeats;
    applied.push('defaultSeats');
  } else if (source.defaultSeats !== undefined) rejected.push('defaultSeats');
  // A default that is not one of the offered sizes is not worth refusing the whole table for: fall back to the smallest.
  if (!next.capacities.includes(next.defaultSeats)) next.defaultSeats = next.capacities[0];

  if (isInt(source.groupedPoolMinPlayers, 2, MAX_SEATS)) { next.groupedPoolMinPlayers = source.groupedPoolMinPlayers; applied.push('groupedPoolMinPlayers'); }
  else if (source.groupedPoolMinPlayers !== undefined) rejected.push('groupedPoolMinPlayers');

  if (source.poolGroupLayouts && typeof source.poolGroupLayouts === 'object' && !Array.isArray(source.poolGroupLayouts)) {
    /** @type {Record<number, number[]>} */
    const layouts = {};
    let bad = 0;
    for (const [key, value] of Object.entries(source.poolGroupLayouts)) {
      const players = Number(key);
      const sizes = Array.isArray(value) ? value : null;
      const ok = isInt(players, 2, MAX_SEATS) && sizes && sizes.length
        && sizes.every((n) => isInt(n, 1, MAX_SEATS)) && sizes.reduce((a, b) => a + b, 0) === players;
      if (!ok) { bad++; continue; }
      layouts[players] = [...sizes];
    }
    if (Object.keys(layouts).length) { next.poolGroupLayouts = { ...next.poolGroupLayouts, ...layouts }; applied.push('poolGroupLayouts'); }
    if (bad) rejected.push('poolGroupLayouts');
  } else if (source.poolGroupLayouts !== undefined) rejected.push('poolGroupLayouts');

  if (isInt(source.maxUniteRounds, 1, 10)) {
    next.maxUniteRounds = source.maxUniteRounds;
    next.maxUniteHelpers = source.maxUniteRounds * 2;
    applied.push('maxUniteRounds');
  } else if (source.maxUniteRounds !== undefined) rejected.push('maxUniteRounds');

  if (isInt(source.coopDraftCards, 1, 12)) { next.coopDraftCards = source.coopDraftCards; applied.push('coopDraftCards'); }
  else if (source.coopDraftCards !== undefined) rejected.push('coopDraftCards');

  rules = next;
  return { applied, rejected };
}

/** Back to the upstream baseline (tests, and a server that lost its table). */
export function resetCapacityRules() { rules = cloneBaseline(); }

/** The room sizes a lobby offers, smallest first. @returns {number[]} */
export const capacityOptions = () => [...rules.capacities];
/** The size a new room starts with. */
export const defaultSeats = () => rules.defaultSeats;
/** Whether the protocol accepts this room size (shared/protocol.js). @param {unknown} value */
export const capacityAllowed = (value) => typeof value === 'number' && Number.isInteger(value) && rules.capacities.includes(value);
/** From how many players the pool splits into fixed groups. */
export const groupedPoolMinPlayers = () => rules.groupedPoolMinPlayers;
/** The draft page size of one fixed group. */
export function coopDraftCardCount() { return rules.coopDraftCards; }
/** How many rounds the Unite vote may run at most. */
export const maxUniteRounds = () => rules.maxUniteRounds;
/** How many helpers that allows across the whole room (two per round). */
export const maxUniteHelpers = () => rules.maxUniteHelpers;

/** One shared pool below the threshold; from it on, fixed groups of three, four or five (a pack supplies the table). */
export function poolGroupSizes(players) {
  if (!Number.isInteger(players) || players < 1 || players > MAX_SEATS) throw new RangeError('invalid player count');
  if (players < rules.groupedPoolMinPlayers) return [players];
  const layout = rules.poolGroupLayouts[players];
  if (layout) return [...layout];
  // Safety net: a pack that offers a size without giving it a layout must not crash a match at start. Split evenly into
  // groups of four, moving the remainder into the leading groups (6 → [3,3], 7 → [4,3], 20 → [4,4,4,4,4]); supply layouts
  // in `data/capacity.json` to control the split exactly.
  const groups = Math.ceil(players / (BASE_SEATS + 1));
  const base = Math.floor(players / groups);
  let extra = players % groups;
  return Array.from({ length: groups }, () => base + (extra-- > 0 ? 1 : 0));
}

/** A three-player group keeps the complete original pool; only a five-player group expands. */
export const poolCopyScale = (groupSize) => Math.max(1, groupSize / BASE_SEATS);

/** The opening pool-group count sets the Unite limit; later departures never lower it. */
export const uniteRoundLimit = (poolGroupCount) => Number.isInteger(poolGroupCount)
  ? Math.max(1, Math.min(rules.maxUniteRounds, poolGroupCount)) : 1;

/** Keep the original <=4 player unlock requirement; larger teams need proportionally more layers. */
export const coopHiddenLayerThreshold = (baseline, players) => Math.ceil(baseline * Math.max(1, players / BASE_SEATS));
