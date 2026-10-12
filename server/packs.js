// server/packs.js — this server's content packs (docs/PACKS.md; the format: shared/packs.js). Discovers
//
//   * folder packs: packs/<id>/pack.json + the files its manifest names (any type);
//   * single-file language packs: public/i18n/<code>.json (manifest: its `_meta`) + data/i18n/<code>.json when present;
//
// validates them, and answers the pack index (GET /packs/index.json, server/http/static.js) and which pack files may be
// served (GET /packs/<id>/<file>: only a file that the manifest of a supported folder pack names, with its role's
// extension, inside the pack folder — nothing else there, ever; a single-file pack's files are the language folders' own,
// /i18n/ and /data/i18n/). The folders are re-read when something in them changes (checked when the index or a pack
// file is asked for, at most once a second: a few stat calls), so a language pack dropped in shows on the next page
// load — no restart, no build step. A pack of a planned type, a broken manifest, a second pack with the same id or
// language: reported (`skipped`: the start log, `node tools/packs.mjs list`), never served.
//
// Extension point (docs/PACKS.md "Adding a pack type"): a new type gets its PACK_TYPES entry (shared/packs.js) and a
// loader that reads `list(type)` — a client-side type through the index, a server-side one (type "data") once at start
// (`live: false`: the simulation's data is fixed for the life of the process).

import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION } from '../shared/constants.js';
import { PACK_TYPES, PACK_MANIFEST, PACKS_URL, normalizeManifest, packIndexEntry, buildPackIndex } from '../shared/packs.js';
import { SOURCE_LANG, isLangCode, countStrings } from '../shared/i18nPacks.js';
import { contentTag, contentSummary, isIdentityPack } from '../shared/contentTag.js';
import { DATA_FILES } from './data.js';

/** The language folders' subdirectory (public/i18n/, data/i18n/). */
export const LANG_DIR = 'i18n';
/** Largest manifest / UI file read (bytes): a pack file is small text. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const noop = () => {};
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * @typedef {{ rel: string, abs: string, url: string, bytes: number }} PackFile
 * @typedef {{ id: string, type: string, layout: 'file' | 'folder', where: string, supported: boolean,
 *   manifest: import('../shared/packs.js').PackManifest, files: Record<string, PackFile[]>, bytes: number, strings?: number,
 *   overrides?: string[], patches?: { file: string, patch: any }[] }} Pack  files: role → its files (one entry for a
 *   plain role, a pool for a `many` role); overrides: the resource URLs an assets pack rewrites (`files.map`'s keys);
 *   patches: the data patches a data pack declares (server/dataPacks.js applies them)
 * @typedef {{ where: string, problems: string[] }} Skipped
 * @typedef {{ id: string, type: string, name: string, version: string, app: string, compatible: boolean, where: string,
 *   reason: 'off' | 'unconfirmed' }} Denied  a pack that was scanned and then held back by the owner's policy
 */

/** Largest number of URL rewrites one assets pack may declare (the map is held in memory for the index and the check). */
const MAX_ASSET_OVERRIDES = 5000;

const isFile = (abs) => { try { return fs.statSync(abs).isFile(); } catch { return false; } };
const sizeOf = (abs) => { try { const st = fs.statSync(abs); return st.isFile() ? st.size : 0; } catch { return 0; } };
const readDirSorted = (dir) => { try { return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort(); } catch { return []; } };

/** A JSON file of at most MAX_JSON_BYTES, or { error }. */
function readJson(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { error: 'not a file' };
    if (st.size > MAX_JSON_BYTES) return { error: `larger than ${MAX_JSON_BYTES >> 20} MB` };
    return { json: JSON.parse(fs.readFileSync(abs, 'utf8')) };
  } catch (e) {
    return { error: e instanceof SyntaxError ? `not valid JSON (${e.message})` : String(e?.code || e?.message || e) };
  }
}

/** Whether `abs` is inside `dir` once symbolic links are resolved (a pack file never leads out of its folder). */
function inside(dir, abs) {
  try {
    const d = fs.realpathSync(dir);
    const f = fs.realpathSync(abs);
    return f.startsWith(d + path.sep);
  } catch { return false; }
}

const fileUrl = (id, rel) => `${PACKS_URL}${encodeURIComponent(id)}/${rel.split('/').map(encodeURIComponent).join('/')}`;

/**
 * Scan the pack folders once.
 * @param {{ publicDir: string, dataDir: string, packsDir: string }} dirs
 * @param {{ app?: string }} [opts]
 * @returns {{ packs: Pack[], skipped: Skipped[], warnings: { where: string, warning: string }[] }}
 */
export function scanPacks({ publicDir, dataDir, packsDir }, { app = APP_VERSION } = {}) {
  /** @type {Pack[]} */
  const found = [];
  /** @type {Skipped[]} */
  const skipped = [];
  const warnings = [];
  const warn = (where, list) => { for (const w of list) warnings.push({ where, warning: w }); };

  // single-file language packs: public/i18n/<code>.json
  const uiDir = path.join(publicDir, LANG_DIR);
  for (const name of readDirSorted(uiDir)) {
    if (!name.endsWith('.json')) continue;
    const code = name.slice(0, -5);
    const where = `public/${LANG_DIR}/${name}`;
    if (!isLangCode(code)) { skipped.push({ where, problems: [`"${code}" is not a language code in its usual case (en, ja, zh-TW, pt-BR …)`] }); continue; }
    if (code === SOURCE_LANG) { skipped.push({ where, problems: ['"zh" is the source language (the msgids), never a pack'] }); continue; }
    const abs = path.join(uiDir, name);
    const r = readJson(abs);
    if (r.error) { skipped.push({ where, problems: [r.error] }); continue; }
    if (!r.json || typeof r.json !== 'object' || Array.isArray(r.json)) { skipped.push({ where, problems: ['not a JSON object of msgid → translation'] }); continue; }
    const { manifest, problems, warnings: w } = normalizeManifest(r.json._meta, { id: code, type: 'lang', lang: code, app });
    warn(where, w);
    if (!manifest) { skipped.push({ where, problems }); continue; }
    /** @type {Record<string, PackFile[]>} */
    const files = { ui: [{ rel: name, abs, url: `/${LANG_DIR}/${name}`, bytes: sizeOf(abs) }] };
    const dataAbs = path.join(dataDir, LANG_DIR, name);
    if (isFile(dataAbs)) files.data = [{ rel: name, abs: dataAbs, url: `/data/${LANG_DIR}/${name}`, bytes: sizeOf(dataAbs) }];
    const bytes = Object.values(files).reduce((sum, list) => sum + list.reduce((n, f) => n + f.bytes, 0), 0);
    found.push({ id: code, type: 'lang', layout: 'file', where, supported: true, manifest, files, bytes, strings: countStrings(r.json) });
  }

  // folder packs: packs/<id>/pack.json
  for (const id of readDirSorted(packsDir)) {
    const dir = path.join(packsDir, id);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const where = `packs/${id}/`;
    const man = path.join(dir, PACK_MANIFEST);
    if (!isFile(man)) { skipped.push({ where, problems: [`no ${PACK_MANIFEST}`] }); continue; }
    const r = readJson(man);
    if (r.error) { skipped.push({ where, problems: [`${PACK_MANIFEST}: ${r.error}`] }); continue; }
    const { manifest, problems, warnings: w } = normalizeManifest(r.json, { id, folder: true, app });
    warn(where, w);
    if (!manifest) { skipped.push({ where, problems }); continue; }
    const kind = PACK_TYPES[manifest.type];
    if (kind.status !== 'supported') {
      skipped.push({ where, problems: [`type "${manifest.type}" is planned (${kind.summary}), not loaded by this version`] });
      continue;
    }
    /** @type {Record<string, PackFile[]>} */
    const files = {};
    const missing = [];
    let bytes = 0;
    for (const [role, given] of Object.entries(manifest.files)) {
      const list = (Array.isArray(given) ? given : [given]).map((rel) => {
        const abs = path.join(dir, ...rel.split('/'));
        // one stat per file: existence, confinement and size — the size is part of the content tag (shared/contentTag.js)
        let size = 0;
        try { const st = fs.statSync(abs); if (st.isFile()) size = st.size; } catch { /* missing: reported below */ }
        if (!size && !isFile(abs)) missing.push(`files.${role}: ${rel} is missing`);
        else if (!inside(dir, abs)) missing.push(`files.${role}: ${rel} leads out of the pack folder`);
        bytes += size;
        return { rel, abs, url: fileUrl(id, rel), bytes: size };
      });
      files[role] = list;
    }
    if (missing.length) { skipped.push({ where, problems: missing }); continue; }
    /** @type {Pack} */
    const pack = { id, type: manifest.type, layout: 'folder', where, supported: true, manifest, files, bytes };
    if (manifest.type === 'lang') {
      const ui = readJson(files.ui[0].abs);
      if (ui.error || !ui.json || typeof ui.json !== 'object' || Array.isArray(ui.json)) {
        skipped.push({ where, problems: [`files.ui: ${ui.error || 'not a JSON object of msgid → translation'}`] });
        continue;
      }
      pack.strings = countStrings(ui.json);
    }
    if (manifest.type === 'assets') {
      const map = readJson(files.map[0].abs);
      const problems = [];
      /** @type {string[]} */
      const overrides = [];
      if (map.error) problems.push(`files.map: ${map.error}`);
      else if (!isObj(map.json)) problems.push('files.map: not a JSON object of resource URL → file');
      else {
        // every value must be one of THIS pack's own media files: only files the manifest names are ever served, so a
        // map that points anywhere else (another pack, the game's own art, a file that is not in the pool) is refused
        const pool = new Map((files.media || []).map((f) => [f.url, f.rel]));
        for (const [key, value] of Object.entries(map.json)) {
          if (typeof value !== 'string' || !value) { problems.push(`files.map "${key}": the value is not a string`); continue; }
          if (!key.startsWith('/') || key.startsWith('//')) { problems.push(`files.map "${key}": not a path on this server`); continue; }
          if (!pool.has(value)) { problems.push(`files.map "${key}": ${value} is not one of this pack's media files`); continue; }
          overrides.push(key);
        }
        if (overrides.length > MAX_ASSET_OVERRIDES) problems.push(`files.map rewrites ${overrides.length} URLs (at most ${MAX_ASSET_OVERRIDES})`);
      }
      if (problems.length) { skipped.push({ where, problems }); continue; }
      pack.overrides = overrides;
    }
    if (manifest.type === 'data') {
      // each patch file is `{ "<data file>": <merge patch> }`: a known table, and an object for each (a patch may not
      // replace a table with a scalar, nor delete it — that is what keeps a broken pack from taking the game down)
      const problems = [];
      /** @type {{ file: string, patch: any }[]} */
      const patches = [];
      for (const f of files.patch) {
        const r = readJson(f.abs);
        if (r.error) { problems.push(`files.patch: ${f.rel}: ${r.error}`); continue; }
        if (!isObj(r.json)) { problems.push(`files.patch: ${f.rel}: not a JSON object of data file → patch`); continue; }
        for (const [file, patch] of Object.entries(r.json)) {
          if (!DATA_FILES.includes(file)) { problems.push(`files.patch: ${f.rel}: "${file}" is not a data file (${DATA_FILES.join(', ')})`); continue; }
          if (!isObj(patch)) { problems.push(`files.patch: ${f.rel}: "${file}" must map to an object (a merge patch), not ${patch === null ? 'null' : Array.isArray(patch) ? 'a list' : typeof patch}`); continue; }
          patches.push({ file, patch });
        }
      }
      if (problems.length) { skipped.push({ where, problems }); continue; }
      pack.patches = patches;
    }
    found.push(pack);
  }

  // one pack per id (any case: one folder on Windows / macOS) and per language; the language folders' files first
  const packs = [];
  const ids = new Map();
  const langs = new Map();
  for (const p of found) {
    const idKey = p.id.toLowerCase();
    if (ids.has(idKey)) { skipped.push({ where: p.where, problems: [`the id "${p.id}" is taken by ${ids.get(idKey)}`] }); continue; }
    if (p.type === 'lang' && langs.has(p.manifest.lang)) {
      skipped.push({ where: p.where, problems: [`the language ${p.manifest.lang} is already provided by ${langs.get(p.manifest.lang)}`] });
      continue;
    }
    ids.set(idKey, p.where);
    if (p.type === 'lang') langs.set(p.manifest.lang, p.where);
    packs.push(p);
  }
  // two assets packs rewriting the same resource URL: both load (the last id in the index order wins) and it is reported
  const claimed = new Map();
  for (const p of packs) {
    for (const key of p.overrides || []) {
      const prev = claimed.get(key);
      if (prev && prev !== p.id) warnings.push({ where: p.where, warning: `"${key}" is already rewritten by ${prev} (this pack wins: the index is sorted by id)` });
      claimed.set(key, p.id);
    }
  }
  return { packs, skipped, warnings };
}

/**
 * The index body of scanned packs (shared/packs.js buildPackIndex).
 * @param {Pack[]} packs
 * @param {{ app?: string }} [opts]
 */
export function packIndexOf(packs, { app = APP_VERSION } = {}) {
  const entries = packs.filter((p) => p.supported).map((p) => {
    const kind = PACK_TYPES[p.manifest.type];
    /** @type {Record<string, string | string[]>} */
    const files = {};
    for (const [role, list] of Object.entries(p.files)) {
      if (kind?.files?.[role]?.pool) continue; // a pool's files are served but never listed: the map points at them
      files[role] = list.length === 1 ? list[0].url : list.map((f) => f.url);
    }
    return packIndexEntry(p.manifest, { files, strings: p.strings, overrides: p.overrides?.length, patches: p.patches?.length, size: p.bytes });
  });
  return buildPackIndex(entries, { app });
}

/** What changes when a pack is added, removed or edited: names, sizes and times of the files the scan reads. */
function signature({ publicDir, dataDir, packsDir }) {
  const parts = [];
  const add = (dir, depth, tag, namesOnly = false) => {
    for (const n of readDirSorted(dir)) {
      const abs = path.join(dir, n);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (depth > 0) { parts.push(`${tag}${n}/`); add(abs, depth - 1, `${tag}${n}/`); }
        continue;
      }
      parts.push(namesOnly ? `${tag}${n}` : `${tag}${n}:${st.size}:${Math.floor(st.mtimeMs)}`);
    }
  };
  add(path.join(publicDir, LANG_DIR), 0, 'u:');
  add(path.join(dataDir, LANG_DIR), 0, 'd:', true); // a game-text file only counts by its presence
  add(packsDir, 3, 'p:');
  return parts.join('\n');
}

/**
 * The registry: the scan, re-done when the folders change (see the header).
 * @param {{ publicDir: string, dataDir: string, packsDir: string }} dirs
 * @param {{ log?: { info: Function, warn: Function }, app?: string, recheckMs?: number }} [opts]
 *   recheckMs: how long a scan stays trusted before the folders are looked at again (default 1000; 0 = every call)
 *   policy: the owner's content-pack policy (server/serverSettings.js `packs`, set from /admin) as a function returning
 *     `{ off?: string[], allow?: string[] }` or null: `off` = ids this server does not load at all, `allow` = ids the
 *     owner confirmed although they are outside their app range. Read on every scan, so a change takes effect at once.
 */
export function createPackRegistry(dirs, { log = { info: noop, warn: noop }, app = APP_VERSION, recheckMs = 1000, policy = null } = {}) {
  let sig = null;
  let checkedAt = -Infinity;
  /** The policy the current `state` was built with (server/packs.js refresh): a change bypasses the recheck window. */
  let appliedPolicy = null;
  const readPolicy = () => {
    const pol = typeof policy === 'function' ? policy() || null : policy || null;
    return { off: new Set(pol?.off || []), allow: new Set(pol?.allow || []) };
  };
  /**
   * The policy a pack that is NOT live (`PACK_TYPES[type].live === false`: the data type, whose tables the simulation
   * fixed at start) was loaded under. Switching such a pack off or on at runtime would leave the index and the content
   * tag claiming one thing while `/data/<name>.json` still serves its patches — so for those types the policy is frozen
   * at start, and /admin says a change needs a restart.
   */
  const startPolicy = readPolicy();
  /** @type {ReturnType<typeof scanPacks> & { index: ReturnType<typeof packIndexOf>, byId: Map<string, Pack>, denied: Denied[] }} */
  let state = null;
  const told = new Set();
  const tell = (fn, line) => { if (!told.has(line)) { told.add(line); fn(line); } };

  function refresh(force = false) {
    const now = Date.now();
    // The owner's policy (docs/PACKS.md §4): a pack turned off never loads, and an incompatible pack that changes the
    // game waits for an explicit confirmation. An incompatible LANGUAGE pack still loads — it only changes text, and the
    // strings it lacks fall back — so a translation made for an older release keeps working.
    const pol = readPolicy();
    const off = new Set(pol.off);
    const allow = new Set(pol.allow);
    // The policy is part of the cache key AND of the time gate: a switch flipped in /admin must take effect at once,
    // although no pack file changed and the folder may not be looked at again for recheckMs.
    const polKey = `${[...off].sort().join(',')}|${[...allow].sort().join(',')}`;
    if (state && !force && polKey === appliedPolicy && now - checkedAt < recheckMs) return state;
    checkedAt = now;
    const s = `${signature(dirs)}|${polKey}`;
    if (state && s === sig) return state;
    const first = !state;
    sig = s;
    appliedPolicy = polKey;
    const scan = scanPacks(dirs, { app });
    /** @type {Pack[]} */
    const packs = [];
    /** @type {Denied[]} */
    const denied = [];
    for (const p of scan.packs) {
      const entry = { id: p.id, type: p.type, name: p.manifest.name, version: p.manifest.version || '', app: p.manifest.app || '', compatible: p.manifest.compatible !== false, where: p.where };
      // A type that is not live (the data type: its tables are fixed at start) is judged by the policy the process
      // started with, so its loaded state here always matches the tables the simulation is really running on.
      const live = PACK_TYPES[p.type]?.live !== false;
      const offHere = live ? off : startPolicy.off;
      const allowHere = live ? allow : startPolicy.allow;
      if (offHere.has(p.id)) denied.push({ ...entry, reason: 'off' });
      else if (entry.compatible === false && isIdentityPack(p.manifest) && !allowHere.has(p.id)) denied.push({ ...entry, reason: 'unconfirmed' });
      else packs.push(p);
    }
    state = { ...scan, packs, denied, index: packIndexOf(packs, { app }), byId: new Map(packs.map((p) => [p.id, p])) };
    const line = `[packs] ${packs.length ? packs.map((p) => `${p.type} ${p.type === 'lang' ? p.manifest.lang : p.id} (${p.manifest.name})`).join(', ') : 'none'}`;
    if (first || packs.length) tell((m) => log.info(m), line);
    for (const d of denied) {
      tell((m) => log.warn(m), d.reason === 'off'
        ? `[packs] ${d.type} ${d.id} is turned off by the server owner (runtime/server-settings.json, /admin)`
        : `[packs] ${d.type} ${d.id} (app ${d.app || 'any'}) is outside this server's app range and changes the game: not loaded until the owner confirms it in /admin`);
    }
    for (const k of scan.skipped) tell((m) => log.warn(m), `[packs] ${k.where} skipped: ${k.problems.join('; ')}`);
    for (const w of scan.warnings) tell((m) => log.warn(m), `[packs] ${w.where}: ${w.warning}`);
    return state;
  }

  return {
    /** Re-read the folders now if they changed (force: even within recheckMs). */
    refresh: (force = false) => { refresh(force); },
    /** The loaded packs, optionally of one type. @param {string} [type] @returns {Pack[]} */
    list: (type) => refresh().packs.filter((p) => !type || p.type === type),
    /** The index body (GET /packs/index.json). */
    index: () => refresh().index,
    /** Packs that were not loaded and why, and the warnings of the loaded ones. */
    report: () => { const s = refresh(); return { skipped: s.skipped, warnings: s.warnings, denied: s.denied }; },
    /**
     * Every pack the folders hold, with whether the owner's policy lets it load — what the /admin 内容包 panel shows.
     * @returns {{ policy: { off: string[], allow: string[] } | null, packs: (Denied & { enabled: boolean })[] }}
     */
    overview() {
      const s = refresh();
      const pol = typeof policy === 'function' ? policy() || null : policy || null;
      const packs = s.packs.map((p) => ({
        id: p.id, type: p.type, name: p.manifest.name, version: p.manifest.version || '', app: p.manifest.app || '',
        compatible: p.manifest.compatible !== false, where: p.where, enabled: true, reason: null, live: PACK_TYPES[p.type]?.live !== false,
        bytes: p.bytes, overrides: p.overrides?.length || 0, patches: p.patches?.length || 0, strings: p.strings || 0,
      }));
      for (const d of s.denied) packs.push({ ...d, enabled: false, live: PACK_TYPES[d.type]?.live !== false });
      return {
        policy: pol ? { off: [...(pol.off || [])], allow: [...(pol.allow || [])] } : null,
        packs: packs.sort((a, b) => (a.type === b.type ? (a.id < b.id ? -1 : 1) : a.type < b.type ? -1 : 1)),
      };
    },
    /**
     * The content identity of this server (shared/contentTag.js): the packs in force and one short tag over them. What
     * GET /healthz reports as `mods`, and what a client compares with the tag it computes from the index it loaded.
     */
    content() {
      // Canonical order (type, then id — the index's order), so /healthz, the log and the panel never disagree about it.
      const identity = refresh().packs.filter((p) => p.supported && isIdentityPack(p.manifest)).map((p) => ({
        type: p.type, id: p.id, version: p.manifest.version || '', compatible: p.manifest.compatible !== false, bytes: p.bytes,
      })).sort((a, b) => (a.type === b.type ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.type < b.type ? -1 : 1));
      const languages = refresh().packs.filter((p) => p.supported && !isIdentityPack(p.manifest)).length;
      return {
        tag: contentTag(APP_VERSION, identity),
        packs: identity.map(({ bytes, ...rest }) => rest),
        languages,
        summary: contentSummary(identity),
      };
    },
    /**
     * The file behind /packs/<id>/<rel>, or null: only a file a supported folder pack names.
     * @param {string} id
     * @param {string} rel
     */
    servable(id, rel) {
      const p = refresh().byId.get(id);
      if (!p || !p.supported || p.layout !== 'folder') return null;
      for (const list of Object.values(p.files)) for (const f of list) if (f.rel === rel) return f.abs;
      return null;
    },
  };
}
