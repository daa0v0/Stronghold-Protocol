// server/mods.js — 代码 mod (docs/PACKS.md §4, "Code and gameplay mods"): a folder under `mods/` that the server OWNER
// installs and enables. Deliberately NOT a content pack, and deliberately not reachable from one:
//
//   * a pack manifest never runs anything, and a pack's files are served to browsers — a code mod runs inside this process
//     with the server's privileges, and `mods/` is never served and never listed in the pack index;
//   * dropping a folder in does nothing: a mod runs only when its id is listed in `runtime/server-settings.json`
//     (`mods.enabled`, the /admin 代码 mod panel writes the same key). A forgotten folder must never execute;
//   * every enabled mod is loaded once at start, in id order, after the content packs and the data tables; a mod that
//     throws is reported and skipped, because one broken mod must not keep the server from booting;
//   * what it can do is what the server can do: its entry is an ordinary ES module of this process and may import
//     anything under `server/` (the kits/traits/effects extension points included). docs/PACKS.md says that in the owner's
//     terms: treat a downloaded mod as a downloaded executable.
//
// `mods/<id>/mod.json`: { id, name, version, app, authors, entry: "main.mjs" } — `entry` is a path inside the folder (the
// only file the loader reads from it), `.mjs` or `.js`, and must export `setup(ctx)` (or a default function), which is
// awaited. `ctx` = { id, version, log, data, packs, root }.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isPackId, isPackPath } from '../shared/packs.js';
import { ROOT } from './http/config.js';

export const MOD_MANIFEST = 'mod.json';
/** The folder the loader reads (never served: server/http/static.js mounts only public/, shared/, sim/ and data/). */
export const MODS_DIR = 'mods';
const MAX_MODS = 64;
const MAX_JSON_BYTES = 256 * 1024;
const ENTRY_EXT = ['.mjs', '.js'];
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const sortedDirs = (dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort(); }
  catch { return []; }
};

/**
 * Read every `mods/<id>/mod.json` and validate it. Nothing is executed here.
 * @param {string} dir the mods folder
 * @returns {{ mods: { id: string, dir: string, manifest: any, entry: string, entryExt: string }[],
 *   skipped: { where: string, problems: string[] }[], warnings: { where: string, warning: string }[] }}
 */
export function scanMods(dir) {
  /** @type {any[]} */
  const mods = [];
  /** @type {{ where: string, problems: string[] }[]} */
  const skipped = [];
  /** @type {{ where: string, warning: string }[]} */
  const warnings = [];
  for (const id of sortedDirs(dir)) {
    const where = `${MODS_DIR}/${id}/`;
    const abs = path.join(dir, id, MOD_MANIFEST);
    let manifest;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) { skipped.push({ where, problems: ['not a file'] }); continue; }
      if (st.size > MAX_JSON_BYTES) { skipped.push({ where, problems: [`larger than ${MAX_JSON_BYTES >> 10} KB`] }); continue; }
      manifest = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      skipped.push({ where, problems: [e?.code === 'ENOENT' ? `no ${MOD_MANIFEST}` : e instanceof SyntaxError ? `not valid JSON (${e.message})` : String(e?.code || e?.message || e)] });
      continue;
    }
    const problems = [];
    if (!isObj(manifest)) problems.push(`${MOD_MANIFEST} must be a JSON object`);
    else {
      if (!isPackId(id)) problems.push(`the folder name "${id}" is not a mod id (letters, digits, '.', '_', '-', ≤ 64)`);
      if (manifest.id !== undefined && manifest.id !== id) problems.push(`"id" says ${JSON.stringify(manifest.id)} but the folder is "${id}"`);
      if (manifest.type !== undefined) problems.push('"type" is a content-pack field: mods/ holds code mods, packs/ holds packs (docs/PACKS.md §4)');
      const entry = manifest.entry;
      if (typeof entry !== 'string' || !entry) problems.push('no "entry" (the module to load, e.g. "main.mjs")');
      else if (!isPackPath(entry)) problems.push(`"entry": ${JSON.stringify(entry).slice(0, 80)} is not a path inside the mod folder`);
      else if (!ENTRY_EXT.includes(path.extname(entry).toLowerCase())) problems.push(`"entry" must be a ${ENTRY_EXT.join(' / ')} file`);
      else {
        const entryAbs = path.join(dir, id, ...entry.split('/'));
        if (!fs.existsSync(entryAbs) || !fs.statSync(entryAbs).isFile()) problems.push(`"entry": ${entry} is missing`);
      }
      for (const key of Object.keys(manifest)) {
        // `type` is already a problem above (a pack field in a mod manifest), not an ignored extra: say it once.
        if (key === 'type') continue;
        if (!['id', 'name', 'version', 'app', 'authors', 'credits', 'license', 'entry'].includes(key)) {
          warnings.push({ where, warning: `"${key}" is not a mod field (ignored)` });
        }
      }
    }
    if (problems.length) { skipped.push({ where, problems }); continue; }
    mods.push({ id, dir: path.join(dir, id), manifest, entry: manifest.entry, entryExt: path.extname(manifest.entry).toLowerCase() });
  }
  if (mods.length > MAX_MODS) {
    const extra = mods.splice(MAX_MODS);
    skipped.push({ where: `${MODS_DIR}/`, problems: [`${extra.length} more mods than the ${MAX_MODS} this server loads (${extra.map((m) => m.id).join(', ')})`] });
  }
  return { mods, skipped, warnings };
}

/**
 * Load the enabled mods, in id order. Never throws: a mod that cannot be imported or whose setup rejects is reported in
 * `failed` and the rest continue (an owner's mistake must not take the server down).
 * @param {ReturnType<typeof scanMods>['mods']} mods
 * @param {{ enabled?: readonly string[], data?: any, packs?: any, log?: { info?: Function, warn?: Function } }} [opts]
 */
export async function loadMods(mods, { enabled = [], data = null, packs = null, log = console } = {}) {
  const wanted = new Set(enabled || []);
  const loaded = [];
  const failed = [];
  for (const mod of mods) {
    if (!wanted.has(mod.id)) continue;
    const version = typeof mod.manifest.version === 'string' ? mod.manifest.version : '';
    const modLog = {
      info: (...a) => log.info?.(`[mod ${mod.id}]`, ...a),
      warn: (...a) => log.warn?.(`[mod ${mod.id}]`, ...a),
    };
    try {
      const ns = await import(pathToFileURL(path.join(mod.dir, ...mod.entry.split('/'))).href);
      const setup = typeof ns.setup === 'function' ? ns.setup : typeof ns.default === 'function' ? ns.default : null;
      if (!setup) throw new Error(`the entry must export a setup(ctx) function (or a default function)`);
      await setup({ id: mod.id, version, log: modLog, data, packs, root: ROOT });
      loaded.push({ id: mod.id, version, entry: mod.entry });
      log.info?.(`[mods] ${mod.id}${version ? `@${version}` : ''} loaded (${mod.entry})`);
    } catch (error) {
      const message = String(error?.message || error);
      failed.push({ id: mod.id, error: message });
      log.warn?.(`[mods] ${mod.id} failed: ${message}`);
    }
  }
  return { loaded, failed };
}

/**
 * The code mods of this server, as a caller (GET /healthz, the /admin panel) may report them: what the folders hold,
 * which of them the owner enabled, and whether the running process actually loaded them.
 * @param {ReturnType<typeof scanMods>} scan @param {{ enabled?: readonly string[] }} [opts]
 * @param {{ loaded?: any[], failed?: any[] }} [runtime] what loadMods did at start
 */
export function modsReport(scan, { enabled = [] } = {}, runtime = {}) {
  const on = new Set(enabled || []);
  const loadedIds = new Set((runtime.loaded || []).map((m) => m.id));
  const failedIds = new Map((runtime.failed || []).map((m) => [m.id, m.error]));
  return {
    enabled: [...on],
    mods: scan.mods.map((m) => ({
      id: m.id, name: m.manifest.name || m.id, version: m.manifest.version || '', app: m.manifest.app || '',
      entry: m.entry, where: `${MODS_DIR}/${m.id}/`,
      enabled: on.has(m.id), running: loadedIds.has(m.id), error: failedIds.get(m.id) || null,
    })),
    skipped: scan.skipped,
    warnings: scan.warnings || [],
  };
}
