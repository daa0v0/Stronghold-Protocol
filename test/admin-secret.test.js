// 运维后台的密钥怎么来 (docs/ADMIN.md §2): the three sources the server reads, and the tool that sets one on a first run.
//
// The user report behind this file: "我第一次运行，进 /admin 是 404" — with no configured secret that is by design, but
// nothing asked for one and nothing said why. These tests pin both halves: the precedence (env → ADMIN_SECRET_FILE →
// runtime/admin.secret) and the first-run tool's behaviour, on files in a temporary directory so a developer's own secret
// is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readAdminSecret, weakSecretWarning, ADMIN_MIN_SECRET_LEN, ADMIN_RECOMMENDED_SECRET_LEN } from '../server/admin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'admin-secret.mjs');
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sp-adminsecret-'));
const run = (args, { env = {} } = {}) => {
  const clean = { ...process.env, ...env };
  for (const k of ['ADMIN_SECRET', 'ADMIN_SECRET_FILE']) if (!(k in env)) delete clean[k];
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, env: clean, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

test('the secret comes from ADMIN_SECRET, else ADMIN_SECRET_FILE, else the default file', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'from-env-file.secret');
  const fallback = path.join(dir, 'runtime', 'admin.secret');
  try {
    fs.writeFileSync(file, 'f'.repeat(24) + '\n');
    // nothing configured at all: off, and the reason names every place it looked
    const none = readAdminSecret({}, { defaultFile: fallback });
    assert.equal(none.secret, null);
    assert.equal(none.source, null);
    assert.match(none.problem, /ADMIN_SECRET/);
    assert.match(none.problem, /admin-secret\.mjs/, 'and tells the operator what to run');
    // the default file is the last resort
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    fs.writeFileSync(fallback, 'd'.repeat(24));
    assert.deepEqual(readAdminSecret({}, { defaultFile: fallback }), { secret: 'd'.repeat(24), source: 'default', problem: '' });
    // an explicit ADMIN_SECRET_FILE wins over it
    assert.equal(readAdminSecret({ ADMIN_SECRET_FILE: file }, { defaultFile: fallback }).source, 'file');
    // and ADMIN_SECRET wins over both
    assert.equal(readAdminSecret({ ADMIN_SECRET: 'e'.repeat(24), ADMIN_SECRET_FILE: file }, { defaultFile: fallback }).source, 'env');
    // a short secret is refused wherever it comes from
    assert.match(readAdminSecret({ ADMIN_SECRET: 'short' }, {}).problem, new RegExp(String(ADMIN_MIN_SECRET_LEN)));
    fs.writeFileSync(fallback, 'tiny');
    assert.match(readAdminSecret({}, { defaultFile: fallback }).problem, /至少需要/);
    // a missing default file is "not configured", not an error to shout about
    assert.doesNotMatch(readAdminSecret({}, { defaultFile: path.join(dir, 'nope.secret') }).problem, /读取失败/);
    // an unreadable ADMIN_SECRET_FILE is reported as such (it was asked for explicitly)
    assert.match(readAdminSecret({ ADMIN_SECRET_FILE: path.join(dir, 'nope.secret') }, { defaultFile: fallback }).problem, /读取失败/);
    // an empty default file is still off — a zero-byte file must not be a password
    fs.writeFileSync(fallback, '\n');
    assert.equal(readAdminSecret({}, { defaultFile: fallback }).secret, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ensure: writes a strong secret once, is idempotent, and never blocks without a terminal', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'admin.secret');
  try {
    const first = run(['ensure', '--file=' + file]);
    assert.equal(first.status, 0, first.out);
    assert.match(first.out, /已写入/);
    const written = fs.readFileSync(file, 'utf8').trim();
    assert.ok(written.length >= 32, `the generated secret should be strong (got ${written.length} characters)`);
    assert.match(first.out, new RegExp(written), 'a generated secret is shown once, so the operator can save it');

    // a second ensure leaves it alone (no terminal here, and the secret exists)
    const second = run(['ensure', '--file=' + file]);
    assert.equal(second.status, 0);
    assert.match(second.out, /已经配置好了/);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), written, 'the secret did not change');

    // show never prints the value unless asked
    const shown = run(['show', '--file=' + file]);
    assert.match(shown.out, /已启用/);
    assert.doesNotMatch(shown.out, new RegExp(written));
    assert.match(run(['show', '--file=' + file, '--reveal']).out, new RegExp(written));

    // off removes it and says what that means
    const off = run(['off', '--file=' + file]);
    assert.equal(off.status, 0);
    assert.match(off.out, /404/);
    assert.equal(fs.existsSync(file), false);
    assert.match(run(['show', '--file=' + file]).out, /关闭/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('set/rotate refuse a weak secret and rotate replaces a good one', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'admin.secret');
  try {
    const weak = run(['set', '--secret=short', '--file=' + file]);
    assert.equal(weak.status, 1);
    assert.match(weak.out, new RegExp(`至少需要 ${ADMIN_MIN_SECRET_LEN} 个字符`));
    assert.equal(fs.existsSync(file), false, 'nothing is written when the input is refused');

    // A password the owner will actually remember is accepted, with one honest warning instead of a refusal.
    const six = run(['set', '--secret=abc123', '--file=' + file]);
    assert.equal(six.status, 0, six.out);
    assert.match(six.out, /只有 6 个字符/, 'a short password is accepted but called out');
    assert.match(six.out, /公网/);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), 'abc123');
    assert.match(run(['show', '--file=' + file]).out, /提示：.*只有 6 个字符/, 'and show repeats it');
    assert.equal(weakSecretWarning('abc123'), weakSecretWarning('abc123'));
    assert.ok(weakSecretWarning('abc123'), 'six characters is called out');
    assert.equal(weakSecretWarning('a'.repeat(ADMIN_RECOMMENDED_SECRET_LEN)), null, 'the recommended length is not');
    assert.equal(weakSecretWarning(''), null, 'and an empty secret is a different problem entirely');
    assert.doesNotMatch(run(['set', '--secret=' + 'a'.repeat(12), '--file=' + file]).out, /只有/, 'twelve characters is quiet');

    const good = run(['set', '--secret=' + 'a'.repeat(20), '--file=' + file]);
    assert.equal(good.status, 0, good.out);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), 'a'.repeat(20));

    const rotated = run(['rotate', '--file=' + file]);
    assert.equal(rotated.status, 0);
    const after = fs.readFileSync(file, 'utf8').trim();
    assert.notEqual(after, 'a'.repeat(20), 'rotate really replaces it');
    assert.match(rotated.out, /已登录的会话立即失效/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
