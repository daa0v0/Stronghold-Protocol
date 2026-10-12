// mods/revive-teammate — 扣自己 10 点血量复活一名队友 (docs/MODS.md).
//
// Two halves are under test, and they are deliberately separate:
//   * the CARD is data: the data pack `packs/revive-teammate/` has to carry it into `choices.cards.tactic`, and the draft's
//     kinds have to draw it, or a player would never see it;
//   * the EFFECT is code: the mod registers `choice:revive_ally` (shared/modContent.js) and this file drives a real match
//     through the real loader, the real pick path and the invariant audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE } from '../../shared/constants.js';
import { resetModContent } from '../../shared/modContent.js';
import { createPackRegistry } from '../../server/packs.js';
import { applyDataPacks } from '../../server/dataPacks.js';
import { loadData, DATA_FILES } from '../../server/data.js';
import { serveDirs } from '../../server/http/config.js';
import { loadMods, scanMods } from '../../server/mods.js';
import { resetDefaultRegistry } from '../../server/match/effectsMeta.js';
import { installDraftFacade } from '../../server/match/match/phases.js';
import { makeMatch, checkInvariants } from './harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const silent = { info() {}, warn() {}, error() {} };
const EFFECT = 'revive_ally';
const CARD = JSON.parse(fs.readFileSync(path.join(ROOT, 'mods', 'revive-teammate', 'card.json'), 'utf8'));

/** The tables a server with the repository's packs/ really plays with — including this mod's card. */
function packedData() {
  const dirs = serveDirs({});
  const registry = createPackRegistry(dirs, { log: silent });
  return applyDataPacks(loadData(dirs.dataDir, { log: silent }), registry.list('data'), { log: silent, known: DATA_FILES }).tables;
}

/** Load the shipped mod through the real loader, with the registry rebuilt so its handler is part of it. */
async function withMod(run) {
  resetModContent();
  resetDefaultRegistry();
  const scan = scanMods(path.join(ROOT, 'mods'));
  const runtime = await loadMods(scan.mods, { enabled: ['revive-teammate'], log: silent });
  try {
    assert.deepEqual(runtime.failed, [], 'the mod loads');
    assert.deepEqual(runtime.loaded.map((m) => m.id), ['revive-teammate']);
    await run();
  } finally { resetModContent(); resetDefaultRegistry(); }
}

/**
 * A four-player co-op in the 机变 draft whose page holds exactly the mod's card, so the test exercises the EFFECT rather than
 * the draw (the draw is covered by the pack test below).
 */
function draftWithTheCard(seed = 7) {
  const h = makeMatch({ humans: 4, seed, fake: true, data: packedData() }).start().toPrep(1);
  const m = h.m;
  const groups = m.makeDraftGroups({ shuffle: false });
  const card = { kind: 'tactic', id: CARD.effectId, name: CARD.name, desc: CARD.desc, tier: null, team: false, tacticKind: CARD.kind, idx: 0 };
  for (const g of groups) Object.assign(g, { cards: [card], taken: {} });
  m.phase = PHASE.SP_DRAFT;
  m.sp = installDraftFacade({ ...groups[0], id: m.nextDraftId('sp'), groups, picks: {}, untimed: m.soloUntimed },
    ['order', 'idx', 'cards', 'taken', 'turnDeadline', 'turnSeconds']);
  for (const g of groups) m.startSpTurn(g);
  return { h, m, card };
}

test('the pack carries the card and the draft draws its kind', () => {
  const data = packedData();
  const card = (data.choices.cards.tactic || []).find((c) => c.effectId === EFFECT);
  assert.ok(card, 'packs/revive-teammate must put the card into choices.cards.tactic');
  assert.equal(card.name, CARD.name);
  assert.equal(card.team, false, 'it applies to the picker, not to every teammate');
  assert.equal(card.kind, 'ally', 'and it is a kind the 机变 draft draws at R11');
  assert.ok(data.choices.tacticDraft.kinds.includes(card.kind));
  // the whole list survives the array patch (a merge patch replaces arrays): the game's own cards are still there
  assert.ok(data.choices.cards.tactic.length > 40, `${data.choices.cards.tactic.length} tactic cards after the patch`);
  assert.ok(data.choices.cards.tactic.some((c) => c.effectId === 'allybuff_select_1'), 'and the shipped ones too');
});

test('picking the card pays 10 HP and brings the earliest eliminated teammate back', async () => {
  await withMod(async () => {
    const { h, m } = draftWithTheCard();
    try {
      const picker = m.players.get(m.sp.groups[0].order[0]);
      const fallen = h.ps('p_2');
      fallen.lp = 0;
      fallen.eliminate(1);
      assert.equal(fallen.alive, false);
      assert.deepEqual(m.revivableTeammates().map((c) => c.playerId), ['p_2']);

      const before = picker.lp;
      assert.ok(m.pickCard(picker, 0).ok, 'the card can be picked');
      assert.equal(picker.lp, before - 10, 'the picker paid the cost');
      assert.equal(fallen.alive, true, 'and the teammate is back');
      assert.equal(fallen.lp, m.gd.startLp(fallen.bandId), 'with the health its band starts with');
      assert.equal(fallen.eliminatedRound, null);
      assert.deepEqual(m.revivableTeammates(), [], 'nobody else is out');
      checkInvariants(m);
    } finally { h.m.dispose(); }
  });
});

test('nothing happens — and nothing is charged — when there is nobody to revive or too little health', async () => {
  await withMod(async () => {
    // nobody eliminated: the pick goes through, the picker keeps its health
    const first = draftWithTheCard(21);
    try {
      const picker = first.m.players.get(first.m.sp.groups[0].order[0]);
      const before = picker.lp;
      assert.ok(first.m.pickCard(picker, 0).ok);
      assert.equal(picker.lp, before, 'no teammate to revive, so no cost');
      assert.deepEqual(first.m.revivableTeammates(), []);
    } finally { first.h.m.dispose(); }

    // a fallen teammate, but the picker cannot afford it
    const second = draftWithTheCard(22);
    try {
      const picker = second.m.players.get(second.m.sp.groups[0].order[0]);
      const fallen = second.h.ps('p_3');
      fallen.lp = 0;
      fallen.eliminate(1);
      picker.lp = 10; // exactly the cost: the rule needs MORE than the cost
      assert.ok(second.m.pickCard(picker, 0).ok);
      assert.equal(picker.lp, 10, 'not charged');
      assert.equal(fallen.alive, false, 'and nobody came back');
      checkInvariants(second.m);
    } finally { second.h.m.dispose(); }
  });
});

test('a seat that LEFT is never revived (a quit is not a defeat)', async () => {
  await withMod(async () => {
    const { h, m } = draftWithTheCard(31);
    try {
      const left = h.ps('p_1');
      left.lp = 0;
      left.eliminate(1);
      left.left = true;
      assert.deepEqual(m.revivableTeammates(), [], 'a left seat is not a candidate');
      assert.deepEqual(m.revivePlayer('p_1'), { ok: false, error: 'LEFT' });
      // and the core API refuses the other impossible cases too
      assert.deepEqual(m.revivePlayer('nobody'), { ok: false, error: 'UNKNOWN_PLAYER' });
      assert.deepEqual(m.revivePlayer(m.players.get(m.sp.groups[0].order[0]).playerId), { ok: false, error: 'ALIVE' });
    } finally { h.m.dispose(); }
  });
});
