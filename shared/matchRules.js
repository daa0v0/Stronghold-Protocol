// shared/matchRules.js — the match rules a CODE MOD may change (docs/MODS.md).
//
// Why this module exists: `server/sim/` and `server/match/` are plain ES modules, and an ES module's exports cannot be
// reassigned from outside, so a mod cannot patch a rule by overwriting a function. Instead the rules a mod is allowed to
// change live here, with the game's own behaviour as their default, and **every** reader asks for them — the draft, the
// invariant audit and the client view consult the same values, so a rule can never be half-applied (the audit would
// otherwise reject a match the game happily played).
//
// Two layers on purpose:
//   * the SERVER-WIDE rules (`setMatchRules`, tests and diagnostics) — the baseline;
//   * PER-MATCH rules: a mod registers a provider (`registerMatchRuleProvider`) that is asked once when a match is created,
//     with the match — so it can answer for its own id (`m.modEnabled('<id>')`). That is what makes a code mod the room host
//     did not pick contribute nothing to that match, while the mod itself still runs server-wide (it has no per-match setup
//     hook: it is loaded once, at server start). `Match.rules` is the result and what all readers use.
//
// Current rules:
//   * `bandDuplicates` (default false) — may two players of one pool group draft the SAME 开局策略/方针 (芬, 阿米娅,
//     变形者集群 …)? The shipped game says no: a teammate's pick is marked 队友已选 and cannot be taken again
//     (`Match.bandTaken`). With this true the whole draft behaves as if nothing were taken — the bot's re-draw, the
//     timeout/default band, the pick refusal and the invariant audit all ask this one rule.
//   * `sharedLp` (default null) — one shared health bar for the whole team instead of one per player. `null` = the shipped
//     game. Otherwise `{ mode: 'sum' | 'max', source: 'band' | 'lp' }`: the bar's size is the SUM or the MAX of the
//     teammates' chosen bands' `totalHp` (`source: 'band'`, the 方针 a player drafts) or of their health as it stands when
//     the pool is built (`source: 'lp'`). Every LP write goes through the match's one choke point
//     (server/match/match/lp.js), so the team can never drift apart. NOT to be confused with `Match.teamLp`, the shipped
//     merged pool of the Final Assault / Hidden Core.

/** The shape of the rules: what `bandDuplicates` / `sharedLp` may hold. */
/**
 * @typedef {{ bandDuplicates: boolean, sharedLp: null | { mode: 'sum'|'max', source: 'band'|'lp' } }} MatchRules
 */

/** The rules as they ship. Kept frozen so a reader cannot mutate the state by accident. */
export const MATCH_RULE_DEFAULTS = Object.freeze({ bandDuplicates: false, sharedLp: null });

/** @type {MatchRules} */
let rules = { ...MATCH_RULE_DEFAULTS };

/** The server-wide rules (read-only by convention: change them with setMatchRules). */
export const matchRules = () => rules;

/** The shared-health-bar rule among the server-wide rules, or null. */
export const sharedLpRule = () => rules.sharedLp;

/** Validate the `sharedLp` half of a patch; returns the clean value or null when it is unusable. */
function cleanSharedLp(value) {
  if (value == null) return null;
  if (typeof value !== 'object') return null;
  /** @type {'sum'|'max'|null} */
  const mode = value.mode === 'max' ? 'max' : value.mode === 'sum' ? 'sum' : null;
  /** @type {'band'|'lp'|null} */
  const source = value.source === 'lp' ? 'lp' : value.source == null || value.source === 'band' ? 'band' : null;
  if (!mode || !source) return null;
  return { mode, source };
}

/**
 * Every rule key a patch may carry, each with its own validation — one bad value loses that value, never the match.
 * @type {Record<string, (value: any) => { ok: boolean, value?: any }>}
 */
const RULE_KEYS = {
  bandDuplicates: (value) => (typeof value === 'boolean' ? { ok: true, value } : { ok: false }),
  sharedLp: (value) => {
    const clean = cleanSharedLp(value);
    if (clean || value == null) return { ok: true, value: clean };
    return { ok: false };
  },
};

/**
 * @param {MatchRules} base
 * @param {Record<string, unknown>} [patch]
 * @returns {{ next: MatchRules, applied: string[], rejected: string[] }}
 */
function applyRulePatch(base, patch = {}) {
  const applied = [];
  const rejected = [];
  /** @type {Record<string, any>} */
  const next = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    const check = RULE_KEYS[key];
    if (!check) { rejected.push(key); continue; }
    const res = check(value);
    if (res.ok) { next[key] = res.value; applied.push(key); } else rejected.push(key);
  }
  return { next: /** @type {MatchRules} */ (next), applied, rejected };
}

/**
 * Apply a patch to the SERVER-WIDE rules. Unknown or ill-typed keys are reported and skipped, never applied.
 * @param {Record<string, unknown>} [patch]
 * @returns {{ applied: string[], rejected: string[] }}
 */
export function setMatchRules(patch = {}) {
  const { next, applied, rejected } = applyRulePatch(rules, patch);
  rules = next;
  return { applied, rejected };
}

/** Back to the shipped behaviour (server-wide). */
export function resetMatchRules() { rules = { ...MATCH_RULE_DEFAULTS }; }

// -------------------------------------------------------------------------------------------------------------
// per-match rules

/** @type {Map<string, (m: any) => Record<string, unknown> | null>} modId → provider */
const providers = new Map();

/**
 * Register a per-match rule provider for one mod (docs/MODS.md §4.6). Called with the match, so it can answer for its own
 * mod — `(m) => ({ bandDuplicates: m.modEnabled('my-mod') })` is the whole pattern.
 * @param {string} modId
 * @param {(m: any) => Record<string, unknown> | null} fn
 * @returns {string} the id
 */
export function registerMatchRuleProvider(modId, fn) {
  if (typeof modId !== 'string' || !modId) throw new TypeError('registerMatchRuleProvider: a mod id is required');
  if (typeof fn !== 'function') throw new TypeError(`registerMatchRuleProvider(${modId}): a function is required`);
  providers.set(modId, fn);
  return modId;
}

/** The ids with a provider (diagnostics and tests). */
export const matchRuleProviders = () => [...providers.keys()];

/**
 * The rules ONE match runs with: the server-wide rules, then every provider's patch. A provider that throws contributes
 * nothing — a faulty mod must not take a match down.
 * @param {any} m the match (its `modEnabled` is what a provider asks)
 */
/**
 * The rules ONE match runs with: the server-wide rules, then every provider's patch. A provider that throws contributes
 * nothing — a faulty mod must not take a match down.
 * @param {any} m the match (its `modEnabled` is what a provider asks)
 * @returns {MatchRules} the effective rules
 */
export function matchRulesFor(m) {
  /** @type {MatchRules} */
  let out = { ...rules };
  for (const [, fn] of providers) {
    /** @type {Record<string, unknown>|null} */
    let patch;
    try { patch = fn(m) || null; } catch { patch = null; }
    if (patch) out = applyRulePatch(out, patch).next;
  }
  return out;
}

/** Tests: drop the providers (a mod's `setup` registers them, so loading a mod twice must not stack). */
export function resetMatchRuleProviders() { providers.clear(); }
