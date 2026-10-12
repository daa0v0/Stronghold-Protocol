// tools/skins-pack.mjs — 干员皮肤的内容包 (docs/SKINS.md, docs/PACKS.md §4).
//
// The skins' CONTENT is a data pack now (packs/stronghold-skins/), and the FEATURE stays in the code (ui/skins.js,
// ui/skinPicker.js, the battle/render plumbing, room.skins). Two halves make up the content, and the pack carries both:
//
//   * the CATALOGUE   — data/skins.json, `{ version, counts, chars: { <charId>: [{ id, name, group }] } }`: every skin the
//                       project knows about, installed or not (the picker shows the difference);
//   * the INSTALLED   — the `chars[charId].skins[skinId] = { name, group, avatar, spine? }` manifest blocks of
//                       data/assets.json: the skins whose art is on this machine.
//
// The art itself never moves into a pack here: it stays public/assets/ (spine models, avatars), which is not in git either
// (AGENTS.md). A pack's `data` patch merges over the base tables, so a server that has this pack loads exactly what the
// base tables used to hold — and an owner who adds skins drops their own pack beside it, or edits this one.
//
// This tool is the generation step the repository's generated-data rule asks for: data/*.json is never edited by hand.
//
//   node tools/skins-pack.mjs --migrate [--dry]           move what the base tables hold into the pack, leave them empty
//   node tools/skins-pack.mjs --from=<assets.json> [--dry] merge a source manifest's skin blocks into the pack
//   node tools/skins-pack.mjs --check                      fail (exit 1) if the base tables still carry skin content
//
// Exit codes: 0 = done (or nothing to do), 1 = unusable input or a dirty base.
//
// The source manifest of --from is the fusion build's data/assets.json — the origin of this feature's content (docs/SKINS.md
// has the provenance). Its operators that this build's data does not know are reported and skipped, never invented.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_FILES } from '../server/data.js';

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'));
const ASSETS = join(ROOT, 'data', 'assets.json');
const CATALOGUE = join(ROOT, 'data', 'skins.json');
const PACK_DIR = join(ROOT, 'packs', 'stronghold-skins');
const PACK_MANIFEST = join(PACK_DIR, 'pack.json');
const PACK_PATCH = join(PACK_DIR, 'patch.json');
const PACK_ID = 'stronghold-skins';

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { from: null, migrate: false, check: false, dry: false, version: null };
  for (const a of argv) {
    if (a === '--migrate') out.migrate = true;
    else if (a === '--check') out.check = true;
    else if (a === '--dry') out.dry = true;
    else if (a.startsWith('--from=')) out.from = a.slice('--from='.length);
    else if (a.startsWith('--version=')) out.version = a.slice('--version='.length);
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  return out;
}

/** @param {string} p */
function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** data/*.json is compact JSON — the generators write it that way. @param {string} p @param {any} value */
function writeCompact(p, value) {
  writeFileSync(p, JSON.stringify(value));
}

const countSkins = (blocks) => Object.values(blocks).reduce((n, byId) => n + Object.keys(byId).length, 0);
const countSpine = (blocks) => Object.values(blocks).reduce((n, byId) => n + Object.values(byId).filter((v) => v && v.spine).length, 0);

/** Take every `chars[charId].skins` block out of a manifest, in place. @param {any} assets */
function takeSkins(assets) {
  /** @type {Record<string, any>} */
  const blocks = {};
  for (const [charId, rec] of Object.entries(assets.chars || {})) {
    if (!rec || !rec.skins || !Object.keys(rec.skins).length) continue;
    blocks[charId] = rec.skins;
    delete rec.skins;
  }
  return blocks;
}

/** The skin blocks of a source manifest, limited to the operators this build's data knows about. @param {any} source */
function skinsOf(source, known) {
  /** @type {Record<string, any>} */
  const blocks = {};
  const skipped = [];
  for (const [charId, rec] of Object.entries(source?.chars || {})) {
    if (!rec || !rec.skins || !Object.keys(rec.skins).length) continue;
    if (!known.has(charId)) { skipped.push(charId); continue; }
    blocks[charId] = rec.skins;
  }
  return { blocks, skipped };
}

/** The catalogue rows a manifest's blocks imply (id, name, group), for skins the catalogue does not list yet. */
function catalogueRows(blocks, catalogue) {
  /** @type {Record<string, { id: string, name: string, group: string }[]>} */
  const rows = {};
  for (const [charId, byId] of Object.entries(blocks)) {
    const have = new Set((catalogue.chars?.[charId] || []).map((s) => s.id));
    for (const [skinId, rec] of Object.entries(byId)) {
      if (have.has(skinId)) continue;
      (rows[charId] ||= []).push({ id: skinId, name: rec?.name || skinId, group: rec?.group || '' });
      have.add(skinId);
    }
  }
  return rows;
}

/** The merge patch of a data pack: `{ "<data file>": <merge patch> }` over the base tables (server/dataPacks.js). */
function buildPatch(blocks, catalogue) {
  const patch = {};
  if (Object.keys(blocks).length) patch.assets = { chars: Object.fromEntries(Object.entries(blocks).map(([id, skins]) => [id, { skins }])) };
  if (catalogue && Object.keys(catalogue.chars || {}).length) patch.skins = catalogue;
  return patch;
}

/** The pack manifest, keeping an existing one's version/name unless told otherwise. */
function packManifest(version) {
  const previous = existsSync(PACK_MANIFEST) ? readJson(PACK_MANIFEST) : null;
  return {
    type: 'data',
    name: '干员皮肤',
    englishName: 'Operator skins',
    version: version || previous?.version || '1.0.0',
    app: '>=0.2.4',
    authors: ['Stronghold Protocol'],
    description: '全部干员皮肤：data/skins.json 的目录与 data/assets.json 的已安装清单（美术仍在 public/assets/，见 docs/SKINS.md）',
    files: { patch: 'patch.json' },
  };
}

/** An empty catalogue: the same shape as before, so the pack's patch has the base rows merge into. @param {any} base */
function emptyCatalogue(base) {
  return { version: base?.version ?? 1, counts: { chars: 0, skins: 0 }, chars: {} };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.from) return fromSource(args);
  if (args.migrate) return migrate(args);
  if (args.check) return check();
  console.error('usage: node tools/skins-pack.mjs --migrate | --from=<source assets.json> | --check   [--dry] [--version=x.y.z]');
  process.exit(1);
}

/** One-time move: what the base tables hold goes into the pack, the base tables are left clean and reproducible. */
function migrate(args) {
  let assets, catalogue;
  try { assets = readJson(ASSETS); } catch (e) { console.error(`✘ ${ASSETS}: ${e.message}`); process.exit(1); }
  try { catalogue = readJson(CATALOGUE); } catch (e) { console.error(`✘ ${CATALOGUE}: ${e.message}`); process.exit(1); }
  if (!assets.chars) { console.error('✘ data/assets.json has no `chars` — regenerate it with `npm run build-data`'); process.exit(1); }

  const blocks = takeSkins(assets);
  const chars = Object.keys(blocks).length, skins = countSkins(blocks), withSpine = countSpine(blocks);
  const rows = catalogue.chars && Object.keys(catalogue.chars).length ? catalogue : null;
  if (!skins && !rows) { console.log('skins-pack: the base tables are already clean, nothing to migrate'); return; }
  if (args.dry) {
    console.log(`skins-pack (dry): would move ${chars} operators / ${skins} skins (${withSpine} with a Spine model)` +
      `${rows ? ` and ${Object.keys(rows.chars).length} catalogue rows` : ''} → packs/${PACK_ID}/`);
    return;
  }

  const patch = buildPatch(blocks, rows);
  const manifest = packManifest(args.version);
  mkdirSync(PACK_DIR, { recursive: true });
  writeCompact(PACK_PATCH, patch);
  writeFileSync(PACK_MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  writeCompact(ASSETS, assets);
  writeCompact(CATALOGUE, emptyCatalogue(catalogue));
  const kb = (JSON.stringify(patch).length / 1024).toFixed(0);
  console.log(`skins-pack: moved ${chars} operators / ${skins} skins (${withSpine} with a Spine model) into packs/${PACK_ID}/patch.json (${kb} KB)`);
  console.log(`            data/assets.json no longer carries skin blocks; data/skins.json is an empty catalogue`);
}

/** The generation step for new content: merge a source manifest's blocks (and their catalogue rows) into the pack. */
function fromSource(args) {
  let source, assets, catalogue;
  try { source = readJson(resolve(args.from)); } catch (e) { console.error(`✘ ${args.from}: ${e.message}`); process.exit(1); }
  try { assets = readJson(ASSETS); } catch (e) { console.error(`✘ ${ASSETS}: ${e.message}`); process.exit(1); }
  const known = new Set([...Object.keys(assets.chars || {}), ...(existsSync(PACK_PATCH) ? Object.keys(readJson(PACK_PATCH).assets?.chars || {}) : [])]);
  const { blocks, skipped } = skinsOf(source, known);
  if (skipped.length) console.warn(`  ! ${skipped.length} operators of the source are not in this build's data: ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? ' …' : ''}`);
  if (!Object.keys(blocks).length) { console.log('skins-pack: nothing to inject'); return; }

  const patch = existsSync(PACK_PATCH) ? readJson(PACK_PATCH) : {};
  patch.assets ||= { chars: {} };
  patch.assets.chars ||= {};
  for (const [charId, skins] of Object.entries(blocks)) patch.assets.chars[charId] = { ...(patch.assets.chars[charId] || {}), skins };
  try { catalogue = readJson(CATALOGUE); } catch { catalogue = emptyCatalogue(null); }
  const merged = { ...(patch.skins || emptyCatalogue(catalogue)) };
  merged.chars = { ...(merged.chars || {}) };
  for (const [charId, list] of Object.entries(catalogueRows(blocks, merged))) merged.chars[charId] = [...(merged.chars[charId] || []), ...list];
  merged.counts = { chars: Object.keys(merged.chars).length, skins: Object.values(merged.chars).reduce((n, list) => n + list.length, 0) };
  merged.version ??= catalogue.version ?? 1;
  patch.skins = merged;

  const skins = countSkins(blocks), withSpine = countSpine(blocks);
  if (args.dry) { console.log(`skins-pack (dry): would inject ${Object.keys(blocks).length} operators / ${skins} skins (${withSpine} with a Spine model) → packs/${PACK_ID}/patch.json`); return; }
  mkdirSync(PACK_DIR, { recursive: true });
  writeCompact(PACK_PATCH, patch);
  if (!existsSync(PACK_MANIFEST)) writeFileSync(PACK_MANIFEST, JSON.stringify(packManifest(args.version), null, 2) + '\n');
  console.log(`skins-pack: ${Object.keys(blocks).length} operators / ${skins} skins (${withSpine} with a Spine model) → packs/${PACK_ID}/patch.json`);
  console.log(`            catalogue now ${merged.counts.chars} operators / ${merged.counts.skins} skins`);
}

/** Report the split, and fail if the base tables still carry what the pack is meant to own. */
function check() {
  const assets = readJson(ASSETS);
  const catalogue = readJson(CATALOGUE);
  const baseBlocks = Object.entries(assets.chars || {}).filter(([, v]) => v?.skins && Object.keys(v.skins).length);
  const baseRows = Object.keys(catalogue.chars || {}).length;
  const patch = existsSync(PACK_PATCH) ? readJson(PACK_PATCH) : null;
  const packBlocks = patch?.assets?.chars || {};
  const packSkinned = Object.fromEntries(Object.entries(packBlocks).map(([id, v]) => [id, v.skins || {}]));
  const packChars = Object.keys(packBlocks).length, packSkins = countSkins(packSkinned), packSpine = countSpine(packSkinned);
  const packCatalogue = patch?.skins?.chars || {};
  const problems = [];
  if (baseBlocks.length) problems.push(`data/assets.json still carries skins for ${baseBlocks.length} operators (${baseBlocks.slice(0, 3).map(([id]) => id).join(', ')})`);
  if (baseRows) problems.push(`data/skins.json still lists ${baseRows} operators`);
  if (!patch) problems.push(`packs/${PACK_ID}/patch.json is missing — run --migrate`);
  else {
    const unknown = Object.keys(patch).filter((k) => !DATA_FILES.includes(k));
    if (unknown.length) problems.push(`patch.json keys not in DATA_FILES: ${unknown.join(', ')}`);
    if (!packSkins) problems.push('patch.json carries no skins');
  }
  if (existsSync(PACK_MANIFEST)) {
    const manifest = readJson(PACK_MANIFEST);
    if (manifest.type !== 'data') problems.push(`pack.json type must be "data" (it is ${JSON.stringify(manifest.type)})`);
    if (!manifest.files?.patch) problems.push('pack.json names no files.patch');
  } else problems.push(`packs/${PACK_ID}/pack.json is missing`);

  console.log(`skins-pack: base tables ${Object.keys(assets.chars || {}).length} operators / 0 skins, catalogue ${baseRows} operators`);
  console.log(`            pack ${packChars} operators / ${packSkins} skins (${packSpine} with a Spine model), catalogue ${Object.keys(packCatalogue).length} operators`);
  if (problems.length) { for (const p of problems) console.error(`✘ ${p}`); process.exit(1); }
  console.log('✔ the skin content lives in the pack, the base tables are clean');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
