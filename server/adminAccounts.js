// server/adminAccounts.js — the 运维后台's operator accounts (docs/ADMIN.md).
//
// The console itself stays behind ADMIN_SECRET (fail closed, no default password); accounts are the ADDITIONAL way in:
// several operators work with their own id, and the announcement catalog records which id published what. The account
// file lives in runtime/ next to the player accounts (runtime/admin-accounts.json) — persistent, writable, never in
// .cache/ (disposable) and never under public/ (served).
//
// Security notes worth keeping:
//   * Passwords are scrypt-hashed with a per-account salt, exactly like the player store (server/accounts.js). The
//     console never sees a hash, a salt or a token: the list returns id, name, timestamps and the disabled flag.
//   * A disabled account cannot log in and its sessions stop authenticating (the service drops them on change).
//   * There is deliberately no "forgot password" path: the owner (the ADMIN_SECRET holder) resets a password.
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const scrypt = promisify(scryptCb);
const PASS_MIN = 8;
const PASS_MAX = 128;
/** The public id shown under an announcement title; also the login id. Lowercase so the display never surprises. */
const ID_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;
/** A display name may be any trimmed non-empty short string (Chinese is the normal case). */
const NAME_MAX = 40;
const MAX_ACCOUNTS = 50;

export function validAdminAccountId(value) {
  return typeof value === 'string' && ID_RE.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
}
export function validAdminPassword(value) {
  return typeof value === 'string' && [...value].length >= PASS_MIN && [...value].length <= PASS_MAX;
}
function validName(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && [...value].length <= NAME_MAX;
}

const normalizeId = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

export function createAdminAccountStore({ file, log = console } = {}) {
  const filePath = file || path.resolve('runtime', 'admin-accounts.json');
  /** @type {Map<string, any>} id → record */
  const accounts = new Map();
  let writeQueue = Promise.resolve();
  let mutationQueue = Promise.resolve();

  async function load() {
    try {
      const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (!raw || typeof raw !== 'object' || raw.version !== 1 || !raw.accounts || typeof raw.accounts !== 'object') {
        throw new Error('管理员账号文件格式无效');
      }
      for (const [id, value] of Object.entries(raw.accounts)) {
        if (!validAdminAccountId(id) || !value || typeof value !== 'object') throw new Error(`管理员账号 ${id} 无效`);
        accounts.set(id, {
          id,
          name: validName(value.name) ? value.name : id,
          salt: String(value.salt || ''),
          passwordHash: String(value.passwordHash || ''),
          createdAt: Number(value.createdAt) || Date.now(),
          disabled: value.disabled === true,
          lastLoginAt: Number(value.lastLoginAt) || null,
        });
      }
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      log.error?.(`[admin-accounts] cannot read store: ${e.message}`);
      throw e;
    }
  }

  const ready = load().then((ok) => { if (!ok) return false; return true; }).catch(() => false);

  async function persist() {
    const data = JSON.stringify({ version: 1, accounts: Object.fromEntries(accounts) }, null, 2);
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, `${data}\n`, { mode: 0o600 });
      await fs.rename(tmp, filePath);
    });
    return writeQueue;
  }

  /** The operator's view of one account. Never carries the hash, the salt or any token. */
  function summary(rec) {
    return { id: rec.id, name: rec.name, createdAt: rec.createdAt, disabled: rec.disabled === true, lastLoginAt: rec.lastLoginAt };
  }

  /**
   * Create one account. The id doubles as the announcement's visible "author" label, so it is stable and short.
   * @param {{ id: string, password: string, name?: string }} input
   */
  async function create({ id, password, name }) {
    const run = mutationQueue.then(async () => {
      await ready;
      const cleanId = normalizeId(id);
      if (!validAdminAccountId(cleanId)) return { ok: false, error: 'BAD_ID' };
      if (name !== undefined && name !== null && name !== '' && !validName(name)) return { ok: false, error: 'BAD_NAME' };
      if (!validAdminPassword(password)) return { ok: false, error: 'BAD_PASSWORD' };
      if (accounts.has(cleanId)) return { ok: false, error: 'ID_TAKEN' };
      if (accounts.size >= MAX_ACCOUNTS) return { ok: false, error: 'TOO_MANY' };
      const salt = randomBytes(16);
      const digest = await scrypt(password, salt, 64);
      const rec = {
        id: cleanId, name: validName(name) ? name : cleanId, salt: salt.toString('hex'), passwordHash: digest.toString('hex'),
        createdAt: Date.now(), disabled: false, lastLoginAt: null,
      };
      accounts.set(cleanId, rec);
      try { await persist(); } catch (e) { accounts.delete(cleanId); throw e; }
      return { ok: true, account: summary(rec) };
    });
    mutationQueue = run.catch(() => {});
    return run;
  }

  async function list() {
    await ready;
    return { accounts: [...accounts.values()].sort((a, b) => a.createdAt - b.createdAt).map(summary), total: accounts.size };
  }

  async function setPassword(id, password) {
    const run = mutationQueue.then(async () => {
      await ready;
      const key = normalizeId(id);
      const rec = accounts.get(key);
      if (!rec) return { ok: false, error: 'NO_SUCH_ACCOUNT' };
      if (!validAdminPassword(password)) return { ok: false, error: 'BAD_PASSWORD' };
      const salt = randomBytes(16);
      const digest = await scrypt(password, salt, 64);
      rec.salt = salt.toString('hex');
      rec.passwordHash = digest.toString('hex');
      await persist();
      return { ok: true, account: summary(rec) };
    });
    mutationQueue = run.catch(() => {});
    return run;
  }

  async function setDisabled(id, disabled) {
    const run = mutationQueue.then(async () => {
      await ready;
      const key = normalizeId(id);
      const rec = accounts.get(key);
      if (!rec) return { ok: false, error: 'NO_SUCH_ACCOUNT' };
      rec.disabled = disabled === true;
      await persist();
      return { ok: true, account: summary(rec) };
    });
    mutationQueue = run.catch(() => {});
    return run;
  }

  async function remove(id) {
    const run = mutationQueue.then(async () => {
      await ready;
      const key = normalizeId(id);
      const rec = accounts.get(key);
      if (!rec) return { ok: false, error: 'NO_SUCH_ACCOUNT' };
      accounts.delete(key);
      try { await persist(); } catch (e) { accounts.set(key, rec); throw e; }
      return { ok: true, id: rec.id, name: rec.name };
    });
    mutationQueue = run.catch(() => {});
    return run;
  }

  /** Constant-time comparison, with a dummy hash for unknown ids so a missing account costs the same as a wrong one. */
  async function authenticate(id, password) {
    await ready;
    const rec = accounts.get(normalizeId(id));
    const salt = rec ? Buffer.from(rec.salt, 'hex') : Buffer.alloc(16);
    const expected = rec ? Buffer.from(rec.passwordHash, 'hex') : Buffer.alloc(64);
    const actual = Buffer.from(await scrypt(typeof password === 'string' ? password.slice(0, PASS_MAX) : '', salt, 64));
    if (!rec || rec.disabled === true || !timingSafeEqual(actual, expected)) return null;
    rec.lastLoginAt = Date.now();
    try { await persist(); } catch { /* a failed timestamp write must not refuse a valid login */ }
    return { id: rec.id, name: rec.name };
  }

  return { ready, create, list, setPassword, setDisabled, remove, authenticate };
}
