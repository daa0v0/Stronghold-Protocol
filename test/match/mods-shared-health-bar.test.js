// 全队共享血条 — mods/shared-health-bar (docs/MODS.md).
//
// The rule is a runtime one (`shared/matchRules.js` `sharedLp`) applied at the match's one health choke point
// (`server/match/match/lp.js`), so this file pins what that has to mean end to end: the bar's size from the drafted 方针,
// sum and max, the team moving together when one seat takes damage, an empty bar emptying for everyone, and the invariant
// audit accepting a modded match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchRules, matchRuleProviders, resetMatchRuleProviders, resetMatchRules, setMatchRules } from '../../shared/matchRules.js';
import { loadMods, scanMods } from '../../server/mods.js';
import { makeMatch, checkInvariants } from './harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const silent = { info() {}, warn() {}, error() {} };

/** A four-player co-op whose band draft is finished, i.e. the team's bar has been built. */
function drafted(opts = {}) {
  const h = makeMatch({ humans: 4, seed: 11, fake: true, ...opts });
  h.start();
  h.toPrep(1);
  return h;
}

const bands = (h) => h.m.alivePlayers().map((ps) => h.m.gd.startLp(ps.bandId));
const lps = (h) => h.m.alivePlayers().map((ps) => ps.lp);

test('shipped behaviour: every seat keeps the LP of its own band', () => {
  resetMatchRules();
  const h = drafted();
  try {
    assert.equal(h.m.sharedLp, null, 'no rule in force');
    assert.deepEqual(lps(h), bands(h), 'each seat holds its own band');
    assert.ok(new Set(lps(h)).size > 1, 'and they are not all the same');
    checkInvariants(h.m);
  } finally { h.m.dispose(); resetMatchRules(); }
});

test('sum: one bar for the team, the drafted bands added up', () => {
  resetMatchRules();
  setMatchRules({ sharedLp: { mode: 'sum', source: 'band' } });
  const h = drafted();
  try {
    const expected = bands(h).reduce((s, v) => s + v, 0);
    assert.deepEqual(lps(h), [expected, expected, expected, expected], 'every seat holds the same, larger bar');
    checkInvariants(h.m);
  } finally { h.m.dispose(); resetMatchRules(); }
});

test('max: one bar, the highest drafted band', () => {
  resetMatchRules();
  setMatchRules({ sharedLp: { mode: 'max', source: 'band' } });
  const h = drafted();
  try {
    const expected = Math.max(...bands(h));
    assert.deepEqual(lps(h), [expected, expected, expected, expected]);
    checkInvariants(h.m);
  } finally { h.m.dispose(); resetMatchRules(); }
});

test('source lp: the bar is built from the health the seats hold, not their bands', () => {
  resetMatchRules();
  // build the bar from LP values that no longer equal the bands: the rule must read ps.lp
  setMatchRules({ sharedLp: { mode: 'max', source: 'lp' } });
  const h = drafted();
  try {
    const expected = Math.max(...lps(h));
    assert.deepEqual(lps(h), [expected, expected, expected, expected]);
    assert.ok(expected <= Math.max(...bands(h)), 'never above the highest band');
    checkInvariants(h.m);
  } finally { h.m.dispose(); resetMatchRules(); }
});

test('the team takes damage together, and an empty bar is empty for everyone', () => {
  resetMatchRules();
  setMatchRules({ sharedLp: { mode: 'sum', source: 'band' } });
  const h = drafted();
  try {
    const m = h.m;
    const size = m.alivePlayers()[0].lp;
    const [a, b] = m.alivePlayers();
    m.loseLp(a, 7);
    assert.deepEqual(lps(h), [size - 7, size - 7, size - 7, size - 7], 'both seats dropped together');
    assert.equal(b.lp, size - 7, 'the teammate who took no damage lost the health too — it is one bar');
    m.applyLp(a, 0);
    assert.deepEqual(lps(h), [0, 0, 0, 0], 'an empty bar is empty for everyone');
    checkInvariants(m);
  } finally { h.m.dispose(); resetMatchRules(); }
});

test('the rule comes from the shipped mod, per match, loaded through the real mod loader', async () => {
  resetMatchRuleProviders();
  const scan = scanMods(path.join(ROOT, 'mods'));
  assert.deepEqual(scan.skipped, []);
  const runtime = await loadMods(scan.mods, { enabled: ['shared-health-bar'], log: silent });
  try {
    assert.deepEqual(runtime.failed, []);
    assert.deepEqual(runtime.loaded.map((m) => m.id), ['shared-health-bar']);
    assert.ok(matchRuleProviders().includes('shared-health-bar'), 'the mod registered a per-match rule provider');

    // The room picked it: the mod's own config.json decides the bar.
    const on = drafted({ codeMods: ['shared-health-bar'] });
    try {
      assert.deepEqual(on.m.rules.sharedLp, { mode: 'sum', source: 'band' }, 'this match runs the mod');
      assert.deepEqual(lps(on), [lps(on)[0], lps(on)[0], lps(on)[0], lps(on)[0]], 'and the team shares one bar');
      checkInvariants(on.m);
    } finally { on.m.dispose(); }

    // The room left it out: the shipped per-seat health, even though the mod is loaded server-wide.
    const off = drafted({ codeMods: [] });
    try {
      assert.equal(off.m.modEnabled('shared-health-bar'), false);
      assert.equal(off.m.rules.sharedLp, null, 'this match does not run the mod');
      assert.deepEqual(lps(off), bands(off), 'each seat holds its own band');
      checkInvariants(off.m);
    } finally { off.m.dispose(); }
  } finally { resetMatchRuleProviders(); }
});

test('the rule validates its input and resets to the shipped behaviour', () => {
  resetMatchRules();
  assert.equal(matchRules().sharedLp, null);
  assert.deepEqual(setMatchRules({ sharedLp: { mode: 'nope', source: 'band' } }).rejected, ['sharedLp']);
  assert.deepEqual(setMatchRules({ sharedLp: { mode: 'sum', source: 'nope' } }).rejected, ['sharedLp']);
  assert.deepEqual(setMatchRules({ sharedLp: { mode: 'max' } }).applied, ['sharedLp']);
  assert.deepEqual(matchRules().sharedLp, { mode: 'max', source: 'band' }, 'source defaults to the drafted bands');
  assert.deepEqual(setMatchRules({ sharedLp: null }).applied, ['sharedLp']);
  assert.equal(matchRules().sharedLp, null);
});

test('the invariant audit knows the rule: it accepts a shared bar and still checks its size', () => {
  resetMatchRules();
  setMatchRules({ sharedLp: { mode: 'sum', source: 'band' } });
  const h = drafted();
  try {
    const m = h.m;
    // The bands check runs as the draft ends (audit.js wraps `enterBattleCheck`), inside drafted(): reaching here at all
    // means the audit read the rule instead of demanding each seat's own totalHp.
    assert.deepEqual(m.sharedLpSize(m.alivePlayers()), m.alivePlayers()[0].lp, 'the audit helper agrees with the applied bar');
    assert.equal(m.teamLp, null, 'and the shipped merged pool is a different thing entirely');
    checkInvariants(m);
  } finally { h.m.dispose(); resetMatchRules(); }
});

test('the room picks the two knobs per match, above the mod own config.json', async () => {
  resetMatchRuleProviders();
  const scan = scanMods(path.join(ROOT, 'mods'));
  const runtime = await loadMods(scan.mods, { enabled: ['shared-health-bar'], log: silent });
  try {
    assert.deepEqual(runtime.failed, []);
    const mod = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, 'mods', 'shared-health-bar', rel), 'utf8'));
    assert.deepEqual(Object.keys(mod('mod.json').options).sort(), ['mode', 'source'], 'the mod declares its knobs');

    /** A four-player co-op whose bar was built with the room's own values (no room values = the mod config.json). */
    const withOptions = (codeOptions) => {
      const h = makeMatch({ humans: 4, seed: 11, fake: true, codeMods: ['shared-health-bar'], codeOptions }).start();
      h.toPrep(1);
      return h;
    };
    const cfg = mod('config.json');
    const def = withOptions(undefined);
    try {
      assert.deepEqual(def.m.rules.sharedLp, { mode: cfg.mode, source: cfg.source }, 'no room values: the config.json wins');
      assert.equal(def.m.alivePlayers()[0].lp, bands(def).reduce((s, v) => s + v, 0));
    } finally { def.m.dispose(); }

    const max = withOptions({ 'shared-health-bar': { mode: 'max' } });
    try {
      assert.deepEqual(max.m.rules.sharedLp, { mode: 'max', source: cfg.source }, 'the room overrides one knob');
      assert.equal(max.m.alivePlayers()[0].lp, Math.max(...bands(max)), 'the bar is the highest band');
      assert.deepEqual(lps(max), [lps(max)[0], lps(max)[0], lps(max)[0], lps(max)[0]]);
      checkInvariants(max.m);
    } finally { max.m.dispose(); }

    const lp = withOptions({ 'shared-health-bar': { mode: 'sum', source: 'lp' } });
    try {
      assert.deepEqual(lp.m.rules.sharedLp, { mode: 'sum', source: 'lp' });
      checkInvariants(lp.m);
    } finally { lp.m.dispose(); }
  } finally { resetMatchRuleProviders(); }
});
