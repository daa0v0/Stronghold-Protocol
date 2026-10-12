// shared/modContent.js — content a CODE MOD registers (docs/MODS.md).
//
// The engine builds its handler registry from the shipped content modules (`server/sim/content/*.js`, each exposing
// `registerMeta(registry)`), and from the battle side's `install(battle)`. An ES module's exports cannot be reassigned, so a
// mod cannot append itself to either list by patching it — it registers here instead, and the engine includes these
// modules AFTER the shipped ones, so a mod's handler for a key replaces a built-in's (MetaRegistry.register replaces).
//
// A content module is `{ name?, registerMeta?(registry), install?(battle) }` — the same shape the shipped ones have, so a
// mod author copies a shipped module rather than learning a second API.

/** @type {{ name?: string, registerMeta?: Function, install?: Function }[]} */
const mods = [];

/**
 * Register a content module contributed by a mod. Called from a mod's `setup(ctx)`.
 * @param {{ name?: string, registerMeta?: Function, install?: Function }} mod
 * @returns {number} how many modules are registered (1 = this one)
 */
export function registerModContent(mod) {
  if (!mod || typeof mod !== 'object') throw new TypeError('registerModContent: a content module object is required');
  if (typeof mod.registerMeta !== 'function' && typeof mod.install !== 'function') {
    throw new TypeError('registerModContent: the module needs registerMeta(registry) and/or install(battle)');
  }
  mods.push(mod);
  return mods.length;
}

/** The registered modules, in registration order (the engine reads this). */
export const modContentModules = () => mods.slice();

/** Tests, and a mod that wants to re-register cleanly. */
export function resetModContent() { mods.length = 0; }
