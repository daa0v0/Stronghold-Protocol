// public/js/ui/roomMods.js — pure helpers of the per-room content-pack choice (docs/PACKS.md §4).
//
// The create-room panel needs two things that are worth keeping out of the component: which packs a host may toggle (a
// type that is not live cannot be dropped per room, server/lobby.js) and what `mods` to put in `room.create` (leaving the
// field out means "everything the owner enabled"). No DOM, no net: the tests and the browser both call these.

import { PACK_TYPES } from '../../../shared/packs.js';

/**
 * The identity packs of an index, split the way the panel shows them: `toggle` = a host may drop it for one room,
 * `locked` = it cannot (a type that is not live: its tables were fixed when the server started).
 * @param {{ id: string, type: string, name?: string, version?: string }[]} entries
 */
export function modChoices(entries) {
  /** @type {{ id: string, type: string, name: string, version: string }[]} */
  const toggle = [];
  /** @type {{ id: string, type: string, name: string, version: string }[]} */
  const locked = [];
  for (const e of entries || []) {
    const kind = PACK_TYPES[e.type];
    if (!kind || kind.identity !== true) continue; // a language pack is not part of a match
    const row = { id: e.id, type: e.type, name: e.name || e.id, version: e.version || '' };
    (kind.live === false ? locked : toggle).push(row);
  }
  return { toggle, locked };
}

/**
 * The `mods` field for `room.create`, or undefined to leave it out. Leaving it out is the honest encoding of "everything
 * the owner enabled" (server/lobby.js), and it keeps an unmodded server's request byte-identical to what it always was.
 * @param {string[]} selected the ids the host ticked
 * @param {{ toggle: { id: string }[], locked: { id: string }[] }} choices
 * @returns {string[] | undefined}
 */
export function modsForCreate(selected, choices) {
  const picked = new Set(selected || []);
  // A locked pack is always in force: adding it keeps the request explicit when anything else is dropped.
  for (const row of choices.locked) picked.add(row.id);
  const all = [...choices.toggle, ...choices.locked].map((r) => r.id);
  const chosen = all.filter((id) => picked.has(id));
  if (chosen.length === all.length) return undefined;
  return chosen;
}

/**
 * Whether the packs this page applied are the ones a room runs: the room's own tag against the tag of `appliedIds`.
 * An empty `roomTag` (an older server, or a frame that has not arrived) is not a mismatch — it is "nothing to compare".
 * @param {string} roomTag @param {string} appliedTag
 */
export function roomContentOk(roomTag, appliedTag) {
  return !roomTag || !appliedTag || roomTag === appliedTag;
}
