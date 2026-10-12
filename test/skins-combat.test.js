// 干员皮肤 in battle (docs/SKINS.md): the skin a player picks must reach the battlefield — and where it cannot, the
// picker must say so instead of pretending.
//
// Player report: "the skin shows in the prep screen but disappears once the battle starts". The plumbing turned out to be
// intact: the asset set carries models for 172 of the 271 catalogue skins, and the remaining 99 are avatar-only (they
// change the 180×180 portrait and the detail card, while the board and the battle keep the operator's own model, because
// assets.js spineEntry falls back to it). What WAS wrong is the picker: it reported every one of the 271 as "installed",
// so nothing distinguished a skin that changes the battlefield from one that cannot. These tests pin both halves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBattleSpec, createBattleFromSpec, sanitizeUnitLoadout } from '../server/sim/spec.js';
import { loadData, DATA_FILES } from '../server/data.js';
import { createPackRegistry } from '../server/packs.js';
import { applyDataPacks } from '../server/dataPacks.js';
import { serveDirs } from '../server/http/config.js';
import { GEO } from '../shared/constants.js';
import { spineEntry } from '../public/js/assets.js';
import { renderInfo } from '../public/js/render/app/info.js';
import { data } from '../public/js/data.js';
import { availableSkins, hasBattleModel } from '../public/js/ui/skins.js';
import { makeMatch, give, legalTileFor, DATA } from './match/harness.js';

// The skins' CONTENT is a data pack now (packs/stronghold-skins/, docs/SKINS.md): the base tables carry no skins, and the
// server applies the shipped packs at boot. So this test reads what the server really serves — base data with the packs
// applied — which also means it fails if the pack were dropped, instead of quietly testing an empty catalogue.
const DIRS = serveDirs({});
const silent = { info() {}, warn() {}, error() {} };
const packs = createPackRegistry(DIRS, { log: silent });
const applied = applyDataPacks(loadData(DIRS.dataDir, { log: silent }), packs.list('data'), { log: silent, known: DATA_FILES });
const assets = applied.tables.assets;
const catalogue = applied.tables.skins;
const chessData = applied.tables.chess;

/** A chess, its operator, and one of that operator's skins that HAS its own battle model. */
function modelledPick() {
  for (const [chessId, rec] of Object.entries(chessData)) {
    const hit = (catalogue.chars?.[rec.charId] || []).find((s) => assets.chars?.[rec.charId]?.skins?.[s.id]?.spine);
    if (hit) return { chessId, baseId: rec.baseId || chessId, charId: rec.charId, skinId: hit.id };
  }
  throw new Error('no chess in data/chess.json has a skin with a battle model');
}

/** The same, for an operator whose every skin is avatar-only. */
function avatarOnlyPick() {
  for (const [charId, list] of Object.entries(catalogue.chars || {})) {
    if (!list.length) continue;
    if (list.every((s) => !assets.chars?.[charId]?.skins?.[s.id]?.spine)) return { charId, skinId: list[0].id };
  }
  throw new Error('the catalogue has no avatar-only operator');
}

/**
 * Put one chess of a human player on its board with a skin selected, and hand back the battle input.
 * `makeMatch` returns the harness (its `.m` is the Match) and does not start the match: a board can only be placed on
 * once the match reached a prep phase and the stage exists (`legalTileFor` needs the deploy map).
 */
function battleInputWithSkin(pick) {
  const h = makeMatch({ humans: 1, bots: 0 });
  h.start();
  h.toPrep(1);
  const m = h.m;
  const ps = h.ps('p_0');
  const tile = legalTileFor(m, ps, pick.chessId);
  assert.ok(tile, `no legal board tile for ${pick.chessId}`);
  give(m, ps, pick.chessId, 'board', tile);
  m.setSkins(ps.playerId, { [pick.baseId]: pick.skinId });
  assert.equal(ps.skinOf(m.gd.chess(pick.chessId), pick.chessId), pick.skinId, 'the match did not keep the skin');
  const input = ps.battleInput({ side: 'L', colOffset: 0 });
  const unit = input.units.find((u) => u.kind === 'chess');
  assert.ok(unit, 'the piece did not reach the battle input');
  return { h, m, ps, input, unit };
}

test('the skin a player picks on a piece reaches the battle input', () => {
  const pick = modelledPick();
  const { unit } = battleInputWithSkin(pick);
  assert.equal(unit.skin, pick.skinId);
});

test('the battle input skin survives the spec round trip (where a field whitelist would drop it)', () => {
  const pick = modelledPick();
  const { input } = battleInputWithSkin(pick);
  const spec = buildBattleSpec({ players: [input] });
  const unit = spec.players[0].units.find((u) => u.kind === 'chess');
  assert.equal(unit.skin, pick.skinId, 'buildBattleSpec dropped the skin');

  // sanitizeUnitLoadout is the one place that deletes fields (it strips a token's loadout); it must never touch `skin`.
  const chess = { uid: 1, kind: 'chess', chessId: 'chess_char_1_01_a', skin: pick.skinId };
  const token = { uid: 2, kind: 'token', tokenId: 'token_x', skin: pick.skinId, skillIndex: 3 };
  sanitizeUnitLoadout(chess);
  sanitizeUnitLoadout(token);
  assert.equal(chess.skin, pick.skinId);
  assert.equal(token.skin, pick.skinId, 'a token carries no skin, but the sanitiser must not be the reason');
});

test('the simulation carries it into the unit info the client renders, down to the skin’s own model', () => {
  const pick = modelledPick();
  const { m, input } = battleInputWithSkin(pick);
  const spec = buildBattleSpec({
    battleId: 'skins.test.1', fieldId: 'n:p_0', kind: 'normal', seed: 1, modeId: m.modeId, round: 1,
    stageId: m.stageId, rect: { ...GEO.NORMAL_RECT }, timeLimit: 60, players: [input], spawns: [], routes: [], flags: {},
  });
  const battle = createBattleFromSpec(spec, DATA, { quiet: true, recordEvents: false });
  try {
    // fieldMeta() only lists units that have actually deployed (alive && deployed && !hidden), so step the battle until
    // the operator is on the field — reading it at t=0 reports an empty field.
    let meta = battle.fieldMeta();
    for (let i = 0; i < 600 && !meta.units.some((u) => u.side === 'ally'); i++) {
      battle.step();
      meta = battle.fieldMeta();
    }
    const ally = meta.units.find((u) => u.side === 'ally');
    assert.ok(ally, 'the field meta has no ally unit after stepping the battle');
    assert.equal(ally.kind, 'op');
    assert.equal(ally.skin, pick.skinId, 'm.field lost the skin — the battlefield would draw the operator');

    // the client's conversion, then the model the view asks for
    const info = renderInfo(ally);
    assert.equal(info.skin, pick.skinId, 'renderInfo dropped the skin');
    const entry = spineEntry(assets, info.spine, { back: false, skin: info.skin });
    const own = assets.chars[pick.charId].skins[pick.skinId].spine.front;
    assert.equal(entry.skel, own.skel, 'the battle resolved the operator’s model, not the skin’s');
    assert.ok(entry.fallback && entry.fallback.skel, 'a skin entry keeps the operator’s model as its fallback');
  } finally { battle.dispose?.(); }
});

test('an avatar-only skin keeps the operator’s model in battle (that is the documented fallback)', () => {
  const pick = avatarOnlyPick();
  const entry = spineEntry(assets, pick.charId, { skin: pick.skinId });
  assert.ok(entry, 'the operator still needs a model of its own');
  assert.equal(entry.skel, assets.chars[pick.charId].spine.front.skel);
  // and it does bring its own portrait — that is what makes it worth offering at all
  assert.ok(assets.chars[pick.charId].skins[pick.skinId].avatar, 'an avatar-only skin still has its avatar');
});

test('the picker marks exactly the skins that cannot change the battlefield', async () => {
  // Load the manifests into the client data store the way the browser does — over HTTP, from what the server serves.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const name = String(url).split('/').pop().replace(/\.json$/, '');
    const table = applied.tables[name];
    if (!table) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => table };
  };
  try {
    await data.load('skins');
    await data.load('assets');
  } finally { globalThis.fetch = realFetch; }

  let withModel = 0;
  let avatarOnly = 0;
  for (const [charId, list] of Object.entries(catalogue.chars || {})) {
    const offered = availableSkins(charId);
    assert.equal(offered.length, list.length, `${charId}: the picker offers ${offered.length} of ${list.length} skins`);
    for (const skin of offered) {
      const declared = !!assets.chars?.[charId]?.skins?.[skin.id]?.spine;
      assert.equal(skin.battle, declared, `${charId}/${skin.id}: the picker says battle=${skin.battle}, the manifest says ${declared}`);
      assert.equal(hasBattleModel(charId, skin.id), declared);
      assert.equal(skin.installed, true, 'these skins all have their art');
      declared ? withModel++ : avatarOnly++;
    }
  }
  // Both kinds must exist, or this test would pass on a catalogue where the distinction is meaningless.
  assert.ok(withModel > 0, 'no skin has a battle model');
  assert.ok(avatarOnly > 0, 'every skin has a battle model — the picker mark would be dead code');
  assert.equal(withModel + avatarOnly, Object.values(catalogue.chars).reduce((n, l) => n + l.length, 0));
});
