// shared/matchRules.js — the match rules a CODE MOD may change (docs/MODS.md).
//
// Why this module exists: `server/sim/` and `server/match/` are plain ES modules, and an ES module's exports cannot be
// reassigned from outside, so a mod cannot patch a rule by overwriting a function. Instead the rules that a mod is allowed
// to change live here as runtime state with the game's own behaviour as their default, and **every** reader asks this
// module — the draft, the invariant audit and the client view all consult the same object, so a rule can never be
// half-applied (the audit would otherwise reject a match the game happily played).
//
// `server/index.js`-level wiring does not touch this: a mod sets it from its `setup(ctx)` (once, at server start), and
// `resetMatchRules()` puts the defaults back (tests).
//
// Current rules:
//   * `choiceDuplicates` (default false) — may two players of one card-pool group pick the SAME 机变 card? The shipped
//     game says no: within a fixed group every card is unique (`group.taken`). With this true a card stays available after
//     the first pick; `taken[idx]` keeps naming the FIRST holder, so the wire shape the client already understands does not
//     change and the client is told to keep such a card pickable (`sp.allowDuplicates`).

/** The rules as they ship. Kept frozen so a reader cannot mutate the state by accident. */
export const MATCH_RULE_DEFAULTS = Object.freeze({ choiceDuplicates: false });

/** @type {{ choiceDuplicates: boolean }} */
let rules = { ...MATCH_RULE_DEFAULTS };

/** The live rules (read-only by convention: change them with setMatchRules). */
export const matchRules = () => rules;

/**
 * Apply a patch to the rules. Unknown or ill-typed keys are reported and skipped, never applied — a mod that gets one value
 * wrong loses that value, not the match.
 * @param {Record<string, unknown>} [patch]
 * @returns {{ applied: string[], rejected: string[] }}
 */
export function setMatchRules(patch = {}) {
  const applied = [];
  const rejected = [];
  const next = { ...rules };
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === 'choiceDuplicates') {
      if (typeof value === 'boolean') { next.choiceDuplicates = value; applied.push(key); } else rejected.push(key);
      continue;
    }
    rejected.push(key);
  }
  rules = next;
  return { applied, rejected };
}

/** Back to the shipped behaviour. */
export function resetMatchRules() { rules = { ...MATCH_RULE_DEFAULTS }; }
