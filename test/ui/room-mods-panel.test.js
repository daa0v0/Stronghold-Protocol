// The room's own mod panel — pure helpers of the per-room choice (docs/PACKS.md §4, docs/MODS.md §4.6).
//
// What the panel shows and what it sends: only the packs a room may drop (a fixed one is always on), every code mod the
// server ENABLED (a room decides which of them its match runs), and a `room.setMods` payload that keeps the fixed packs in
// because the server refuses a list that leaves one out.
const { packRows, codeModRows, roomModsRequest, roomModsState, optionRows, setOptionValue, optionValuesFor } =
  await import('../../public/js/ui/roomMods.js');
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;

test('roomModsState: every field the panel needs survives the store copy', () => {
  const frame = {
    t: 'room.mods', code: 'AXZL', mods: ['capacity-20', 'stronghold-skins'], fixed: ['capacity-20', 'stronghold-skins'],
    choosable: [], codeMods: ['shared-health-bar'],
    codeChoices: [{ id: 'shared-health-bar', name: '全队共享血条', description: '一条血条', version: '1.0.0' }],
    tag: 'abc123',
  };
  const state = roomModsState(frame);
  assert.deepEqual(state, {
    code: 'AXZL', mods: ['capacity-20', 'stronghold-skins'], fixed: ['capacity-20', 'stronghold-skins'],
    choosable: [], codeMods: ['shared-health-bar'],
    codeChoices: [{ id: 'shared-health-bar', name: '全队共享血条', description: '一条血条', version: '1.0.0' }],
    tag: 'abc123',
  }, 'a mapper that dropped choosable/codeMods/codeChoices is what once left the room panel empty');
  // a server that sends none of them (an older one) still yields a well-formed state
  assert.deepEqual(roomModsState({ t: 'room.mods' }), {
    code: null, mods: [], fixed: [], choosable: [], codeMods: [], codeChoices: [], tag: '',
  });
  assert.deepEqual(roomModsState(null).mods, [], 'and a missing frame is not a crash');
});

const ENTRIES = [
  { id: 'stronghold-skins', name: '干员皮肤' },
  { id: 'my-pack', name: '我的包' },
];

test('packRows: only what a room may drop, with names from the index and the room current choice', () => {
  const rows = packRows(['stronghold-skins', 'my-pack'], ENTRIES, ['stronghold-skins']);
  assert.deepEqual(rows, [
    { id: 'stronghold-skins', name: '干员皮肤', on: true },
    { id: 'my-pack', name: '我的包', on: false },
  ]);
  // an id the index does not know (a pack installed since this page loaded) falls back to the id itself
  assert.deepEqual(packRows(['ghost'], ENTRIES, []), [{ id: 'ghost', name: 'ghost', on: false }]);
  assert.deepEqual(packRows([], ENTRIES, []), [], 'nothing choosable → no rows at all');
});

test('codeModRows: every enabled code mod, ticked when this room runs it', () => {
  const choices = [
    { id: 'dup-strategies', name: '开局策略可复选', description: '同组可重复' },
    { id: 'revive-teammate', name: '淘汰当场复活' },
  ];
  assert.deepEqual(codeModRows(choices, ['revive-teammate']), [
    { id: 'dup-strategies', name: '开局策略可复选', description: '同组可重复', on: false },
    { id: 'revive-teammate', name: '淘汰当场复活', description: '', on: true },
  ]);
  assert.deepEqual(codeModRows([], ['x']), [], 'a server with no enabled mod shows no rows');
});

test('roomModsRequest: explicit lists, the fixed packs kept in', () => {
  assert.deepEqual(roomModsRequest(['stronghold-skins'], ['my-pack'], ['revive-teammate']), {
    mods: ['stronghold-skins', 'my-pack'], codeMods: ['revive-teammate'],
  });
  assert.deepEqual(roomModsRequest(['stronghold-skins'], [], []), {
    mods: ['stronghold-skins'], codeMods: [],
  }, 'dropping every choosable pack still names the fixed one');
  assert.deepEqual(roomModsRequest(['a'], ['a', 'a'], ['x', 'x']), { mods: ['a'], codeMods: ['x'] }, 'no duplicates');
});

test('roomModsRequest: the room option values travel with it, and are omitted when there are none', () => {
  assert.deepEqual(roomModsRequest(['fixed'], ['p'], ['shared-health-bar'], { 'shared-health-bar': { mode: 'max' } }), {
    mods: ['fixed', 'p'], codeMods: ['shared-health-bar'], codeOptions: { 'shared-health-bar': { mode: 'max' } },
  });
  assert.deepEqual(roomModsRequest(['fixed'], [], ['m'], { m: {} }), { mods: ['fixed'], codeMods: ['m'] },
    'a mod with no values is not sent: leaving the field out would clear the room');
});

test('optionRows: the declaration, the room values, and what the host just picked', () => {
  const entry = {
    id: 'shared-health-bar', values: { mode: 'max' },
    options: [
      { key: 'mode', type: 'enum', values: ['sum', 'max'], default: 'sum', label: '血条大小', description: '相加或取最高' },
      { key: 'source', type: 'enum', values: ['band', 'lp'], default: 'band', label: '血量来源', description: '' },
      { key: 'cost', type: 'number', min: 1, max: 50, default: 10, label: '代价', description: '' },
    ],
  };
  const rows = optionRows(entry);
  assert.deepEqual(rows.map((r) => [r.key, r.value, r.set]), [
    ['mode', 'max', true],        // the room set it
    ['source', 'band', false],    // nothing set: the declared default
    ['cost', 10, false],
  ]);
  assert.equal(rows[2].min, 1);
  assert.equal(rows[0].description, '相加或取最高');
  // what the host picks in the dialog shows, and counts as set
  const changed = setOptionValue(setOptionValue({}, 'source', 'lp'), 'cost', 20);
  const after = optionRows(entry, changed);
  assert.deepEqual(after.map((r) => [r.key, r.value, r.set]), [['mode', 'max', true], ['source', 'lp', true], ['cost', 20, true]]);
  // per-mod values for the request: the room's own values, then this dialog's changes
  assert.deepEqual(optionValuesFor(entry.values, changed), { mode: 'max', source: 'lp', cost: 20 });
  assert.deepEqual(optionValuesFor({ mode: 'max' }, { mode: 'sum' }), { mode: 'sum' }, 'the dialog wins');
});
