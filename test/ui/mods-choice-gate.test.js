// 同策略可复选 — the CLIENT half of mods/dup-strategies (docs/MODS.md).
//
// The server side of the rule is covered in test/match/mods-dup-strategies.test.js. This file covers what the browser does
// with it: the view field the server adds must survive normalisation, and the pick gate must stop treating another player's
// card as unavailable — otherwise the server would accept a pick the UI never offers.
const { normalizeSp } = await import('../../public/js/ui/gameLogic.js');
const { cardPickable } = await import('../../public/js/ui/choiceOverlay.js');
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;

const PLAYERS = [{ playerId: 'a', seat: 0, name: 'A' }, { playerId: 'b', seat: 1, name: 'B' }];

/** A tactic page where 'a' already took card 0 and it is 'b''s turn. */
const page = (extra = {}) => ({
  family: 'tactic', name: '战术决策', desc: '',
  cards: [{ idx: 0, kind: 'tactic', id: 't1', name: 'T1' }, { idx: 1, kind: 'tactic', id: 't2', name: 'T2' }],
  order: ['a', 'b'], turn: 'b', picks: { a: 0 }, taken: { 0: 'a' },
  ...extra,
});

test('shipped behaviour: the client refuses a card another player already holds', () => {
  const sp = normalizeSp(page(), PLAYERS, 'b');
  assert.equal(sp.allowDuplicates, false, 'a view without the field keeps the shipped rule');
  assert.equal(sp.cards[0].takenBy, 'a', 'it is still shown as taken');
  assert.equal(cardPickable(sp, sp.cards[0], { myId: 'b', solo: false }), false);
  assert.equal(cardPickable(sp, sp.cards[1], { myId: 'b', solo: false }), true, 'a free card stays pickable');
});

test('mod rule: the client offers the same card, still showing who took it first', () => {
  const sp = normalizeSp(page({ allowDuplicates: true }), PLAYERS, 'b');
  assert.equal(sp.allowDuplicates, true, 'the server field survives normalisation');
  assert.equal(sp.cards[0].takenBy, 'a', 'the first holder is still visible');
  assert.equal(cardPickable(sp, sp.cards[0], { myId: 'b', solo: false }), true, 'and the card can be picked');
  // the rest of the gate is untouched: not my turn, already picked, or busy still refuses
  assert.equal(cardPickable(sp, sp.cards[0], { myId: 'a', solo: false }), false, 'not my turn');
  assert.equal(cardPickable(sp, sp.cards[0], { myId: 'b', solo: false, busyIdx: 0 }), false, 'a pick in flight');
  const picked = normalizeSp(page({ allowDuplicates: true, picks: { a: 0, b: 1 } }), PLAYERS, 'b');
  assert.equal(cardPickable(picked, picked.cards[0], { myId: 'b', solo: false }), false, 'I already picked');
});
