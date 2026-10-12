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
import { registerMatchRuleProvider } from '../../shared/matchRules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This mod's id: what `Match.modEnabled` is asked about, and what the room's per-match choice names. */
const MOD_ID = 'dup-strategies';

/** @param {{ id: string, version: string, log: { info: Function, warn: Function } }} ctx */
export async function setup(ctx) {
  let config = { bandDuplicates: true };
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) };
  } catch (error) {
    ctx.log.warn(`config.json 读取失败，使用默认值：${error.message}`);
  }
  const on = config.bandDuplicates !== false;
  if (!on) { ctx.log.info('未启用（config.json 的 bandDuplicates 为 false）'); return; }
  // PER MATCH, not server-wide: the provider is asked once per match and answers for this mod, so a room that did not pick
  // it plays the shipped draft (docs/MODS.md §4.6).
  registerMatchRuleProvider(MOD_ID, (m) => ({ bandDuplicates: m.modEnabled(MOD_ID) }));
  ctx.log.info('开局策略不再唯一：本局启用时，同一池组内多名玩家可以选择同一个方针');
}
