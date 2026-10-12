// 开局策略可复选 — mods/dup-strategies (docs/MODS.md).
//
// The rule is a runtime one (`shared/matchRules.js` `bandDuplicates`) read by `Match.bandTaken`, which is the single gate the
// whole strategy draft goes through: `pickBand`'s 队友已选 refusal, the bot's re-draw, `_applyBand`'s dedupe, the timeout and
// departing-seat assignments, and the invariant audit's uniqueness assertion. This file pins both sides of it with a real
// co-op match, plus that the shipped mod is what flips it (through the real loader, not by calling the setter by hand).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERR, PHASE } from '../../shared/constants.js';
import { MATCH_RULE_DEFAULTS, matchRules, resetMatchRules, setMatchRules } from '../../shared/matchRules.js';
import { loadMods, scanMods } from '../../server/mods.js';
import { makeMatch, checkInvariants } from './harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const silent = { info() {}, warn() {}, error() {} };
/** 阿米娅 — one of the 开局策略 the user named (芬 = band_bldsk, 变形者集群 = band_duyaoy). */
const SHARED = 'band_amiya';

/** A three-player co-op sitting in the strategy (方针) draft. */
function bandDraft(seed = 5) {
  const h = makeMatch({ mode: 'coop', humans: 3, seed }).start();
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

test('shipped behaviour: a strategy a teammate drafted is 队友已选', () => {
  resetMatchRules();
  const h = bandDraft();
  try {
    const m = h.m;
    assert.equal(matchRules().bandDuplicates, false);
    const first = pickForCurrent(h, SHARED);
    assert.deepEqual(first.res, { ok: true });
    const second = pickForCurrent(h, SHARED);
    assert.equal(second.res.error, ERR.BAD_TARGET, '队友已选: no duplicates');
    assert.equal(m.bandTaken(SHARED, second.pid), true);
    assert.equal(m.publicView().draft.allowDuplicates, false, 'and the client is told to keep it 队友已选');
    checkInvariants(m);
  } finally { h.m.dispose(); resetMatchRules(); }
});

test('modded behaviour: two players of one group may draft the same 方针', () => {
  resetMatchRules();
  setMatchRules({ bandDuplicates: true });
  const h = bandDraft();
  try {
    const m = h.m;
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
  } finally { h.m.dispose(); resetMatchRules(); }
});

test('the automatic assignments stop avoiding a taken strategy too', () => {
  resetMatchRules();
  setMatchRules({ bandDuplicates: true });
  const h = bandDraft();
  try {
    const m = h.m;
    const timeout = m.gd.bandDraft.timeoutBandId;
    pickForCurrent(h, timeout);
    assert.equal(m.bandTaken(timeout, 'p_2'), false);
    assert.equal(m.defaultBand('p_2'), timeout, 'a timed-out turn keeps the official default');
    checkInvariants(m);
  } finally { h.m.dispose(); resetMatchRules(); }
});

test('the rule is what the shipped mod sets, loaded through the real mod loader', async () => {
  resetMatchRules();
  const scan = scanMods(path.join(ROOT, 'mods'));
  assert.deepEqual(scan.skipped, []);
  assert.ok(scan.mods.some((m) => m.id === 'dup-strategies'));
  const runtime = await loadMods(scan.mods, { enabled: ['dup-strategies'], log: silent });
  try {
    assert.deepEqual(runtime.failed, []);
    assert.deepEqual(runtime.loaded.map((m) => m.id), ['dup-strategies']);
    assert.equal(matchRules().bandDuplicates, true, 'the mod set the rule from its own config.json');
  } finally { resetMatchRules(); }

  const off = await loadMods(scan.mods, { enabled: [], log: silent });
  assert.deepEqual(off.loaded, []);
  assert.equal(matchRules().bandDuplicates, false);
});

test('the rule validates its input and resets to the shipped behaviour', () => {
  resetMatchRules();
  assert.deepEqual(setMatchRules({ bandDuplicates: 'yes' }).rejected, ['bandDuplicates']);
  assert.deepEqual(setMatchRules({ nope: true }).rejected, ['nope']);
  assert.equal(matchRules().bandDuplicates, MATCH_RULE_DEFAULTS.bandDuplicates);
  setMatchRules({ bandDuplicates: true });
  resetMatchRules();
  assert.equal(matchRules().bandDuplicates, MATCH_RULE_DEFAULTS.bandDuplicates);
});
