// mods/shared-health-bar/main.mjs — 全队共用一条血条 (docs/MODS.md).
//
// The shipped game gives every seat its own LP: it starts at the 方针 (band) the player drafted (`totalHp`) and battle damage
// spends it. This mod makes the team hold ONE bar instead, and the owner chooses how big it is:
//
//   { "mode": "sum" | "max",  "source": "band" | "lp" }
//
//   sum  + band   the drafted 方针's totalHp added up          (default)
//   max  + band   the highest of them — a smaller, tenser bar
//   lp            the same sum/max over the health the seats hold when the pool is built
//
// It is a CODE mod because no data table describes how health is spent. Everything that changes a player's LP goes through
// the match's one choke point (`server/match/match/lp.js`), so the seats cannot drift apart; the mod only sets the rule
// (`shared/matchRules.js` `sharedLp`), which the choke point, the invariant audit and the elimination path all read.
//
// Two consequences worth knowing (docs/MODS.md §4.6): the hidden core's redistribution spreads the team's pool evenly
// instead of per seat, and an empty bar cannot be revived into.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setMatchRules } from '../../shared/matchRules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = { mode: 'sum', source: 'band' };

/** @param {{ id: string, version: string, log: { info: Function, warn: Function } }} ctx */
export async function setup(ctx) {
  let config = { ...DEFAULTS };
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) };
  } catch (error) {
    ctx.log.warn(`config.json 读取失败，使用默认值：${error.message}`);
  }
  const { applied, rejected } = setMatchRules({
    sharedLp: { mode: config.mode === 'max' ? 'max' : 'sum', source: config.source === 'lp' ? 'lp' : 'band' },
  });
  if (rejected.length) {
    ctx.log.warn(`配置无效，本 mod 未启用：${rejected.join(', ')}（mode 需为 sum|max，source 需为 band|lp）`);
    return;
  }
  const rule = applied.includes('sharedLp');
  const what = config.source === 'lp' ? '当前血量' : '所选方针的 totalHp';
  ctx.log.info(rule
    ? `全队共享一条血条：大小 = 队内${what}的${config.mode === 'max' ? '最高值' : '总和'}`
    : '未启用');
}
