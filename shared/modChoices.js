// shared/modChoices.js — the player-facing choices and the match moments a CODE MOD may add (docs/MODS.md §4.6).
//
// Why this exists: the shipped game lets a player answer exactly one kind of prompt — the 教鞭 Art's personal choice, whose
// pick becomes a bounty. A mod that wants to ASK something ("花 10 点血量复活他？") has no wire of its own to add (a new
// message would be a protocol revision) and cannot patch an ES module export, so the core owns the plumbing and the mod owns
// the rule: it registers a choice here, offers it through `Match.offerModChoice` (which reuses the personal-choice field, the
// `g.choice` message and the client's ChoiceView), and answers through `onPick` / `onDecline`.
//
// It also exposes the moment a mod most often needs: someone was just eliminated. `settle.js` calls every registered settle
// hook once per settle in which at least one seat went out, with the seats that did — never a seat that LEFT (a quit is not
// a defeat).

/** @type {Map<string, { id: string, onPick: Function, onDecline?: Function }>} */
const choices = new Map();
/** @type {Function[]} */
const settleHooks = [];

/**
 * Register a mod choice.
 * @param {{ id: string, onPick: (m: any, ps: any, picked: { card: any, idx: number, data: any }) => void,
 *   onDecline?: (m: any, ps: any, info: { data: any }) => void }} def
 * @returns {string} its id
 */
export function registerModChoice(def) {
  if (!def || typeof def !== 'object') throw new TypeError('registerModChoice: a definition object is required');
  const id = typeof def.id === 'string' && def.id ? def.id : null;
  if (!id) throw new TypeError('registerModChoice: a non-empty id is required');
  if (typeof def.onPick !== 'function') throw new TypeError(`registerModChoice(${id}): onPick(m, ps, picked) is required`);
  if (def.onDecline !== undefined && typeof def.onDecline !== 'function') {
    throw new TypeError(`registerModChoice(${id}): onDecline must be a function`);
  }
  choices.set(id, def);
  return id;
}

/** One registered choice, or null. */
export const modChoice = (id) => choices.get(id) || null;

/** The registered ids (diagnostics and tests). */
export const modChoiceIds = () => [...choices.keys()];

/**
 * Register a hook run once per settle in which at least one seat was eliminated.
 * @param {(m: any, info: { eliminated: { playerId: string, name: string, seat: number, left: boolean, round: number }[],
 *   round: number }) => void} fn
 * @returns {number} how many hooks are registered
 */
export function registerModSettleHook(fn) {
  if (typeof fn !== 'function') throw new TypeError('registerModSettleHook: a function is required');
  settleHooks.push(fn);
  return settleHooks.length;
}

/** The registered settle hooks, in registration order (the match reads this). */
export const modSettleHooks = () => settleHooks.slice();

/** Tests, and a mod that wants to re-register cleanly. */
export function resetModChoices() { choices.clear(); settleHooks.length = 0; }
