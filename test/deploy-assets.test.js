// Deployment assets (docs/DEPLOY-LINUX.md, docs/DEPLOY-QUICKSTART.md): file formats, service and reverse-proxy
// invariants, and Windows/Linux parity.
//
// These are the things a normal code review cannot see and that fail on the TARGET machine only:
//   * a PowerShell script saved without its UTF-8 BOM — Windows PowerShell 5.1 then decodes the Chinese text as ANSI
//     and reports "字符串缺少终止符" (this really happened while writing scripts/preflight-windows.ps1);
//   * a script the docs tell the user to run as `./scripts/x.sh` that git records as 100644 → Permission denied;
//   * `ProtectSystem=strict` without a matching `ReadWritePaths` → the server boots and then cannot write announcements;
//   * `MemoryDenyWriteExecute=yes` → V8's JIT cannot start, Node exits immediately;
//   * an nginx `/ws` block without the upgrade headers or with a short read timeout → clients drop every minute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (...p) => path.join(ROOT, ...p);
const read = (p) => readFileSync(rel(p), 'utf8');
const readBytes = (p) => readFileSync(rel(p));
const scriptFiles = () => readdirSync(rel('scripts')).filter((f) => !f.startsWith('.')).sort();

/** The `eol=` rule .gitattributes gives an extension (`lf` when it only says `text`). */
function eolRuleFor(ext) {
  const patterns = read('.gitattributes').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  // the last matching line wins, exactly like git
  let rule = null;
  for (const line of patterns) {
    const [glob, ...attrs] = line.split(/\s+/);
    if (glob !== `*.${ext}`) continue;
    const eol = attrs.find((a) => a.startsWith('eol='));
    rule = eol ? eol.slice(4) : attrs.includes('text') ? 'lf' : null;
  }
  return rule;
}

test('scripts follow the .gitattributes line endings', () => {
  let checked = 0;
  for (const name of scriptFiles()) {
    const ext = name.slice(name.lastIndexOf('.') + 1);
    const rule = eolRuleFor(ext);
    if (!rule) continue;
    const raw = readBytes(path.join('scripts', name)).toString('latin1');
    const crlf = (raw.match(/\r\n/g) || []).length;
    const bareLf = (raw.match(/\n/g) || []).length - crlf;
    if (rule === 'lf') {
      assert.equal(crlf, 0, `scripts/${name} must be LF only (.gitattributes: *.${ext} eol=lf)`);
    } else {
      assert.equal(bareLf, 0, `scripts/${name} must be CRLF only (.gitattributes: *.${ext} eol=crlf)`);
    }
    checked++;
  }
  assert.ok(checked >= 8, `expected to check the scripts, saw ${checked}`);
});

test('every PowerShell script carries a UTF-8 BOM (Windows PowerShell 5.1 reads no-BOM files as ANSI)', () => {
  const ps1 = scriptFiles().filter((f) => f.endsWith('.ps1'));
  assert.ok(ps1.length >= 3, `expected several .ps1 scripts, saw ${ps1.length}`);
  for (const name of ps1) {
    const b = readBytes(path.join('scripts', name));
    assert.deepEqual([...b.subarray(0, 3)], [0xEF, 0xBB, 0xBF],
      `scripts/${name} must start with a UTF-8 BOM, or PS 5.1 mangles its Chinese text`);
  }
});

test('batch scripts carry NO BOM (cmd.exe would try to run the BOM bytes)', () => {
  for (const name of scriptFiles().filter((f) => f.endsWith('.bat') || f.endsWith('.cmd'))) {
    const b = readBytes(path.join('scripts', name));
    assert.notDeepEqual([...b.subarray(0, 3)], [0xEF, 0xBB, 0xBF], `scripts/${name} must not start with a BOM`);
  }
});

test('the docs invoke the Linux scripts as `sh scripts/x.sh`, which needs no executable bit', () => {
  // Why this is a rule and not a style choice: a zip built on Windows carries no Unix modes, so a copy extracted from
  // one has scripts at 0644 and `./scripts/x.sh` dies with "Permission denied (os error 13)" (a noexec mount gives the
  // same error). `sh scripts/x.sh` works in every one of those cases, so the guides must show that form.
  const docs = ['README.md', 'docs/DEPLOY.md', 'docs/DEPLOY-LINUX.md', 'docs/DEPLOY-QUICKSTART.md', 'docs/ADMIN.md'];
  const shForm = new Set();
  const dotForm = new Set();
  for (const doc of docs) {
    const text = read(doc);
    for (const m of text.matchAll(/(?:^|\s|\$ )sh\s+scripts\/([A-Za-z0-9_\-.]+\.sh)/g)) shForm.add(m[1]);
    for (const m of text.matchAll(/\.\/scripts\/([A-Za-z0-9_\-.]+\.sh)/g)) dotForm.add(m[1]);
  }
  assert.ok(shForm.size >= 3, `expected \`sh scripts/*.sh\` in the guides, saw ${shForm.size}`);
  for (const name of shForm) assert.ok(existsSync(rel('scripts', name)), `the guides run scripts/${name}, which does not exist`);

  // The failure mode this guard exists for must stay explained where the user hits it.
  const linux = read('docs/DEPLOY-LINUX.md');
  for (const needle of ['Permission denied', 'chmod +x scripts/*.sh', 'sudo sh scripts/preflight-linux.sh']) {
    assert.ok(linux.includes(needle), `docs/DEPLOY-LINUX.md must mention ${needle}`);
  }

  // A doc that still offers the `./` form must only do so for a script git records as executable.
  if (!dotForm.size) return;
  let listing;
  try {
    listing = execFileSync('git', ['ls-files', '-s', 'scripts'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  } catch {
    return; // no git: the `sh` form above is what matters
  }
  const modes = new Map();
  for (const line of listing.split('\n')) {
    const m = line.match(/^(\d{6})\s+\w+\s+\d+\t(.+)$/);
    if (m) modes.set(path.basename(m[2]), m[1]);
  }
  for (const name of dotForm) {
    assert.equal(modes.get(name), '100755',
      `docs show ./scripts/${name}, so git must record it as 100755 (currently ${modes.get(name) || 'missing'})`);
  }
});

test('the ops scripts never tell the user to run ./scripts/<script>.sh either', () => {
  // Their own usage comments and runtime hints matter as much as the guides: a copy extracted from a Windows-built zip
  // has no executable bit, so a hint that says `./scripts/x.sh` sends the user straight back into "Permission denied".
  // Naming a script that does not exist (the `./scripts/x.sh` in the explanation of the failure mode) is fine.
  const names = scriptFiles().filter((f) => f.endsWith('.sh'));
  const real = new Set(names);
  let placeholders = 0;
  for (const name of names) {
    const src = read(path.join('scripts', name));
    for (const m of src.matchAll(/\.\/scripts\/([A-Za-z0-9_\-.]+\.sh)/g)) {
      if (!real.has(m[1])) { placeholders++; continue; }
      assert.fail(`scripts/${name} tells the user to run ./scripts/${m[1]} — use \`sh scripts/${m[1]}\``);
    }
  }
  assert.ok(placeholders >= 1, 'the explanation of the failure mode should still show the ./ form it warns about');
});

test('the Linux and Windows ops scripts exist in pairs and both are documented', () => {
  const quickstart = read('docs/DEPLOY-QUICKSTART.md');
  const pairs = [
    ['install-service-linux.sh', 'install-service-windows.ps1'],
    ['preflight-linux.sh', 'preflight-windows.ps1'],
  ];
  for (const [linux, windows] of pairs) {
    assert.ok(existsSync(rel('scripts', linux)), `missing scripts/${linux}`);
    assert.ok(existsSync(rel('scripts', windows)), `missing scripts/${windows}`);
    // The cross-platform claim is only true if both halves are reachable from the tutorial.
    assert.match(quickstart, new RegExp(linux.replace(/\./g, '\\.')), `DEPLOY-QUICKSTART.md must mention ${linux}`);
    assert.match(quickstart, new RegExp(windows.replace(/\./g, '\\.')), `DEPLOY-QUICKSTART.md must mention ${windows}`);
  }
  assert.match(quickstart, /同一份代码/, 'the tutorial must state the one-codebase-two-platforms claim');
});

test('the systemd unit is complete, keeps the runtime writable and cannot wedge Node', () => {
  const unit = read('deploy/stronghold.service');
  for (const key of ['[Unit]', '[Service]', '[Install]']) assert.ok(unit.includes(key), `unit is missing ${key}`);
  for (const key of ['WorkingDirectory=', 'ExecStart=', 'User=', 'Group=', 'Restart=', 'EnvironmentFile=', 'ReadWritePaths=']) {
    assert.match(unit, new RegExp(`^${key}`, 'm'), `unit is missing ${key}`);
  }
  assert.match(unit, /^ExecStart=.*\bnode\b.*server\/index\.js$/m, 'ExecStart must run server/index.js');
  assert.match(unit, /^WantedBy=multi-user\.target$/m);
  // ProtectSystem=strict makes everything read-only: runtime/ (announcements + server-settings.json) must stay writable.
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ReadWritePaths=.*\bruntime\b/m, 'ReadWritePaths must include runtime/, or the server cannot write announcements');
  // V8's JIT needs writable+executable memory; this directive makes Node exit at once.
  assert.doesNotMatch(unit, /^MemoryDenyWriteExecute=yes$/m, 'MemoryDenyWriteExecute=yes stops Node from starting');
});

test('the nginx config keeps WebSockets, big downloads and the proxied IP working', () => {
  const nginx = read('deploy/nginx-stronghold.conf');
  const block = (start) => {
    const i = nginx.indexOf(start);
    assert.ok(i >= 0, `missing ${start}`);
    const rest = nginx.slice(i);
    const end = rest.indexOf('\n    }');
    return end > 0 ? rest.slice(0, end) : rest;
  };
  const ws = block('location /ws {');
  assert.match(ws, /proxy_set_header Upgrade \$http_upgrade/, '/ws must forward the Upgrade header');
  assert.match(ws, /proxy_set_header Connection "upgrade"/, '/ws must forward Connection: upgrade');
  const timeout = Number((ws.match(/proxy_read_timeout (\d+)s/) || [])[1] || 0);
  assert.ok(timeout >= 600, `the /ws read timeout is ${timeout}s: a long match would be cut off`);
  assert.match(block('location /assets/ {'), /proxy_buffering off/, '/assets/ must not be buffered by nginx');
  assert.match(nginx, /^\s*gzip off;/m, 'the server already compresses: nginx must not re-compress');
  assert.match(nginx, /X-Forwarded-Proto \$scheme/, 'TRUST_PROXY and the Secure cookie flag need X-Forwarded-Proto');
  assert.ok(existsSync(rel('deploy/proxy_params_stronghold.conf')), 'the shared proxy header file is missing');
});

test('the env example and the admin doc agree on how the console is switched on', () => {
  const env = read('deploy/stronghold.env.example');
  const admin = read('docs/ADMIN.md');
  for (const key of ['PORT=', 'HOST=', 'ADMIN_SECRET_FILE=', 'SP_COMBAT=', 'TRUST_PROXY=']) {
    assert.ok(env.includes(key), `deploy/stronghold.env.example must document ${key}`);
  }
  assert.match(env, /ADMIN_SECRET_FILE=\/etc\/stronghold\/admin\.secret/, 'the env example must point at the generated secret');
  for (const key of ['ADMIN_SECRET', 'ADMIN_SECRET_FILE', 'timingSafeEqual', '/api/admin/overview', '/api/admin/maintenance']) {
    assert.ok(admin.includes(key), `docs/ADMIN.md must document ${key}`);
  }
  assert.match(admin, /至少 16/, 'docs/ADMIN.md must state the minimum secret length');
});

test('every deploy/ file is referenced by a deployment guide', () => {
  const docs = read('docs/DEPLOY-LINUX.md') + read('docs/DEPLOY-QUICKSTART.md') + read('docs/ADMIN.md') + read('docs/DEPLOY.md');
  const files = readdirSync(rel('deploy')).filter((f) => !f.startsWith('.'));
  for (const expected of ['stronghold.service', 'stronghold.env.example', 'nginx-stronghold.conf', 'proxy_params_stronghold.conf']) {
    assert.ok(files.includes(expected), `deploy/${expected} is missing`);
  }
  for (const f of files) assert.ok(docs.includes(f), `deploy/${f} is not mentioned by any deployment guide`);
});

test('the /bin/sh scripts stay dash-compatible (on Debian/Ubuntu /bin/sh IS dash)', () => {
  // Constructs that work in bash and fail or misbehave in dash. `scripts/start.sh` is #!/usr/bin/env bash on purpose,
  // so it is skipped — but a #!/bin/sh script must never pick one of these up.
  const bashisms = [
    [/\bpipefail\b/, 'set -o pipefail'],
    [/\[\[/, '[[ … ]]'],
    [/^\s*local\s/m, 'local'],
    [/^\s*function\s/m, 'function'],
    [/\$\{[A-Za-z_][A-Za-z0-9_]*(?:\^\^|,,)/, '${var^^} / ${var,,}'],
    [/^\s*[A-Za-z_][A-Za-z0-9_]*=\(/m, 'array assignment'],
    [/\becho\s+-e\b/, 'echo -e'],
  ];
  let checked = 0;
  for (const name of scriptFiles().filter((f) => f.endsWith('.sh'))) {
    const src = read(path.join('scripts', name));
    if (!src.startsWith('#!/bin/sh')) continue;
    checked++;
    for (const [re, label] of bashisms) {
      assert.doesNotMatch(src, re, `scripts/${name} is #!/bin/sh but uses ${label}, which dash rejects`);
    }
  }
  assert.ok(checked >= 3, `expected the #!/bin/sh scripts, saw ${checked}`);
});

test('the installer can rewrite every key it substitutes in its templates', () => {
  // install-service-linux.sh rewrites deploy/stronghold.service and deploy/stronghold.env.example with sed. If a key
  // moves, gains a second line or is renamed, sed silently does nothing and the service starts with the wrong config —
  // this is exactly the failure a reviewer cannot see.
  const installer = read('scripts/install-service-linux.sh');
  const chunks = installer.split(/(?=^\s*sed )/m).slice(1);
  assert.ok(chunks.length >= 2, `expected the installer's sed pipelines, saw ${chunks.length}`);
  let keys = 0;
  for (const chunk of chunks) {
    const head = [];
    for (const line of chunk.split('\n')) { head.push(line); if (!line.trimEnd().endsWith('\\')) break; }
    const body = head.join('\n');
    const file = (body.match(/\$APP_DIR\/deploy\/([A-Za-z0-9_.-]+)/) || [])[1];
    assert.ok(file, `a sed pipeline in the installer reads no deploy/ template:\n${body}`);
    const rewritten = [...body.matchAll(/-e "s#\^([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]);
    assert.ok(rewritten.length > 0, `the sed pipeline for deploy/${file} rewrites no key`);
    const template = read(path.join('deploy', file)).split('\n').map((l) => l.replace(/\r$/, ''));
    for (const key of rewritten) {
      const hits = template.filter((l) => l.startsWith(`${key}=`)).length;
      assert.equal(hits, 1,
        `deploy/${file} has ${hits} lines starting with ${key}=, so the installer's sed for ${key} would do nothing`);
      keys++;
    }
  }
  assert.ok(keys >= 8, `expected to check the installer's substitutions, saw ${keys}`);
});
