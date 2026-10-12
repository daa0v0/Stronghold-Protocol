// mods/dup-strategies/main.mjs — 同一策略可以被多名玩家复选 (docs/MODS.md).
//
// The shipped game keeps a card pool unique within a fixed group: `group.taken[card.idx]` records the one player who took
// a card and `spCardAvailable` refuses it afterwards. This mod flips the rule the draft, its invariant audit and the client
// view all read (`shared/matchRules.js`), so two players of the same group may hold the same card.
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
  let config = { choiceDuplicates: true };
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) };
  } catch (error) {
    ctx.log.warn(`config.json 读取失败，使用默认值：${error.message}`);
  }
  const { applied, rejected } = setMatchRules({ choiceDuplicates: config.choiceDuplicates !== false });
  if (rejected.length) ctx.log.warn(`忽略无效配置：${rejected.join(', ')}`);
  ctx.log.info(applied.includes('choiceDuplicates') && config.choiceDuplicates !== false
    ? '机变卡池不再唯一：同组内多名玩家可以选择同一张卡'
    : '未启用（config.json 的 choiceDuplicates 为 false）');
}
