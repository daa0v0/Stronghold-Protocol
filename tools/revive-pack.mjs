// tools/revive-pack.mjs — the data pack that carries the 复生协议 card (docs/MODS.md).
//
// The card itself lives with its mod (`mods/revive-teammate/card.json`), but it has to reach the draft through the data the
// server loads, and that is what this pack is for. The reason a tool owns the file: `choices.cards.tactic` is an ARRAY, and
// a merge patch REPLACES arrays — so a pack that adds one card must supply the whole list, and hand-maintaining 43 entries
// would drift the moment the game gains a tactic card.
//
//   node tools/revive-pack.mjs --write     regenerate packs/revive-teammate/patch.json from data/choices.json + the card
//   node tools/revive-pack.mjs --check     fail if the pack is stale (a new game card, a changed card) or inconsistent
//
// Exit codes: 0 = in step, 1 = stale or unusable, 2 = bad arguments.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'));
const CHOICES = join(ROOT, 'data', 'choices.json');
const CARD = join(ROOT, 'mods', 'revive-teammate', 'card.json');
const CONFIG = join(ROOT, 'mods', 'revive-teammate', 'config.json');
const PACK_DIR = join(ROOT, 'packs', 'revive-teammate');
const PATCH = join(PACK_DIR, 'patch.json');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** The patch the pack must hold: the live tactic list plus (once) our card, and the draft config if it needs us. */
function buildPatch() {
  const choices = readJson(CHOICES);
  const card = readJson(CARD);
  const config = readJson(CONFIG);
  const list = Array.isArray(choices.cards && choices.cards.tactic) ? choices.cards.tactic : [];
  const others = list.filter((c) => c && c.effectId !== card.effectId);
  const problems = [];
  if (card.effectId !== config.effectId) problems.push(`card.json effectId ${card.effectId} != config.json effectId ${config.effectId}`);
  if (!Array.isArray(choices.tacticDraft?.kinds) || !choices.tacticDraft.kinds.includes(card.kind)) {
    problems.push(`kind "${card.kind}" is not drawn at the rounds of choices.json tacticDraft (${JSON.stringify(choices.tacticDraft?.kinds)})`);
  }
  // The card is drawn by kind, and a card the draft's `seen`/`weights` do not mention still draws (weight 1) — say so
  // rather than surprise a pack author later.
  const notes = [];
  if (choices.tacticDraft?.weights && !Object.hasOwn(choices.tacticDraft.weights, card.effectId)) {
    notes.push(`no explicit weight for ${card.effectId}: it draws with weight 1`);
  }
  return { patch: { choices: { cards: { tactic: [...others, card] } } }, problems, notes, others: others.length };
}

/** @param {string[]} argv */
function main(argv) {
  const write = argv.includes('--write');
  const check = argv.includes('--check') || !write;
  if (!write && !check) { console.error('usage: node tools/revive-pack.mjs [--write | --check]'); return 2; }
  let built;
  try { built = buildPatch(); } catch (error) { console.error(`✘ ${error.message}`); return 1; }
  for (const note of built.notes) console.log(`  · ${note}`);
  if (built.problems.length) { for (const p of built.problems) console.error(`✘ ${p}`); return 1; }

  if (write) {
    mkdirSync(PACK_DIR, { recursive: true });
    writeFileSync(PATCH, JSON.stringify(built.patch, null, 2) + '\n');
    console.log(`revive-pack: wrote ${PATCH} (${built.others} game cards + the mod's own)`);
    return 0;
  }
  if (!existsSync(PATCH)) { console.error(`✘ ${PATCH} is missing — run --write`); return 1; }
  const current = JSON.stringify(readJson(PATCH));
  const wanted = JSON.stringify(built.patch);
  if (current !== wanted) {
    console.error('✘ packs/revive-teammate/patch.json is stale — run --write (a game update probably added a tactic card)');
    const a = readJson(PATCH).choices.cards.tactic.length, b = built.patch.choices.cards.tactic.length;
    if (a !== b) console.error(`    it holds ${a} cards, the game has ${b - 1} + ours`);
    return 1;
  }
  console.log(`revive-pack: in step (${built.others} game cards + ${readJson(CARD).effectId})`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
