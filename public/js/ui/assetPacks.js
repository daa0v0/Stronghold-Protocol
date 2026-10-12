// public/js/ui/assetPacks.js — 资源包 (docs/PACKS.md, type "assets"): the client half of the type.
//
// Every picture, model and sound the game shows is resolved from the URLs of data/assets.json — assets.js reads them for
// avatars, portraits, skill / item / enemy icons and every Spine skeleton, atlas and texture, and audio.js reads the
// manifest's own bgm and unit-sfx entries. So a pack never has to touch the code: it hands the client a map from those
// URLs to its own files, and the client rewrites the loaded manifest once. Replacing an existing resource and adding a
// new one are the same operation from here.
//
// Discovery: GET /packs/index.json (the live list, server/http/static.js) → the "assets" entries in index order (sorted
// by type then id) → each pack's own map file. A pack dropped into packs/ shows on the next page load, a removed one
// leaves, and two packs that map the same URL both load with the later id winning — the same rule the server reports as
// a conflict warning.
//
// The pack's files are served from /packs/<id>/… (only the files its manifest names: server/packs.js), and each one is
// requested with the pack's version in the query, so a new version of a pack is never answered from the browser cache.

import { readPackIndex } from '../../../shared/packs.js';
import { data, onManifest } from '../data.js';

/** The live pack index (server/http/static.js answers it; never cached). */
export const PACK_INDEX_URL = '/packs/index.json';

/** resource URL → { url, pack } of the merged packs (later index entries override earlier ones). */
let overrides = new Map();
/** The packs' own maps, by pack id (in index order), so a room can be handed a subset of them later. */
let byPack = new Map();
/** The pack ids whose replacements are in force: everything this server loaded until a room narrows it. */
let selection = [];
let report = { packs: [], conflicts: [], count: 0, loaded: false, error: null };

/** What the packs did: the loaded ones, the URLs two of them fight over, and the error when the index was unreadable. */
export const assetPackReport = () => ({ ...report, count: overrides.size });

/** The file a pack replaces a resource URL with, or null. @param {string} url */
export function assetOverride(url) {
  const hit = typeof url === 'string' ? overrides.get(url) : null;
  return hit ? hit.url : null;
}

/**
 * Rewrite a loaded manifest in place: every string that is a mapped resource URL becomes the pack's file. A deep walk,
 * so a pack covers whatever the manifest points at (an avatar today, a field a later version adds) with no key list to
 * keep in step here.
 * @param {any} value @returns {number} how many URLs were rewritten
 */
export function applyAssetOverrides(value) {
  if (!overrides.size || !value || typeof value !== 'object') return 0;
  let changed = 0;
  const walk = (node) => {
    if (typeof node === 'string') {
      const hit = overrides.get(node);
      if (!hit) return node;
      changed++;
      return hit.url;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = walk(node[i]);
      return node;
    }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) node[key] = walk(node[key]);
      return node;
    }
    return node;
  };
  walk(value);
  return changed;
}

/** A pack file URL with the pack's version in the query (the server ignores it; the browser's cache does not). */
const stamp = (url, pack) => {
  const v = String(pack.version || pack.id || '').slice(0, 40);
  if (!v) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(v)}`;
};

/**
 * Read the index and every pack's map, and merge them into the override table.
 * @param {{ fetchImpl?: (url: string, init?: object) => Promise<any>, url?: string }} [opts]
 */
export async function loadAssetPacks({ fetchImpl = (url, init) => fetch(url, init), url = PACK_INDEX_URL } = {}) {
  try {
    const indexRes = await fetchImpl(url, { cache: 'no-store' });
    if (!indexRes || !indexRes.ok) throw new Error(`index HTTP ${indexRes ? indexRes.status : '???'}`);
    const packs = readPackIndex(await indexRes.json(), 'assets');
    /** @type {Map<string, { version: string, map: Map<string, string> }>} per pack, so a room can narrow the set later */
    const perPack = new Map();
    const loaded = [];
    for (const pack of packs) {
      const res = await fetchImpl(pack.files.map, { cache: 'no-store' });
      if (!res || !res.ok) { console.warn(`[packs] ${pack.id}: map unavailable`); continue; }
      const map = await res.json();
      if (!map || typeof map !== 'object' || Array.isArray(map)) { console.warn(`[packs] ${pack.id}: map is not an object`); continue; }
      const mine = new Map();
      for (const [key, to] of Object.entries(map)) {
        if (typeof to !== 'string' || !to) continue;
        mine.set(key, stamp(to, pack));
      }
      perPack.set(pack.id, { version: pack.version || '', map: mine });
      loaded.push({ id: pack.id, name: pack.name || pack.id, version: pack.version || '', overrides: mine.size });
    }
    byPack = perPack;
    selection = loaded.map((p) => p.id);
    const { merged, conflicts } = mergeSelection(selection);
    overrides = merged;
    report = { packs: loaded, conflicts, count: merged.size, loaded: true, error: null };
    if (loaded.length) console.info(`[packs] assets: ${loaded.length} pack(s), ${merged.size} resource URL(s) rewritten`);
    for (const c of conflicts) console.warn(`[packs] "${c.url}" is rewritten by ${c.packs[0]} and ${c.packs[1]}; the later id wins`);
    return assetPackReport();
  } catch (error) {
    report = { packs: [], conflicts: [], count: overrides.size, loaded: false, error: String(error?.message || error) };
    console.warn(`[packs] resource packs unavailable (${report.error}); the game's own art is used`);
    return assetPackReport();
  }
}

/** Merge the packs of one selection, in index order (the later id wins), and report the URLs two of them fight over. */
function mergeSelection(ids) {
  const wanted = new Set(ids || []);
  const merged = new Map();
  const conflicts = [];
  for (const [id, pack] of byPack) {
    if (!wanted.has(id)) continue;
    for (const [key, url] of pack.map) {
      const prev = merged.get(key);
      if (prev && prev.pack !== id) conflicts.push({ url: key, packs: [prev.pack, id] });
      merged.set(key, { url, pack: id });
    }
  }
  return { merged, conflicts };
}

/**
 * Apply only the packs a room runs (docs/PACKS.md §4): `null` means every pack this server loaded. The manifest is
 * refetched (a transform runs on load, so it has to see a pristine copy) whenever the effective mapping changes, which is
 * the one case where entering or leaving a room costs a manifest request.
 * @param {string[] | null} ids
 * @param {{ invalidate?: (name: string) => void }} [opts] invalidate: the data store's (injectable for tests)
 */
export function applyRoomMods(ids, { invalidate } = {}) {
  const next = ids === null || ids === undefined ? [...byPack.keys()] : [...byPack.keys()].filter((id) => ids.includes(id));
  if (next.join('|') === selection.join('|')) return assetPackReport();
  const before = overrides;
  const { merged, conflicts } = mergeSelection(next);
  selection = next;
  overrides = merged;
  const changed = before.size !== merged.size || [...merged].some(([key, hit]) => before.get(key)?.url !== hit.url);
  report = { ...report, conflicts, count: merged.size };
  if (changed) {
    const drop = invalidate || ((name) => data.invalidate(name));
    drop('assets');
    console.info(`[packs] assets: room selection → ${selection.join(', ') || 'none'} (${merged.size} URL(s))`);
  }
  return assetPackReport();
}

/** The pack ids whose replacements are in force right now (a room's selection, or every loaded pack). */
export const appliedMods = () => selection.slice();


/**
 * Wire the packs into the data store: the transform is registered first (so it runs whenever data/assets.json arrives),
 * and a manifest that already arrived is rewritten at once — registered before the game's first data load at boot, the
 * usual case is the former. Safe to call once; a second call only replaces the fetch target.
 * @param {{ fetchImpl?: Function, url?: string }} [opts]
 * @returns {{ ready: Promise<object>, report: () => object }}
 */
export function installAssetPacks(opts) {
  onManifest('assets', (manifest) => { applyAssetOverrides(manifest); });
  const ready = loadAssetPacks(opts).then((r) => {
    const cached = data.get('assets');
    if (cached) applyAssetOverrides(cached);
    return r;
  });
  return { ready, report: assetPackReport };
}
