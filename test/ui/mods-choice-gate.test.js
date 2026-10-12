// 开局策略可复选 — the CLIENT half of mods/dup-strategies (docs/MODS.md).
//
// The server side of the rule is covered in test/match/mods-dup-strategies.test.js. This file covers what the browser does
// with it: the view field the server adds must survive normalisation, and the strategy screen must stop marking a teammate's
// 方针 as 队友已选 — otherwise the server would accept a pick the UI never offers.
const { normalizeDraft } = await import('../../public/js/ui/gameLogic.js');
const { takenForViewer, teammateBands, autoPickBand } = await import('../../public/js/screens/bandDraft.js');
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;

const BANDS = [{ bandId: 'band_bldsk' }, { bandId: 'band_amiya' }, { bandId: 'band_duyaoy' }];
const PLAYERS = [{ playerId: 'a', seat: 0, name: 'A' }, { playerId: 'b', seat: 1, name: 'B' }];
/** A draft view where 'a' already drafted 阿米娅 and it is 'b''s turn. */
const view = (extra = {}) => ({ order: ['a', 'b'], turn: 'b', picks: { a: 'band_amiya' }, skipsLeft: {}, ...extra });

test('shipped behaviour: a teammate strategy is 队友已选 for the viewer', () => {
  const draft = normalizeDraft(view(), PLAYERS, 'b');
  assert.equal(draft.allowDuplicates, false, 'a view without the field keeps the shipped rule');
  const taken = takenForViewer(draft, 'b', false);
  assert.deepEqual([...taken.keys()], ['band_amiya'], 'the teammate strategy is taken');
  assert.equal(autoPickBand(null, { bands: BANDS, taken, defaultId: 'band_bldsk' }), 'band_bldsk', 'an auto-pick avoids it');
});

test('mod rule: nothing is taken, so the same 方针 can be selected again', () => {
  const draft = normalizeDraft(view({ allowDuplicates: true }), PLAYERS, 'b');
  assert.equal(draft.allowDuplicates, true, 'the server field survives normalisation');
  assert.deepEqual([...takenForViewer(draft, 'b', false).keys()], [], 'no strategy counts as 队友已选');
  assert.deepEqual([...teammateBands(draft.picks, 'b').keys()], ['band_amiya'], 'the display map still knows who holds it');
  assert.equal(autoPickBand(null, { bands: BANDS, taken: takenForViewer(draft, 'b', false), defaultId: 'band_bldsk' }),
    'band_bldsk', 'the automatic default is the official one, not "the first free"');
});

test('solo and an empty draft keep working', () => {
  const draft = normalizeDraft(view(), PLAYERS, 'a');
  assert.deepEqual([...takenForViewer(draft, 'a', true).keys()], [], 'solo has no teammates');
  assert.deepEqual([...takenForViewer({ picks: new Map() }, 'b', false).keys()], []);
});
