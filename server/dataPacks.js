// server/dataPacks.js — content packs, type "data" (docs/PACKS.md §4): the data patches a server applies at start.
//
// A data pack ships one or more patch files; each is `{ "<data file>": <merge patch> }`, a JSON Merge Patch (RFC 7386)
// per file: objects merge recursively, `null` deletes a member, arrays and scalars replace. The server merges them into
// the tables it loaded (server/data.js) and serves the PATCHED tables at /data/<name>.json, so a browser reads exactly
// what the server simulates with — the whole point of the type: a data pack is never a client-side change.
//
// The tables are deep-frozen (server/data.js deepFreeze), so a merge never touches the loaded objects: it clones the
// objects it descends into and shares the rest. That keeps an unpatched file byte-identical to the one on disk.
//
// `live: false` (shared/packs.js): the simulation's data is fixed for the life of the process, so a pack added or edited
// while the server runs takes effect at the next start. The boot log and GET /healthz name what was applied.

/**
 * RFC 7386 merge patch: `patch` over `base`, returning a new value (the inputs are never modified).
 * @param {any} base @param {any} patch
 */
export function mergePatch(base, patch) {
  if (patch === null) return null; // the caller refuses a top-level null (a patch may not delete a whole table)
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

/**
 * Every patch of the enabled data packs, merged per data file, in pack order (the registry sorts by type then id, so
 * the later id wins a conflict inside one path — the same rule the assets type uses).
 * @param {any[]} packs the data packs (server/packs.js `list('data')`)
 * @returns {Map<string, { file: string, patch: any, packs: string[] }>}
 */
export function collectDataPatches(packs) {
  const byFile = new Map();
  for (const pack of packs || []) {
    for (const entry of pack.patches || []) {
      const cur = byFile.get(entry.file);
      if (cur) {
        cur.patch = mergePatch(cur.patch, entry.patch);
        if (!cur.packs.includes(pack.id)) cur.packs.push(pack.id);
      } else {
        byFile.set(entry.file, { file: entry.file, patch: entry.patch, packs: [pack.id] });
      }
    }
  }
  return byFile;
}

/**
 * The tables the game runs on: the loaded ones, with the enabled packs' patches merged in.
 * @param {Record<string, any>} tables the loaded tables (deep-frozen)
 * @param {any[]} packs the data packs
 * @param {{ log?: { info?: Function, warn?: Function }, known?: readonly string[] }} [opts] known: the data file names
 * @returns {{ tables: Record<string, any>, applied: { file: string, packs: string[] }[], overrides: Map<string, any> }}
 *   overrides: the patched tables by name (what /data/<name>.json is served from)
 */
export function applyDataPacks(tables, packs, { log = {}, known = null } = {}) {
  const byFile = collectDataPatches(packs);
  if (!byFile.size) return { tables, applied: [], overrides: new Map() };
  // copied lazily: an install where every patch was refused keeps the very tables it loaded
  let out = tables;
  const overrides = new Map();
  const applied = [];
  for (const [file, entry] of byFile) {
    if (known && !known.includes(file)) { log.warn?.(`[packs] data patch for unknown table "${file}" ignored`); continue; }
    const base = tables[file];
    const next = mergePatch(base === undefined ? {} : base, entry.patch);
    // A patch stays a patch. A pack's patch values are already checked to be objects when the pack is scanned
    // (server/packs.js), so this only catches a caller handing over a hand-made patch — but a data pack that replaced a
    // table with a scalar would take the whole game down, so it is refused here too.
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      log.warn?.(`[packs] data patch ${entry.packs.join(', ')}: "${file}" would not stay a table; ignored`);
      continue;
    }
    if (out === tables) out = { ...tables };
    out[file] = next;
    overrides.set(file, next);
    applied.push({ file, packs: entry.packs.slice() });
  }
  if (applied.length) {
    log.info?.(`[packs] data patches applied: ${applied.map((a) => `${a.file} (${a.packs.join(', ')})`).join(', ')}`);
  }
  return { tables: out, applied, overrides };
}

/**
 * A short digest of the patched tables (the content hash clients will be told about — docs/PACKS.md §4). Stable for a
 * given set of patches whatever order the packs were scanned in, because the file names are sorted first.
 * @param {{ tables: Record<string, any>, applied: { file: string, packs: string[] }[] }} result
 * @param {(text: string) => string} hash a hash function (node:crypto in the server)
 */
export function dataPackTag(result, hash) {
  if (!result.applied.length) return '';
  const parts = [...result.applied].sort((a, b) => (a.file < b.file ? -1 : 1)).map((a) => `${a.file}:${a.packs.join('+')}`);
  return hash(parts.join('|')).slice(0, 12);
}
