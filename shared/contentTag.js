// shared/contentTag.js — the content identity of a server (docs/PACKS.md §4): which content packs are in force, as one
// short tag every side can compute for itself.
//
// The client has to reach the same value from what it is told (GET /packs/index.json), so the tag covers only what both
// sides know: the app version and, per pack, its type, id, version and **size** — the bytes of the files its manifest
// names (server/packs.js), so a pack edited without a version bump still changes the tag. A client whose tag differs from
// the one in `/healthz.mods` is running content the server no longer serves (a pack was added or changed after the page
// loaded) and should reload.
//
// Only the packs that change **what the game is** count (PACK_TYPES[type].identity: the assets and data types). A
// language pack is left out on purpose: it changes text a client opts into, so a stock server must not look modded and
// adding a translation must not move the tag.
//
// It is an identity, not a security boundary: a short non-cryptographic hash (two FNV-1a lanes), no secret, cheap on
// both sides and in the browser. A hostile pack can of course claim any tag; what this is for is telling players (and
// bug reports) which content a server runs, and noticing a stale page.
//
// No Node builtin and no crypto API: the browser and the server share it (the client computes it synchronously).

import { PACK_TYPES } from './packs.js';

/** FNV-1a, 32 bit, as 8 hex digits. @param {string} text */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Whether a pack belongs to the content identity of a server: its type says it changes what the game is (assets, data).
 * A language pack does not — it only changes text a client opts into — so it never moves the tag.
 * @param {{ type?: string }} pack
 */
export function isIdentityPack(pack) {
  return !!pack && PACK_TYPES[String(pack.type)]?.identity === true;
}

/**
 * The packs that count for the tag, canonical and sorted (type, then id) so the order a server happened to scan them in
 * never changes the tag. Accepts an index entry or a registry pack (`bytes` or `size`).
 * @param {any[]} packs
 * @returns {{ type: string, id: string, version: string, size: number }[]}
 */
export function contentPacks(packs) {
  return (packs || [])
    .filter((p) => p && typeof p.id === 'string' && isIdentityPack(p))
    .map((p) => ({
      type: p.type,
      id: p.id,
      version: String(p.version || ''),
      size: Number.isFinite(p.bytes) ? p.bytes : Number.isFinite(p.size) ? p.size : 0,
    }))
    .sort((a, b) => (a.type === b.type ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.type < b.type ? -1 : 1));
}

/**
 * The content tag of a server: 12 hex digits over the app version and its packs. `''` — no packs, the game's own
 * content — is reported as `c0` so a value is always there to compare.
 * @param {string} app
 * @param {any[]} packs
 */
export function contentTag(app, packs) {
  const list = contentPacks(packs);
  const canonical = [`app=${app || ''}`, ...list.map((p) => `${p.type}:${p.id}@${p.version}:${p.size}`)].join('\n');
  return `c${fnv1a(canonical)}${fnv1a(`${canonical}\u0000#2`).slice(0, 4)}`;
}

/** How many packs, and their names, for a log line or a UI mark: e.g. `2 packs (assets:hd-art@1.0.0, data:balance)`. */
export function contentSummary(packs) {
  const list = contentPacks(packs);
  if (!list.length) return '';
  return `${list.length} pack(s) (${list.map((p) => `${p.type}:${p.id}${p.version ? `@${p.version}` : ''}`).join(', ')})`;
}
