// public/js/ui/contentPacks.js — the content identity of the server this page is talking to (docs/PACKS.md §4).
//
// Two things a player (and a bug report) should be able to see: which content packs the server runs, and whether this
// page still matches them. The client reads GET /packs/index.json — the same list the loaders use — and
// shared/contentTag.js turns it into the same short tag the server reports in GET /healthz.mods. So the comparison needs
// no protocol change: the compact wire's position tables are frozen (a field added to `welcome` or a BattleSpec would
// make an older client reject the frame), and per-room mod state will arrive as its own JSON-fallback type instead
// (docs/WIRE_PROTOCOL.md), while this identity is plain JSON on both sides.
//
// A mismatch means a pack was added or changed after this page loaded: ui/assetPacks.js already fetched the old index, so
// the page is running the old content. We report it (the 问题反馈 section shows the mark) and the player can reload.

import { readPackIndex } from '../../../shared/packs.js';
import { contentTag, contentSummary, isIdentityPack } from '../../../shared/contentTag.js';

/** The live pack index (server/http/static.js answers it; never cached). */
export const PACK_INDEX_URL = '/packs/index.json';
/** The server's own report, read for its `mods.tag` (ui/buildGuard.js reads the same endpoint for `build`). */
export const HEALTH_URL = '/healthz';

let state = { tag: '', serverTag: '', packs: [], languages: 0, summary: '', mismatch: false, loaded: false, error: null };
/** The index entries and the app version they were computed from (a room's subset needs `contentTagOf`). */
let entries = [];
let app = '';

/** What this page knows: its own content tag, the server's, the packs, and whether the two disagree. */
export const contentState = () => ({ ...state, packs: state.packs.slice() });

/** The pack entries this page read from the index (the create-room panel lists them; a room's subset tags them). */
export const contentEntries = () => entries.slice();

/**
 * The content tag of a SUBSET of the packs this page knows — a room's selection (docs/PACKS.md §4). The whole-set tag is
 * `contentState().tag`; comparing this one with `room.mods.tag` says whether the packs the page applied are the ones the
 * match runs.
 * @param {string[]} ids
 */
export function contentTagOf(ids) {
  const wanted = new Set(ids || []);
  return contentTag(app, entries.filter((e) => wanted.has(e.id)));
}

/** A pack list short enough for a mark: 'assets:hd-art@1.0.0, data:balance' (or '' without packs). */
export const contentLabel = () => state.packs.map((p) => `${p.type}:${p.id}${p.version ? `@${p.version}` : ''}`).join(', ');

/**
 * Read the index and `/healthz`, compute this page's content tag and compare.
 * @param {{ fetchImpl?: (url: string, init?: object) => Promise<any>, indexUrl?: string, healthUrl?: string }} [opts]
 */
export async function loadContentTag({ fetchImpl = (url, init) => fetch(url, init), indexUrl = PACK_INDEX_URL, healthUrl = HEALTH_URL } = {}) {
  try {
    const res = await fetchImpl(indexUrl, { cache: 'no-store' });
    if (!res || !res.ok) throw new Error(`index HTTP ${res ? res.status : '???'}`);
    const json = await res.json();
    const packs = readPackIndex(json); // every supported type; the tag itself counts only the identity types
    const tag = contentTag(json && json.app, packs);
    const identity = packs.filter(isIdentityPack);
    entries = packs;
    app = String((json && json.app) || '');
    let serverTag = '';
    try {
      const h = await fetchImpl(healthUrl, { cache: 'no-store' });
      if (h && h.ok) serverTag = (await h.json())?.mods?.tag || '';
    } catch { /* the server's tag is a courtesy: an unreachable /healthz leaves it empty, never a failure */ }
    const mismatch = !!(serverTag && tag && serverTag !== tag);
    state = {
      tag, serverTag, mismatch, loaded: true, error: null, summary: contentSummary(identity),
      languages: packs.length - identity.length,
      packs: identity.map((p) => ({ type: p.type, id: p.id, version: p.version || '', name: p.name || p.id, compatible: p.compatible !== false })),
    };
    if (mismatch) console.warn(`[packs] this page has content ${tag}, the server runs ${serverTag}: reload to match it`);
    return contentState();
  } catch (error) {
    state = { ...state, loaded: false, error: String(error?.message || error) };
    return contentState();
  }
}

/**
 * Boot wiring: read the packs once, in the background (never blocking the page). ui/assetPacks.js loads the art itself.
 * @param {{ fetchImpl?: Function, indexUrl?: string, healthUrl?: string }} [opts]
 * @returns {{ ready: Promise<object>, state: () => object }}
 */
export function installContentPacks(opts) {
  return { ready: loadContentTag(opts), state: contentState };
}
