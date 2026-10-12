// mods/revive-teammate/main.mjs — 有人被淘汰的那一回合，队友可以花 10 点血量把他救回来（只有 1 点血）(docs/MODS.md).
//
// The shipped game has no revive: when a seat's LP runs out in a settle, `ps.eliminate()` clears it and it is out for good.
// This mod asks the survivors about it in the window that follows — right after that settle, before the next prep starts —
// and brings the teammate back with a single point of health.
//
// Both halves are core facilities a mod may use (docs/MODS.md §4.6), not new wire types:
//   * `registerModSettleHook` — the match calls it once per settle in which at least one seat went out (`shared/modChoices.js`);
//   * `registerModChoice` + `Match.offerModChoice` — the question rides the personal-choice field, the existing `g.choice`
//     message and the client's ChoiceView, so no protocol change is needed;
//   * `Match.revivePlayer` / `Match.applyLp` — the state change (alive / LP / shop / leader pool) and the one health choke
//     point, so the seats cannot drift.
//
// `config.json` is the owner's tuning: the cost in health and the health the revived seat comes back with.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerModChoice, registerModSettleHook } from '../../shared/modChoices.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = { cost: 10, reviveLp: 1 };
const CHOICE_ID = 'revive-teammate';
/** Card order in the prompt: accepting first, declining second (their `idx` is what a pick carries). */
const ACCEPT = 0;

const readJson = (file, fallback) => {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(path.join(HERE, file), 'utf8')) }; }
  catch { return fallback; }
};

/**
 * @param {{ cost: number, reviveLp: number }} config
 * @param {{ info: Function, warn: Function }} log
 */
function setupRevive(config, log) {
  const cost = Math.max(1, Math.round(Number(config.cost) || DEFAULTS.cost));
  const reviveLp = Math.max(1, Math.round(Number(config.reviveLp) || DEFAULTS.reviveLp));

  registerModChoice({
    id: CHOICE_ID,
    onPick(m, ps, { card, idx, data }) {
      const targetId = data && data.target;
      if (!targetId) return;
      if (idx !== ACCEPT) { log.info(`${ps.name} 放弃复活 ${data.name || targetId}`); return; }
      const target = m.players.get(targetId);
      if (!target || target.left) return;
      if (target.alive) { log.info(`${target.name} 已经被别人救回来了，${ps.name} 无需再付代价`); return; }
      if (!(ps.lp > cost)) { log.info(`${ps.name} 血量不足（${ps.lp} ≤ ${cost}），无法复活`); return; }
      m.applyLp(ps, ps.lp - cost);
      const res = m.revivePlayer(targetId, { lp: reviveLp });
      if (!res.ok) { log.warn(`复活 ${targetId} 失败：${res.error}`); return; }
      log.info(`${ps.name} 支付 ${cost} 点血量复活了 ${target.name}（其以 ${res.lp} 点血量回到战场）`);
      // Everyone else was asked too: their prompt is about a seat that is already back, so drop it instead of letting a
      // second teammate pay for nothing.
      for (const other of m.alivePlayers()) {
        if (other === ps) continue;
        if (other.personalChoice && other.personalChoice.modId === CHOICE_ID
          && other.personalChoice.data && other.personalChoice.data.target === targetId) {
          m.autoModChoice(other);
        }
      }
    },
    onDecline(m, ps, { data }) {
      log.info(`${ps.name} 没有在准备期开始前作答，视为放弃复活 ${(data && data.name) || ''}`.trim());
    },
  });

  registerModSettleHook((m, { eliminated }) => {
    for (const out of eliminated) {
      // A seat that LEFT is not a defeat — there is nobody to bring back.
      if (out.left) continue;
      for (const ps of m.alivePlayers()) {
        if (!(ps.lp > cost)) continue;   // it could not pay even if it wanted to
        const res = m.offerModChoice(ps, CHOICE_ID, {
          title: '复生协议',
          desc: `消耗 ${cost} 点血量，让 ${out.name} 以 ${reviveLp} 点血量回到战场`,
          cards: [
            { kind: 'tactic', id: 'revive', name: '复生协议', desc: `消耗自己 ${cost} 点血量，复活 ${out.name}` },
            { kind: 'tactic', id: 'decline', name: '放弃', desc: '不消耗血量' },
          ],
          data: { target: out.playerId, name: out.name },
        });
        if (!res.ok && res.error !== 'BOT') log.warn(`无法向 ${ps.playerId} 提问：${res.error}`);
      }
    }
  });
}

/** @param {{ id: string, version: string, log: { info: Function, warn: Function } }} ctx */
export async function setup(ctx) {
  const config = readJson('config.json', DEFAULTS);
  setupRevive(config, ctx.log);
  const shared = config.sharedBarNote === false ? '' : '（若同时启用了全队共享血条，代价由那条共享血条承担，复活血量也由它决定）';
  ctx.log.info(`已启用：被淘汰时结算后询问每个存活队友，任一队友支付 ${config.cost} 点血量可将其以 `
    + `${config.reviveLp} 点血量复活；准备期开始前未作答视为放弃${shared}`);
}
