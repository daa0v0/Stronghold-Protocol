// 淘汰当场复活 — mods/revive-teammate (docs/MODS.md).
//
// The mod is asked for by the settle that eliminated a teammate (the core's `registerModSettleHook`), answers through the
// personal-choice plumbing (`Match.offerModChoice` + the real `g.choice` message) and changes the state through the core's
// revive/health APIs. This file drives all of that on a real three-player co-op: who gets asked, what accepting costs, what
// the revived seat comes back with, what declining and timing out do, and that the invariant audit is happy afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE } from '../../shared/constants.js';
import { resetModChoices } from '../../shared/modChoices.js';
import { resetMatchRuleProviders } from '../../shared/matchRules.js';
import { loadMods, scanMods } from '../../server/mods.js';
import { makeMatch, checkInvariants } from './harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const silent = { info() {}, warn() {}, error() {} };
const CHOICE = 'revive-teammate';
const COST = 10;
const REVIVE_LP = 1;

async function withMod(run) {
  resetModChoices();
  resetMatchRuleProviders();
  const scan = scanMods(path.join(ROOT, 'mods'));
  const runtime = await loadMods(scan.mods, { enabled: ['revive-teammate'], log: silent });
  try {
    assert.deepEqual(runtime.failed, [], 'the mod loads');
    assert.deepEqual(runtime.loaded.map((m) => m.id), ['revive-teammate']);
    await run();
  } finally { resetModChoices(); resetMatchRuleProviders(); }
}

/**
 * A three-player co-op that has just been through a settle in which p_2's LP ran out — the moment the mod asks about.
 * `codeMods` is the room's per-match choice: the mod asks about it, so `[]` is a room that left it out.
 * @param {{ seed?: number, survivorLp?: number, left?: boolean, codeMods?: string[] }} [o]
 */
function settled({ seed = 5, survivorLp = 28, left = false, codeMods = ['revive-teammate'] } = {}) {
  const h = makeMatch({ mode: 'coop', humans: 3, seed, fake: true, codeMods }).start().toPrep(1);
  const m = h.m;
  for (const ps of m.alivePlayers()) if (ps.playerId !== 'p_2') ps.lp = survivorLp;
  const victim = m.players.get('p_2');
  if (left) victim.left = true;
  victim.lp = 0;
  m.settle(null, null);
  assert.equal(m.phase, PHASE.SETTLE);
  assert.equal(victim.alive, false, 'the settle eliminated it');
  return h;
}

const openChoice = (m, pid) => m.players.get(pid).personalChoice;

test('every surviving teammate is asked, the eliminated seat is not', async () => {
  await withMod(() => {
    const h = settled();
    try {
      const m = h.m;
      for (const pid of ['p_0', 'p_1']) {
        const pending = openChoice(m, pid);
        assert.ok(pending, `${pid} was asked`);
        assert.equal(pending.modId, CHOICE);
        assert.equal(pending.data.target, 'p_2');
        assert.equal(pending.cards.length, 2, 'accept / decline');
        assert.equal(pending.title, '复生协议');
      }
      assert.equal(openChoice(m, 'p_2'), null, 'the eliminated seat is never asked');
      checkInvariants(m);
    } finally { h.m.dispose(); }
  });
});

test('accepting pays 10 health and brings the teammate back with ONE point', async () => {
  await withMod(() => {
    const h = settled();
    try {
      const m = h.m;
      const picker = m.players.get('p_0');
      const before = picker.lp;
      const other = m.players.get('p_1');
      assert.ok(other.personalChoice, 'the other teammate was asked too');
      const pending = picker.personalChoice;
      assert.deepEqual(m.handle('p_0', { t: 'g.choice', idx: 0, choiceId: pending.id }), { ok: true });
      const victim = m.players.get('p_2');
      assert.equal(victim.alive, true, 'back in the match');
      assert.equal(victim.lp, REVIVE_LP, 'with exactly one point of health');
      assert.equal(victim.eliminatedRound, null);
      assert.equal(picker.lp, before - COST, 'the picker paid the cost');
      assert.equal(other.lp, before, 'and the teammate who did not answer paid nothing');
      assert.equal(other.personalChoice, null, 'their prompt is gone: the seat is already back');
      checkInvariants(m);
    } finally { h.m.dispose(); }
  });
});

test('declining changes nothing, and neither does letting the window run out', async () => {
  await withMod(() => {
    const declined = settled({ seed: 7 });
    try {
      const m = declined.m;
      const picker = m.players.get('p_0');
      const before = picker.lp;
      assert.deepEqual(m.handle('p_0', { t: 'g.choice', idx: 1, choiceId: picker.personalChoice.id }), { ok: true });
      assert.equal(picker.lp, before, 'declining is free');
      assert.equal(m.players.get('p_2').alive, false, 'nobody came back');
      assert.equal(picker.personalChoice, null, 'and the prompt is closed');
    } finally { declined.m.dispose(); }

    const timedOut = settled({ seed: 7 });
    try {
      const m = timedOut.m;
      const picker = m.players.get('p_0');
      const before = picker.lp;
      m.enterPrep();   // the window closes here: an unanswered prompt takes the decline path
      assert.equal(picker.personalChoice, null, 'the prompt expired');
      assert.equal(picker.lp, before, 'no cost');
      assert.equal(m.players.get('p_2').alive, false, 'no revive');
    } finally { timedOut.m.dispose(); }
  });
});

test('a teammate who could not pay is never asked, and a seat that LEFT is not revived', async () => {
  await withMod(() => {
    const poor = settled({ seed: 9, survivorLp: COST });
    try {
      assert.equal(openChoice(poor.m, 'p_0'), null, 'exactly the cost is not enough to pay it');
      assert.equal(openChoice(poor.m, 'p_1'), null);
    } finally { poor.m.dispose(); }

    const quit = settled({ seed: 9, left: true });
    try {
      assert.equal(openChoice(quit.m, 'p_0'), null, 'a seat that LEFT is not a defeat: nobody is asked');
      assert.equal(openChoice(quit.m, 'p_1'), null);
    } finally { quit.m.dispose(); }
  });
});

test('a second teammate cannot pay for a seat that is already back', async () => {
  await withMod(() => {
    const h = settled({ seed: 11 });
    try {
      const m = h.m;
      const first = m.players.get('p_0');
      const second = m.players.get('p_1');
      const pending = second.personalChoice;          // keep the second prompt alive by hand
      m.handle('p_0', { t: 'g.choice', idx: 0, choiceId: first.personalChoice.id });
      second.personalChoice = pending;                // as if the answer arrived before the mod cleared it
      const before = second.lp;
      assert.deepEqual(m.handle('p_1', { t: 'g.choice', idx: 0, choiceId: pending.id }), { ok: true });
      assert.equal(second.lp, before, 'nothing is charged for a seat that is already back');
      assert.equal(m.players.get('p_2').lp, REVIVE_LP, 'and its health is left as it came back');
      checkInvariants(m);
    } finally { h.m.dispose(); }
  });
});

test('a room that did not pick the mod is never asked (the mod still runs server-wide)', async () => {
  await withMod(() => {
    const h = settled({ seed: 13, codeMods: [] });
    try {
      const m = h.m;
      assert.equal(m.roomMods.length, 0);
      assert.equal(m.modEnabled('revive-teammate'), false, 'this match left the mod out');
      assert.equal(openChoice(m, 'p_0'), null, 'so nobody was asked');
      assert.equal(openChoice(m, 'p_1'), null);
      assert.equal(m.players.get('p_2').alive, false, 'and the seat stays out');
      checkInvariants(m);
    } finally { h.m.dispose(); }
  });
});
