// The per-room code-mod choice, end to end through the LOBBY (docs/MODS.md §4.6): what the room frame says, what the host may
// change, what reaches the match, and what the server refuses. A tiny MatchClass stands in for the real one, because what is
// under test is the plumbing (the room's pick → `new Match({ codeMods })` → `Match.modEnabled`), not a battle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { ERR } from '../shared/constants.js';

/** Enabled code mods, as `server/index.js` builds them from the mod report (options = the mod's own declaration). */
const ENABLED = [
  { id: 'dup-strategies', name: '开局策略可复选', englishName: 'Duplicate picks', description: '同组可重复', version: '1.1.0', options: {} },
  {
    id: 'revive-teammate', name: '淘汰当场复活', description: '扣 10 血救回', version: '2.0.0',
    options: {
      cost: { key: 'cost', type: 'number', min: 1, max: 50, default: 10, label: '代价', description: '' },
      silent: { key: 'silent', type: 'boolean', default: false, label: '静默', description: '' },
    },
  },
];

/** The bits of Match the lobby touches, with the opts it was constructed with kept for the assertions. */
class HeldMatch {
  constructor(opts) {
    this.opts = opts;
    this.codeMods = opts && opts.codeMods !== undefined ? opts.codeMods : null;
    this.codeOptions = (opts && opts.codeOptions) || {};
  }
  /** The same rule the real Match uses: no narrowing runs every enabled mod. */
  modEnabled(id) { return this.codeMods == null ? true : this.codeMods.includes(id); }
  /** Same as the real Match: the room's values for one mod, or an empty object. */
  modOptions(id) { return { ...(this.codeOptions[id] || {}) }; }
  start() {}
  dispose() {}
}

function makeLobby() {
  const registry = new SessionRegistry();
  const lobby = new Lobby({
    registry, MatchClass: HeldMatch, getData: () => ({}), seedFn: () => 7, codeMods: ENABLED,
    log: { info() {}, warn() {}, error() {} },
  });
  return { lobby, registry };
}

test('a new room runs every enabled code mod, and the frame lists them for the panel', () => {
  const { lobby, registry } = makeLobby();
  const s = registry.create('房主');
  assert.deepEqual(lobby.create(s, { mode: 'coop', difficulty: 'HARD' }), { ok: true });
  const room = lobby.roomOf(s);
  assert.deepEqual(room.codeMods, ['dup-strategies', 'revive-teammate'], 'everything the owner enabled');
  const frame = lobby.modsFrame(room);
  assert.deepEqual(frame.codeMods, room.codeMods);
  assert.deepEqual(frame.codeChoices.map((m) => m.id), ['dup-strategies', 'revive-teammate']);
  assert.equal(frame.codeChoices[0].name, '开局策略可复选', 'the panel can show a name and a description');
  assert.equal(frame.codeChoices[0].description, '同组可重复');
  assert.equal(lobby.modsLogLine(room), 'none', 'a room that chose nothing in particular says nothing in the log');
});

test('the host narrows the code mods, and the choice reaches the match', () => {
  const { lobby, registry } = makeLobby();
  const s = registry.create('房主');
  lobby.create(s, { mode: 'coop', difficulty: 'HARD' });
  const room = lobby.roomOf(s);
  assert.deepEqual(lobby.setMods(s, { mods: [], codeMods: ['revive-teammate'] }), { ok: true });
  assert.deepEqual(room.codeMods, ['revive-teammate']);
  assert.equal(lobby.modsLogLine(room), 'code:revive-teammate');
  // the room's own pick is what the match is built with
  const match = new HeldMatch({ codeMods: room.codeMods.slice() });
  assert.equal(match.modEnabled('revive-teammate'), true);
  assert.equal(match.modEnabled('dup-strategies'), false, 'a mod the room left out is off for this match');
});

test('a room may drop every code mod, and a mod the owner did not enable cannot be named', () => {
  const { lobby, registry } = makeLobby();
  const s = registry.create('房主');
  lobby.create(s, { mode: 'coop', difficulty: 'HARD' });
  const room = lobby.roomOf(s);
  assert.deepEqual(lobby.setMods(s, { codeMods: [] }), { ok: true });
  assert.deepEqual(room.codeMods, [], 'a room can run none of them');
  assert.equal(lobby.modsLogLine(room), 'code:none');
  const refused = lobby.setMods(s, { codeMods: ['shared-health-bar'] });
  assert.equal(refused.error, ERR.MODS, 'a mod this server did not enable is refused, not silently dropped');
  assert.equal(refused.detail.includes('shared-health-bar'), true);
  assert.deepEqual(room.codeMods, [], 'and the refusal changed nothing');
});

test('only the host may change it, and not once the match started', () => {
  const { lobby, registry } = makeLobby();
  const host = registry.create('房主');
  const guest = registry.create('队友');
  lobby.create(host, { mode: 'coop', difficulty: 'HARD' });
  assert.deepEqual(lobby.join(guest, { code: lobby.roomOf(host).code }), { ok: true });
  assert.equal(lobby.setMods(guest, { codeMods: [] }).error, ERR.NOT_HOST);
  const room = lobby.roomOf(host);
  room.match = {};   // as if the match had started
  assert.equal(lobby.setMods(host, { codeMods: [] }).error, ERR.ROOM_STARTED);
});

test('a room sets a mod option, the frame offers the declaration, and the match receives the values', () => {
  const { lobby, registry } = makeLobby();
  const s = registry.create('房主');
  lobby.create(s, { mode: 'coop', difficulty: 'HARD' });
  const room = lobby.roomOf(s);
  assert.deepEqual(room.codeModOptions, {}, 'nothing set yet: each mod uses its own config.json');
  assert.deepEqual(lobby.setMods(s, { codeOptions: { 'revive-teammate': { cost: 20, silent: true } } }), { ok: true });
  assert.deepEqual(room.codeModOptions, { 'revive-teammate': { cost: 20, silent: true } });
  const frame = lobby.modsFrame(room);
  const rows = frame.codeOptions.find((m) => m.id === 'revive-teammate');
  assert.deepEqual(rows.values, { cost: 20, silent: true });
  assert.deepEqual(rows.options.map((o) => o.key).sort(), ['cost', 'silent'], 'the panel renders the declaration');
  assert.equal(rows.options.find((o) => o.key === 'cost').max, 50);
  // and this is what the match hands the mod
  const match = new HeldMatch({ codeMods: room.codeMods.slice(), codeOptions: room.codeModOptions });
  assert.deepEqual(match.modOptions('revive-teammate'), { cost: 20, silent: true });
  assert.deepEqual(match.modOptions('dup-strategies'), {}, 'a mod without values gets an empty object, not undefined');
});

test('an option a mod did not declare, or a value that does not fit it, is refused', () => {
  const { lobby, registry } = makeLobby();
  const s = registry.create('房主');
  lobby.create(s, { mode: 'coop', difficulty: 'HARD' });
  const room = lobby.roomOf(s);
  // a mod the owner enabled but this room left out may not carry values (note `codeMods` is sent explicitly: leaving the
  // field out means "every enabled one", which would put the mod back in the room)
  assert.equal(lobby.setMods(s, { codeMods: ['dup-strategies'], codeOptions: { 'revive-teammate': { cost: 5 } } }).error, ERR.MODS);
  assert.deepEqual(lobby.setMods(s, { codeMods: ['revive-teammate'] }), { ok: true });
  const cases = [
    [{ 'revive-teammate': { nope: 1 } }, 'not a declared option'],
    [{ 'revive-teammate': { cost: 0 } }, 'below min'],
    [{ 'revive-teammate': { cost: 51 } }, 'above max'],
    [{ 'revive-teammate': { cost: 'cheap' } }, 'wrong type'],
    [{ 'revive-teammate': { silent: 'yes' } }, 'boolean must be a boolean'],
    [{ 'not-a-mod': { x: 1 } }, 'a mod this server did not enable'],
  ];
  for (const [options, why] of cases) {
    const res = lobby.setMods(s, { codeMods: ['revive-teammate'], codeOptions: options });
    assert.equal(res.error, ERR.MODS, why);
    assert.equal(typeof res.detail, 'string');
  }
  assert.deepEqual(room.codeModOptions, {}, 'none of the refusals changed the room');
  assert.deepEqual(room.codeMods, ['revive-teammate'], 'and neither did they change which mods it runs');
});
