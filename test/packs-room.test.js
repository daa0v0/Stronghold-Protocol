// Per-room content packs (docs/PACKS.md §4): the host narrows the owner-enabled packs down for one match.
//
// The mechanism the owner's decisions need: a room carries its own selection (`room.create { mods }`, changeable with
// `room.setMods`) and reports it — with its own content tag — in a `room.mods` frame right after `room.state`. That frame
// is a post-v1 JSON-fallback type on purpose: the v1 position tables are frozen and a `room.state` with an extra value is
// rejected as malformed (docs/WIRE_PROTOCOL.md).
//
// What a room may drop: a pack of a type that is not live (`data`: its tables were fixed when the process started) cannot
// be dropped, and neither can something the owner disabled or that is not a pack at all — the server answers ERR.MODS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isModSelection, MOD_LIMITS } from '../shared/protocol.js';
import { contentTag } from '../shared/contentTag.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

const APP = '0.2.4';

const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sp-room-${tag}-`));
const put = (dir, rel, body) => {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};

/** A temporary packs/ folder: two live packs (assets) and one that is not live (data), plus the shipped languages. */
function packsRoot() {
  const dir = tmpdir('packs');
  for (const [id, version] of [['art', '1.0.0'], ['art2', '1.1.0']]) {
    put(dir, `${id}/pack.json`, { type: 'assets', name: id, version, files: { map: 'm.json', media: ['a.png'] } });
    put(dir, `${id}/m.json`, { [`/assets/${id}.png`]: `/packs/${id}/a.png` });
    fs.writeFileSync(path.join(dir, id, 'a.png'), Buffer.alloc(24, 2));
  }
  put(dir, 'bal/pack.json', { type: 'data', name: 'Balance', version: '2.0.0', files: { patch: 'p.json' } });
  put(dir, 'bal/p.json', { config: { balanceProbe: true } });
  return dir;
}

/** Connect, say hello and remember the player id (TestClient.hello returns the welcome frame, it does not store it). */
const connect = async (srv, name) => {
  const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  const welcome = await c.hello(name);
  c.id = welcome.playerId;
  return c;
};

test('isModSelection: a list of pack ids, no duplicates, bounded', () => {
  assert.equal(isModSelection([]), true);
  assert.equal(isModSelection(['hd-art', 'balance']), true);
  assert.equal(isModSelection(undefined), false, 'the field itself must be a list when present');
  assert.equal(isModSelection('hd-art'), false);
  assert.equal(isModSelection(['hd-art', 'hd-art']), false, 'a duplicate is a mistake, not a selection');
  assert.equal(isModSelection(['bad id!']), false);
  assert.equal(isModSelection(['x'.repeat(MOD_LIMITS.idLen + 1)]), false);
  assert.equal(isModSelection(Array.from({ length: MOD_LIMITS.entries + 1 }, (_, i) => `p${i}`)), false);
});

test('a room reports its packs and its own content tag, and cannot drop a pack that is not live', async () => {
  const packsDir = packsRoot();
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, packsDir });
  try {
    const host = await connect(srv, 'Host');
    try {
      // 1. the host drops one of the two live packs: the data pack comes back in (its tables are fixed at start)
      await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', mods: ['art', 'bal'] });
      const state = await host.waitFor('room.state');
      const mods = await host.waitFor('room.mods');
      assert.equal(mods.code, state.code, 'the mods frame says which room it is about');
      assert.deepEqual(mods.mods, ['art', 'bal'], 'exactly what the host asked for (the data pack was in it)');
      assert.deepEqual(mods.fixed, ['bal'], 'and the frame says which packs a room cannot drop');
      assert.match(mods.tag, /^c[0-9a-f]{12}$/);

      // the room's tag is the tag of ITS packs, which a client can recompute from the index
      const index = await (await fetch(`${srv.url}/packs/index.json`)).json();
      const roomPacks = index.packs.filter((p) => mods.mods.includes(p.id));
      assert.equal(contentTag(index.app, roomPacks), mods.tag, 'the client reaches the same tag for the same subset');
      assert.notEqual(mods.tag, srv.packs.content().tag, 'the room narrowed its set, so its tag differs from the server\u2019s');

      // 2. dropping the data pack is refused, with the reason
      const noData = await host.request({ t: 'room.setMods', mods: ['art'] });
      assert.equal(noData.t, 'error');
      assert.equal(noData.code, 'MODS');
      assert.match(noData.detail, /bal/);

      // 3. an unknown / disabled pack is refused too
      const unknown = await host.request({ t: 'room.setMods', mods: ['nope'] });
      assert.equal(unknown.code, 'MODS');

      // 4. only the host may change it, and the change un-readies the others
      const guest = await connect(srv, 'Guest');
      try {
        const joinReply = await guest.request({ t: 'room.join', code: state.code });
        assert.equal(joinReply.t, 'ok', `join: ${JSON.stringify(joinReply)}`);
        await guest.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === guest.id));
        await guest.waitFor('room.mods');
        const readyReply = await guest.request({ t: 'room.ready', ready: true });
        assert.equal(readyReply.t, 'ok', `ready: ${JSON.stringify(readyReply)}`);
        await guest.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === guest.id && x.ready));
        const notHost = await guest.request({ t: 'room.setMods', mods: ['art', 'bal'] });
        assert.equal(notHost.code, 'NOT_HOST');
        // the host drops one live pack: everyone is told, and the guest has to look again
        await host.request({ t: 'room.setMods', mods: ['bal'] });
        const narrowed = await host.waitFor('room.mods', (m) => m.mods.length === 1);
        assert.deepEqual(narrowed.mods, ['bal']);
        assert.deepEqual(narrowed.fixed, ['bal']);
        const guestMods = await guest.waitFor('room.mods', (m) => m.mods.length === 1);
        assert.equal(guestMods.tag, narrowed.tag);
        const guestState = await guest.waitFor('room.state');
        assert.equal(guestState.seats.find((x) => x && x.playerId === guest.id).ready, false, 'a content change asks for a new ready');
        assert.equal(contentTag(index.app, index.packs.filter((p) => p.id === 'bal')), narrowed.tag);
      } finally { await guest.close(); }
    } finally { await host.close(); }
  } finally {
    await srv.close();
    fs.rmSync(packsDir, { recursive: true, force: true });
  }
});

test('a server without packs says so: an empty selection, a fixed list, and no tag confusion', async () => {
  const packsDir = tmpdir('empty');
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, packsDir });
  try {
    const host = await connect(srv, 'Host');
    try {
      await host.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
      const mods = await host.waitFor('room.mods');
      assert.deepEqual(mods.mods, [], 'the shipped language packs are not part of a match');
      assert.deepEqual(mods.fixed, []);
      assert.equal(mods.tag, contentTag(APP, []), 'an empty set has its own tag');
      assert.equal(mods.tag, srv.packs.content().tag);
      // asking for a pack nobody has is still refused
      const bad = await host.request({ t: 'room.setMods', mods: ['ghost'] });
      assert.equal(bad.code, 'MODS');
    } finally { await host.close(); }
  } finally {
    await srv.close();
    fs.rmSync(packsDir, { recursive: true, force: true });
  }
});
