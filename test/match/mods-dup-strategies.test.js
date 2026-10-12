// 同策略可复选 — a real, shipped CODE MOD (docs/MODS.md, mods/dup-strategies/).
//
// The rule it changes is a runtime one (`shared/matchRules.js`): the draft's availability check, the invariant audit and the
// client view all read it, so this file pins all three — the shipped behaviour, the modded behaviour, and that the mod's own
// `setup(ctx)` is what flips it (loaded through the real loader, not by calling the setter by hand).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE } from '../../shared/constants.js';
import { MATCH_RULE_DEFAULTS, matchRules, resetMatchRules, setMatchRules } from '../../shared/matchRules.js';
import { loadMods, scanMods } from '../../server/mods.js';
import { makeMatch, checkInvariants } from './harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const silent = { info() {}, warn() {}, error() {} };

/** A four-player co-op sitting in the 机变 draft: 4 players share ONE pool group (grouping starts at six). */
function draftMatch(seed = 11) {
  const h = makeMatch({ humans: 4, seed, fake: true }).start().toPrep(1);
  h.m.enterSpDraft();
  assert.equal(h.m.phase, PHASE.SP_DRAFT);
  assert.equal(h.m.sp.groups.length, 1, 'four players share one card pool');
  return h;
}
const twoPickers = (m) => {
  const g = m.sp.groups[0];
  assert.ok(g.cards.length >= 1 && g.order.length >= 2, 'a page with two turns');
  return { g, first: m.players.get(g.order[0]), second: m.players.get(g.order[1]) };
};

test('shipped behaviour: a card belongs to the one player who took it', () => {
  resetMatchRules();
  const h = draftMatch();
  try {
    const m = h.m;
    const { g, first, second } = twoPickers(m);
    assert.equal(matchRules().choiceDuplicates, false);
    assert.ok(m.pickCard(first, 0).ok);
    assert.equal(m.spCardAvailable(g.cards[0], g), false, 'the page no longer offers it');
    assert.ok(!m.pickCard(second, 0).ok, 'and a teammate cannot take it');
    assert.equal(m.sp.picks[second.playerId], undefined);
    assert.equal(g.taken[0], first.playerId, 'taken names its one holder');
    checkInvariants(m);
  } finally { h.m.dispose(); resetMatchRules(); }
});

test('modded behaviour: two players of one group may hold the same card', () => {
  resetMatchRules();
  setMatchRules({ choiceDuplicates: true });
  const h = draftMatch();
  try {
    const m = h.m;
    const { g, first, second } = twoPickers(m);
    assert.ok(m.pickCard(first, 0).ok);
    assert.equal(m.spCardAvailable(g.cards[0], g), true, 'the card stays on offer');
    assert.ok(m.pickCard(second, 0).ok, 'the teammate takes the same card');
    assert.equal(m.sp.picks[first.playerId], 0);
    assert.equal(m.sp.picks[second.playerId], 0);
    assert.equal(g.taken[0], first.playerId, 'the wire shape is unchanged: taken names the FIRST holder');
    assert.equal(g.picks[second.playerId], 0);
    // The client is told, or it would grey the card out and the mod would be unusable from the UI.
    assert.equal(m.publicView().sp.allowDuplicates, true);
    // The audit reads the same rule, so the repository's own verification accepts a modded match.
    checkInvariants(m);
  } finally { h.m.dispose(); resetMatchRules(); }
});

test('the rule is what the shipped mod sets, loaded through the real mod loader', async () => {
  resetMatchRules();
  const scan = scanMods(path.join(ROOT, 'mods'));
  assert.deepEqual(scan.skipped, [], 'every shipped mod has a valid manifest');
  assert.ok(scan.mods.some((m) => m.id === 'dup-strategies'));
  const runtime = await loadMods(scan.mods, { enabled: ['dup-strategies'], log: silent });
  try {
    assert.deepEqual(runtime.failed, []);
    assert.deepEqual(runtime.loaded.map((m) => m.id), ['dup-strategies']);
    assert.equal(matchRules().choiceDuplicates, true, 'the mod flipped the rule through its own setup(ctx)');
  } finally { resetMatchRules(); }

  // Nothing loaded (owner disabled it) => the shipped rule stays.
  const off = await loadMods(scan.mods, { enabled: [], log: silent });
  assert.deepEqual(off.loaded, []);
  assert.equal(matchRules().choiceDuplicates, false);
});

test('the rule object validates its input and resets to the shipped behaviour', () => {
  resetMatchRules();
  assert.deepEqual(setMatchRules({ choiceDuplicates: 'yes' }).rejected, ['choiceDuplicates']);
  assert.deepEqual(setMatchRules({ nope: true }).rejected, ['nope']);
  assert.equal(matchRules().choiceDuplicates, MATCH_RULE_DEFAULTS.choiceDuplicates);
  setMatchRules({ choiceDuplicates: true });
  resetMatchRules();
  assert.equal(matchRules().choiceDuplicates, MATCH_RULE_DEFAULTS.choiceDuplicates);
});
