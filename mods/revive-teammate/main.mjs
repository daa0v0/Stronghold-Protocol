// mods/revive-teammate/main.mjs — 扣自己 10 血复活一名队友 (docs/MODS.md).
//
// Two halves, on purpose:
//   * the CARD (`card.json` → the data pack `packs/revive-teammate/`) is data: a new 战术决策 entry the draft draws and the
//     client renders like every other card. A pack cannot make it DO anything, and must not;
//   * the EFFECT is code: this mod registers `choice:<effectId>` for it (shared/modContent.js), which replaces the generic
//     tactic handler for that id. That is the only supported way for a mod to add behaviour — an ES module's exports cannot
//     be patched from outside.
//
// `config.json` is the owner's switch (and the tuning): cost, and how much health the teammate returns with.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerModContent } from '../../shared/modContent.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = { effectId: 'revive_ally', cost: 10, reviveLp: 'band' };

const readJson = (file, fallback) => {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(path.join(HERE, file), 'utf8')) }; }
  catch { return fallback; }
};

/**
 * The card's effect. Runs once, for the picker (`team: false` in card.json), during the 机变 draft.
 * @param {{ effectId: string, cost: number, reviveLp: unknown }} config
 */
function handlerFor(config) {
  return {
    onChoicePick(ctx, ev) {
      if (!ctx || ctx.source?.kind !== 'choice' || !ev || !ev.card || ev.card.id !== config.effectId) return;
      const m = ctx.match;
      // `ctx.player` is the shipped accessor for ANOTHER player's context, not this hook's player: take the state by id.
      const ps = m?.players?.get?.(ctx.playerId);
      if (!m || !ps) { ctx.log?.('缺少 match/player 上下文，跳过'); return; }
      const cost = Number(config.cost);
      if (!Number.isFinite(cost) || cost <= 0) { ctx.log?.(`代价配置无效：${config.cost}`); return; }
      const candidates = m.revivableTeammates?.() || [];
      if (!candidates.length) { ctx.log?.('没有已被淘汰的队友，什么也没有发生'); return; }
      if (!(ps.lp > cost)) { ctx.log?.(`血量不足：需要 ${cost}，当前 ${ps.lp}`); return; }
      const target = candidates[0];
      const reviveLp = config.reviveLp === 'band' ? null : Number(config.reviveLp);
      const res = m.revivePlayer(target.playerId, Number.isFinite(reviveLp) ? { lp: reviveLp } : {});
      if (!res || !res.ok) { ctx.log?.(`复活失败：${res && res.error}`); return; }
      // The cost, paid after the revive succeeded — never charge for a revive that could not happen.
      ps.lp = Math.max(1, ps.lp - cost);
      ps.dirty?.();
      m.markPrivate(ps);
      m.markPublic();
      ctx.log?.(`复活了 ${target.name || target.playerId}（消耗 ${cost} 点血量，剩余 ${ps.lp}，对方以 ${res.lp} 点血量回到战场）`);
    },
  };
}

/** @param {{ id: string, version: string, log: { info: Function, warn: Function } }} ctx */
export async function setup(ctx) {
  const config = readJson('config.json', DEFAULTS);
  registerModContent({
    name: 'revive-teammate',
    registerMeta(registry) { registry.choice(config.effectId, handlerFor(config)); },
  });
  ctx.log.info(`已注册机变卡效果 choice:${config.effectId}：消耗自己 ${config.cost} 点血量复活一名队友`
    + `（复活血量：${config.reviveLp === 'band' ? '其方针的 totalHp' : config.reviveLp}）`);
}
