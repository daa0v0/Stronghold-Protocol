// tools/admin-secret.mjs — 运维后台 (/admin) 的密钥，第一次运行/部署时设置 (docs/ADMIN.md §2).
//
//   node tools/admin-secret.mjs ensure [--secret=… | --generate] [--quiet]   首次运行：没有密钥就设一个（启动脚本调用它）
//   node tools/admin-secret.mjs set    [--secret=… | --generate]             设置 / 替换
//   node tools/admin-secret.mjs show   [--reveal]                            现在从哪来、是否生效（默认不打印密钥本身）
//   node tools/admin-secret.mjs rotate [--generate]                          换一个（已登录的会话立即失效）
//   node tools/admin-secret.mjs off                                          删除文件，后台回到 404
//
// 服务器按 `ADMIN_SECRET` → `ADMIN_SECRET_FILE` → **本工具的默认文件** `runtime/admin.secret` 的顺序取密钥
// (server/admin.js `readAdminSecret`)，所以本地直接 `npm start` 也能有一个可用的后台：密钥写在文件里，进程环境里看不到。
//
// `ensure` 是 scripts/launch.mjs 在启动服务器前调用的：交互式终端会**问你**（直接回车 = 自动生成 64 位随机密钥），
// 非交互（服务、CI、管道）则生成一个而不是把后台留成关闭 —— 但**没有文件就是没有后台**这条不变（docs/ADMIN.md §1）。
//
// Exit codes: 0 = 完成, 1 = 输入不合法或无法写入, 2 = 参数错误.

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { ADMIN_MIN_SECRET_LEN, readAdminSecret } from '../server/admin.js';

const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'));
/** Where the secret is kept. `--file=` (or SP_ADMIN_SECRET_FILE) points it elsewhere — tests, or a second deployment. */
let SECRET_FILE = join(ROOT, 'runtime', 'admin.secret');
const SOURCE_NAME = { env: 'ADMIN_SECRET（环境变量）', file: 'ADMIN_SECRET_FILE（环境变量指向的文件）', default: 'runtime/admin.secret（本文件）' };

/** A fresh 64-character secret. @returns {string} */
const generate = () => randomBytes(32).toString('hex');

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { command: null, secret: null, generate: false, quiet: false, reveal: false, file: String(process.env.SP_ADMIN_SECRET_FILE ?? '').trim() || null };
  for (const a of argv) {
    if (a === '--generate') out.generate = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--reveal') out.reveal = true;
    else if (a.startsWith('--secret=')) out.secret = a.slice('--secret='.length);
    else if (a.startsWith('--file=')) out.file = a.slice('--file='.length);
    else if (a.startsWith('-')) { console.error(`unknown argument: ${a}`); process.exit(2); }
    else if (!out.command) out.command = a;
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  return out;
}

/** The state the server itself would see. */
const state = () => readAdminSecret(process.env, { defaultFile: SECRET_FILE });

/** Ask for a secret on an interactive terminal. Returns null when there is no terminal to ask. */
async function ask() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('');
    console.log('首次运行：请设置运维后台（/admin）的密钥。');
    console.log(`  · 直接回车 = 自动生成 ${'64'} 位随机密钥（推荐，稍后显示一次，请存到密码管理器）`);
    console.log(`  · 或粘贴你自己的密钥（至少 ${ADMIN_MIN_SECRET_LEN} 个字符）`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const answer = (await rl.question('密钥：')).trim();
      if (!answer) return { secret: generate(), generated: true };
      if (answer.length >= ADMIN_MIN_SECRET_LEN) return { secret: answer, generated: false };
      console.log(`  太短了（${answer.length} 个字符，至少 ${ADMIN_MIN_SECRET_LEN}）。再试一次，或直接回车自动生成。`);
    }
    console.log('  三次都没有有效输入，改为自动生成。');
    return { secret: generate(), generated: true };
  } finally {
    rl.close();
  }
}

/** @param {string} secret */
function write(secret) {
  mkdirSync(dirname(SECRET_FILE), { recursive: true });
  writeFileSync(SECRET_FILE, secret + '\n', { mode: 0o600 });
  try { chmodSync(SECRET_FILE, 0o600); } catch { /* Windows: the ACL is what it is */ }
}

/** @param {{ quiet?: boolean }} o */
function report(o = {}) {
  const s = state();
  if (!s.secret) {
    console.log(`后台关闭：${s.problem}`);
    return false;
  }
  console.log(`后台已启用（密钥来源：${SOURCE_NAME[s.source] || s.source}）`);
  if (o.quiet !== true) console.log(`  打开 ${'http://<本机地址>:<端口>/admin'} 并输入密钥即可；忘记密钥就再运行一次 rotate。`);
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.file) SECRET_FILE = resolve(args.file);
  const command = args.command || 'ensure';
  if (command === 'show') {
    const s = state();
    console.log(`文件：${SECRET_FILE}（${existsSync(SECRET_FILE) ? '存在' : '不存在'}）`);
    if (s.secret) {
      console.log(`状态：已启用，来源 ${SOURCE_NAME[s.source] || s.source}，密钥长度 ${s.secret.length}`);
      if (args.reveal) console.log(`密钥：${s.secret}`);
    } else console.log(`状态：关闭 —— ${s.problem}`);
    return 0;
  }
  if (command === 'off') {
    const s = state();
    if (existsSync(SECRET_FILE)) { rmSync(SECRET_FILE); console.log(`已删除 ${SECRET_FILE}。`); }
    else console.log(`${SECRET_FILE} 不存在，无需删除。`);
    if (s.secret && s.source !== 'default') {
      console.log(`注意：密钥还来自 ${SOURCE_NAME[s.source]}，删掉这个文件不会关闭后台 —— 请同时清掉那个变量并重启。`);
      return 0;
    }
    console.log('后台已关闭：/admin 会像任何不存在的路径一样返回 404。重启服务器后生效。');
    return 0;
  }
  if (command !== 'ensure' && command !== 'set' && command !== 'rotate') {
    console.error('用法：node tools/admin-secret.mjs [ensure|set|show|rotate|off] [--secret=… | --generate] [--quiet] [--reveal]');
    return 2;
  }

  const current = state();
  if (command === 'ensure' && current.secret) {
    if (!args.quiet) console.log(`后台已经配置好了（密钥来源：${SOURCE_NAME[current.source] || current.source}），无需改动。`);
    return 0;
  }

  /** @type {{ secret: string, generated: boolean } | null} */
  let chosen = args.secret ? { secret: args.secret, generated: false } : null;
  if (!chosen && args.generate) chosen = { secret: generate(), generated: true };
  if (!chosen) chosen = await ask();
  if (!chosen) chosen = { secret: generate(), generated: true };   // no terminal (service, CI, pipe): generate, never block
  if (chosen.secret.length < ADMIN_MIN_SECRET_LEN) {
    console.error(`✘ 密钥至少需要 ${ADMIN_MIN_SECRET_LEN} 个字符（当前 ${chosen.secret.length} 个）。`);
    return 1;
  }
  write(chosen.secret);
  console.log(`✔ 已写入 ${SECRET_FILE}`);
  if (chosen.generated) console.log(`  生成的密钥（只显示这一次，请存好）：${chosen.secret}`);
  if (args.file && resolve(args.file) !== join(ROOT, 'runtime', 'admin.secret')) {
    console.log(`  注意：服务器只在这个文件是 runtime/admin.secret 时自动读取；否则要设 ADMIN_SECRET_FILE=${SECRET_FILE} 再启动。`);
  }
  if (command === 'rotate') console.log('  已登录的会话立即失效；服务器重启后使用新密钥。');
  else console.log('  重启服务器后生效（本地启动脚本会自动带上）。');
  console.log('');
  report({ quiet: args.quiet });
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}
