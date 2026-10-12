// 开局策略可复选 — mods/dup-strategies (docs/MODS.md).
//
// The rule is per MATCH (`Match.rules.bandDuplicates`, resolved from the mod's own provider): a room that picks the mod gets
// it, a room that does not plays the shipped draft. `Match.bandTaken` is the single gate the whole draft goes through, so the
// refusal, the bot's re-draw, `_applyBand`'s dedupe, the automatic assignments and the invariant audit all follow one value.
// This file pins both rooms, and that the shipped mod is what registers the provider (through the real loader).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERR, PHASE } from '../../shared/constants.js';
import { MATCH_RULE_DEFAULTS, matchRuleProviders, resetMatchRuleProviders, setMatchRules } from '../../shared/matchRules.js';
import { loadMods, scanMods } from '../../server/mods.js';
import { makeMatch, checkInvariants } from './harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const silent = { info() {}, warn() {}, error() {} };
const MOD_ID = 'dup-strategies';
/** 阿米娅 — one of the 开局策略 the user named (芬 = band_bldsk, 变形者集群 = band_duyaoy). */
const SHARED = 'band_amiya';

/** Load the shipped mod through the real loader, so its rule provider is registered for the test's matches. */
async function withMod(run) {
  resetMatchRuleProviders();
  const scan = scanMods(path.join(ROOT, 'mods'));
  const runtime = await loadMods(scan.mods, { enabled: [MOD_ID], log: silent });
  try {
    assert.deepEqual(runtime.failed, []);
    assert.ok(matchRuleProviders().includes(MOD_ID), 'the mod registered a per-match rule provider');
    await run();
  } finally { resetMatchRuleProviders(); }
}

/**
 * A three-player co-op sitting in the strategy (方针) draft.
 * @param {number} seed @param {string[]|null} codeMods the room's code-mod choice (null = it did not narrow them)
 */
function bandDraft(seed = 5, codeMods = [MOD_ID]) {
  const h = makeMatch({ mode: 'coop', humans: 3, seed, codeMods }).start();
  for (const id of ['p_0', 'p_1', 'p_2']) h.m.handle(id, { t: 'g.infoReady' });
  h.sched.advance(1);
  assert.equal(h.m.phase, PHASE.BAND_DRAFT);
  return h;
}

/** Pick `bandId` for the player whose turn it is. */
function pickForCurrent(h, bandId) {
  const pid = h.m.draftTurn();
  return { pid, res: h.m.handle(pid, { t: 'g.band', bandId }) };
}

test('a room that did not pick the mod plays the shipped draft (队友已选)', async () => {
  await withMod(() => {
    const h = bandDraft(5, []);
    try {
      const m = h.m;
      assert.equal(m.rules.bandDuplicates, false, 'the rule is off for this match, not off globally');
      const first = pickForCurrent(h, SHARED);
      assert.deepEqual(first.res, { ok: true });
      const second = pickForCurrent(h, SHARED);
      assert.equal(second.res.error, ERR.BAD_TARGET, '队友已选: no duplicates');
      assert.equal(m.bandTaken(SHARED, second.pid), true);
      assert.equal(m.publicView().draft.allowDuplicates, false, 'and the client is told to keep it 队友已选');
      checkInvariants(m);
    } finally { h.m.dispose(); }
  });
});

test('a room that picked the mod lets two players draft the same 方针', async () => {
  await withMod(() => {
    const h = bandDraft(5, [MOD_ID]);
    try {
      const m = h.m;
      assert.equal(m.rules.bandDuplicates, true);
      const first = pickForCurrent(h, SHARED);
      const second = pickForCurrent(h, SHARED);
      assert.deepEqual(first.res, { ok: true });
      assert.deepEqual(second.res, { ok: true }, 'the teammate takes the same strategy');
      assert.equal(m.draft.picks[first.pid], SHARED);
      assert.equal(m.draft.picks[second.pid], SHARED);
      assert.equal(m.bandTaken(SHARED, second.pid), false, 'nothing counts as taken');
      assert.equal(h.ps(first.pid).lp, h.ps(second.pid).lp, 'both hold that strategy, so the same LP');
      assert.equal(h.ps(first.pid).lp, m.gd.startLp(SHARED));
      assert.equal(m.publicView().draft.allowDuplicates, true, 'the client is told, or it would mark it 队友已选');
      checkInvariants(m);
    } finally { h.m.dispose(); }
  });
});

test('a room that left the choice alone runs every enabled mod', async () => {
  await withMod(() => {
    const h = bandDraft(5, null);   // codeMods null = the room did not narrow them
    try {
      const m = h.m;
      assert.equal(m.roomMods, null);
      assert.equal(m.modEnabled(MOD_ID), true);
      assert.equal(m.rules.bandDuplicates, true);
      assert.deepEqual(pickForCurrent(h, SHARED).res, { ok: true });
      assert.deepEqual(pickForCurrent(h, SHARED).res, { ok: true });
      checkInvariants(m);
    } finally { h.m.dispose(); }
  });
});

test('the automatic assignments stop avoiding a taken strategy too', async () => {
  await withMod(() => {
    const h = bandDraft(5, [MOD_ID]);
    try {
      const m = h.m;
      const timeout = m.gd.bandDraft.timeoutBandId;
      pickForCurrent(h, timeout);
      assert.equal(m.bandTaken(timeout, 'p_2'), false);
      assert.equal(m.defaultBand('p_2'), timeout, 'a timed-out turn keeps the official default');
      checkInvariants(m);
    } finally { h.m.dispose(); }
  });
});

test('the server-wide rules still exist for tests and diagnostics, and reset', () => {
  assert.deepEqual(setMatchRules({ bandDuplicates: 'yes' }).rejected, ['bandDuplicates']);
  assert.deepEqual(setMatchRules({ nope: true }).rejected, ['nope']);
  setMatchRules({ bandDuplicates: true });
  assert.equal(MATCH_RULE_DEFAULTS.bandDuplicates, false);
  resetMatchRuleProviders();
  setMatchRules({ bandDuplicates: MATCH_RULE_DEFAULTS.bandDuplicates });
});
