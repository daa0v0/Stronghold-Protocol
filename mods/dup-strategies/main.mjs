// mods/dup-strategies/main.mjs — 开局策略（方针）可以被多名玩家重复选择 (docs/MODS.md).
//
// The shipped game keeps the 开局策略/方针 draft unique inside a fixed pool group: a teammate's pick is marked 队友已选 and
// `Match.bandTaken` refuses it afterwards (`pickBand` fails, the bot re-draws, a timed-out turn falls back to a free
// strategy). This mod flips the one rule all of those readers share (`shared/matchRules.js` `bandDuplicates`), so several
// players of the same group may draft 芬, 阿米娅, 变形者集群 … together.
//
// It is a CODE mod rather than a data pack on purpose: no data table describes how a draft's picks are booked, and a pack
// can never change behaviour. `config.json` next to this file is the mod's own switch, so an owner can keep the mod
// installed but off.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setMatchRules } from '../../shared/matchRules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** @param {{ id: string, version: string, log: { info: Function, warn: Function } }} ctx */
export async function setup(ctx) {
  let config = { bandDuplicates: true };
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) };
  } catch (error) {
    ctx.log.warn(`config.json 读取失败，使用默认值：${error.message}`);
  }
  const on = config.bandDuplicates !== false;
  const { applied, rejected } = setMatchRules({ bandDuplicates: on });
  if (rejected.length) ctx.log.warn(`忽略无效配置：${rejected.join(', ')}`);
  ctx.log.info(applied.includes('bandDuplicates') && on
    ? '开局策略不再唯一：同一池组内多名玩家可以选择同一个方针'
    : '未启用（config.json 的 bandDuplicates 为 false）');
}
