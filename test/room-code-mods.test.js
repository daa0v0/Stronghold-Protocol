// The per-room code-mod choice, end to end through the LOBBY (docs/MODS.md §4.6): what the room frame says, what the host may
// change, what reaches the match, and what the server refuses. A tiny MatchClass stands in for the real one, because what is
// under test is the plumbing (the room's pick → `new Match({ codeMods })` → `Match.modEnabled`), not a battle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { ERR } from '../shared/constants.js';

/** Enabled code mods, as `server/index.js` builds them from the mod report. */
const ENABLED = [
  { id: 'dup-strategies', name: '开局策略可复选', englishName: 'Duplicate picks', description: '同组可重复', version: '1.1.0' },
  { id: 'revive-teammate', name: '淘汰当场复活', description: '扣 10 血救回', version: '2.0.0' },
];

/** The bits of Match the lobby touches, with the opts it was constructed with kept for the assertions. */
class HeldMatch {
  constructor(opts) { this.opts = opts; this.codeMods = opts && opts.codeMods !== undefined ? opts.codeMods : null; }
  /** The same rule the real Match uses: no narrowing runs every enabled mod. */
  modEnabled(id) { return this.codeMods == null ? true : this.codeMods.includes(id); }
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
