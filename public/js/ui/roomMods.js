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
 * The store's copy of a `room.mods` frame (docs/PACKS.md §4). Every field the panel needs must survive here: a mapper that
 * picked only some of them is what once left the room's mod panel with nothing to show.
 * @param {any} msg the frame
 * @returns {{ code: string|null, mods: string[], fixed: string[], choosable: string[],
 *   codeMods: string[], codeChoices: { id: string, name?: string, englishName?: string, description?: string,
 *   version?: string }[], tag: string }}
 */
export function roomModsState(msg) {
  const msgObj = msg || {};
  const list = (v) => (Array.isArray(v) ? v.slice() : []);
  return {
    code: msgObj.code || null,
    mods: list(msgObj.mods),
    fixed: list(msgObj.fixed),
    choosable: list(msgObj.choosable),
    codeMods: list(msgObj.codeMods),
    codeChoices: list(msgObj.codeChoices).map((m) => ({ ...m })),
    tag: msgObj.tag || '',
  };
}

/**
 * Whether the packs this page applied are the ones a room runs: the room's own tag against the tag of `appliedIds`.
 * An empty `roomTag` (an older server, or a frame that has not arrived) is not a mismatch — it is "nothing to compare".
 * @param {string} roomTag @param {string} appliedTag
 */
export function roomContentOk(roomTag, appliedTag) {
  return !roomTag || !appliedTag || roomTag === appliedTag;
}

/**
 * The content-pack rows of a room's own panel: only what a room may drop (a fixed pack is not a choice), with the room's
 * current selection. `entries` is the pack index (for names); an id it does not know falls back to the id.
 * @param {string[]} choosable @param {{ id: string, name?: string }[]} entries @param {string[]} chosen
 */
export function packRows(choosable, entries, chosen) {
  const names = new Map((entries || []).map((e) => [e.id, e.name || e.id]));
  const on = new Set(chosen || []);
  return (choosable || []).map((id) => ({ id, name: names.get(id) || id, on: on.has(id) }));
}

/**
 * The code-mod rows of a room's own panel: every code mod the server ENABLED (a room may tick any of them), ticked when
 * this room runs it (docs/MODS.md §4.6).
 * @param {{ id: string, name?: string, description?: string }[]} codeChoices @param {string[]} codeMods
 */
export function codeModRows(codeChoices, codeMods) {
  const on = new Set(codeMods || []);
  return (codeChoices || []).map((m) => ({ id: m.id, name: m.name || m.id, description: m.description || '', on: on.has(m.id) }));
}

/**
 * The `room.setMods` payload for the host's panel: explicit lists, with the fixed packs kept in (a room cannot drop them, and
 * the server refuses a list that leaves one out). `codeOptions` is the WHOLE map of per-mod values — the ones the room already
 * had plus this dialog's changes — because a request that leaves the field out clears the room's stored values.
 * @param {string[]} fixed @param {string[]} packsOn @param {string[]} codeOn
 * @param {Record<string, Record<string, any>>} [codeOptions]
 * @returns {{ mods: string[], codeMods: string[], codeOptions?: Record<string, Record<string, any>> }}
 */
export function roomModsRequest(fixed, packsOn, codeOn, codeOptions = {}) {
  const out = { mods: [...new Set([...(fixed || []), ...(packsOn || [])])], codeMods: [...new Set(codeOn || [])] };
  const kept = {};
  for (const [modId, values] of Object.entries(codeOptions || {})) {
    if (values && Object.keys(values).length) kept[modId] = { ...values };
  }
  if (Object.keys(kept).length) out.codeOptions = kept;
  return out;
}

/**
 * The option controls of one code mod (docs/MODS.md §4.6): its declaration, and the value each control should show —
 * what the ROOM already set for this match, else what the host just picked in the dialog, else the declared default.
 * @param {{ id: string, options?: any[], values?: Record<string, any> }} entry the frame's per-mod entry
 * @param {Record<string, any>} [changed] what the host changed in this dialog
 * @returns {{ key: string, label: string, description: string, type: string, values?: any[], min?: number, max?: number,
 *   value: any, set: boolean }[]}
 */
export function optionRows(entry, changed = {}) {
  const room = (entry && entry.values) || {};
  return ((entry && entry.options) || []).map((o) => {
    const mine = Object.prototype.hasOwnProperty.call(changed, o.key) ? changed[o.key] : undefined;
    const value = room[o.key] !== undefined ? room[o.key] : mine !== undefined ? mine : o.default;
    return {
      key: o.key, label: o.label || o.key, description: o.description || '', type: o.type,
      values: o.values, min: o.min, max: o.max, value,
      // `set`: this room (or this dialog) pins the knob, so the control reads "已设置" rather than "默认"
      set: room[o.key] !== undefined || mine !== undefined,
    };
  });
}

/** One option changed: a new per-mod values object for the dialog's state (never mutates). */
export function setOptionValue(values, key, value) {
  return { ...(values || {}), [key]: value };
}

/** Per-mod values for the request: the room's own values, then this dialog's changes on top. */
export function optionValuesFor(roomValues, changed) {
  return { ...(roomValues || {}), ...(changed || {}) };
}
