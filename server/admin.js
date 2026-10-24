// server/admin.js — 运维后台 (docs/ADMIN.md): a read-mostly HTTP console over a running server.
//
// Design notes worth keeping:
//   * The panel is DISABLED unless ADMIN_SECRET (or ADMIN_SECRET_FILE) is set to at least ADMIN_MIN_SECRET_LEN
//     characters. There is no default password: a forgotten environment variable must fail closed, never open a public
//     console with a guessable secret (the fork this feature came from shipped `stronghold-admin-2026` as a fallback).
//   * Authenticating with `Authorization: Bearer <secret>` compares in constant time. The browser logs in once at
//     POST /api/admin/login and then carries a per-session cookie token, so the secret itself never lands in a cookie,
//     a log line or the browser history.
//   * Several operators can share the console WITHOUT sharing the secret: ADMIN_ACCOUNTS (server/adminAccounts.js)
//     holds named accounts, each with its own password, and every session remembers WHICH identity is logged in. The
//     announcement catalog records that identity in `author`, so a player sees which operator published a notice. The
//     owner (the ADMIN_SECRET holder) manages the accounts; an account can use the console but not the account list.
//   * Every route is answered BEFORE the bandwidth-emergency gate (server/http/routes.js), because an operator needs the
//     console exactly when the server is protecting itself.
//   * Read-only where the repository already decided: serverSettings.js states that per-server settings have no HTTP
//     administration endpoint — the panel DISPLAYS them and the CLI (tools/server-settings.mjs) writes them.
//   * Announcements are the one writable document store: publish / update / pin / unpin / notify go through the SAME
//     AnnouncementStore the CLI (tools/announcements.mjs) uses, so the index stays hash-verified. Delivery reuses
//     enqueueAnnouncementNotice (the on-disk spool the running server polls) rather than a second send path, which is
//     why a notice reaches players within ~1s without any restart. (The OneBot 群招募 config is the second one —
//     runtime/onebot.json via the shared store —, kept here because it changes at runtime from the console too.)
//
// i18n-ignore-file: operator-facing administration API and logs, never player-facing UI text
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { APP_VERSION, PROTOCOL_VERSION } from '../shared/constants.js';
import { enqueueAnnouncementNotice } from './announcementNotices.js';
import { send } from './net.js';

/** API prefix; anything under it is answered by server/http/admin.js. */
export const ADMIN_API_PREFIX = '/api/admin';
/** The panel itself (public/admin/index.html). */
export const ADMIN_UI_PATH = '/admin';
export const ADMIN_COOKIE = 'sp_admin';

/** A secret shorter than this is refused; none of the usual guesses reaches it. */
export const ADMIN_MIN_SECRET_LEN = 16;
export const ADMIN_LOG_MAX = 400;
export const ADMIN_LOG_TEXT_MAX = 500;

/** Login throttling, per client address (the panel is never reachable from an untrusted network without the secret). */
export const ADMIN_LOGIN_MAX_FAILURES = 8;
export const ADMIN_LOGIN_WINDOW_MS = 5 * 60 * 1000;
export const ADMIN_BROADCAST_TEXT_MAX = 300;
export const ADMIN_BODY_MAX_BYTES = 8 * 1024;
/** The identity of the ADMIN_SECRET holder: the owner who bootstraps and manages the operator accounts. */
export const ADMIN_OWNER_ID = 'owner';
/** How many console sessions this process remembers (the oldest is dropped first). */
export const ADMIN_SESSION_MAX = 64;
/**
 * The body cap for the announcement endpoints only: a notice is a Markdown document, not a toast. The generic cap stays
 * 8 KB so no other write endpoint can be used as a write amplifier; this one is bounded by the store's own
 * ANNOUNCEMENT_MAX_BODY_BYTES instead.
 */
export const ADMIN_ANNOUNCEMENT_BODY_MAX_BYTES = 96 * 1024;

/**
 * The configured secret: `ADMIN_SECRET`, else the contents of `ADMIN_SECRET_FILE` (systemd LoadCredential, a Docker
 * secret or a root-owned file — keeping the secret out of the process environment and out of `ps` output).
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ secret: string|null, source: 'env'|'file'|null, problem: string }}
 */
export function readAdminSecret(env = process.env) {
  const inline = String(env.ADMIN_SECRET ?? '').trim();
  if (inline) {
    if (inline.length < ADMIN_MIN_SECRET_LEN) return { secret: null, source: null, problem: `ADMIN_SECRET 至少需要 ${ADMIN_MIN_SECRET_LEN} 个字符` };
    return { secret: inline, source: 'env', problem: '' };
  }
  const file = String(env.ADMIN_SECRET_FILE ?? '').trim();
  if (!file) return { secret: null, source: null, problem: '未设置 ADMIN_SECRET（或 ADMIN_SECRET_FILE）' };
  let text;
  try { text = readFileSync(file, 'utf8').trim(); }
  catch (error) { return { secret: null, source: null, problem: `ADMIN_SECRET_FILE 读取失败：${error.code || error.message}` }; }
  if (text.length < ADMIN_MIN_SECRET_LEN) return { secret: null, source: null, problem: `ADMIN_SECRET_FILE 中的密钥至少需要 ${ADMIN_MIN_SECRET_LEN} 个字符` };
  return { secret: text, source: 'file', problem: '' };
}

/** Constant-time string compare that never throws on a length mismatch. */
export function secretEquals(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length === 0 || x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** One log line, stringified defensively (an operator reads this, so it must never throw). */
export function formatLogArg(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * A bounded in-memory copy of what the process logs, for the console. `seq` is monotonic so the dashboard can ask for
 * only what it has not seen; entries are dropped oldest-first.
 * @param {{ max?: number, now?: () => number }} [opts]
 */
export function createLogRing({ max = ADMIN_LOG_MAX, now = Date.now } = {}) {
  /** @type {{ seq: number, at: number, level: string, text: string }[]} */
  const entries = [];
  let seq = 0;
  let dropped = 0;
  return {
    push(level, ...args) {
      const text = args.map(formatLogArg).join(' ').slice(0, ADMIN_LOG_TEXT_MAX);
      entries.push({ seq: ++seq, at: now(), level, text });
      while (entries.length > max) { entries.shift(); dropped++; }
      return seq;
    },
    /**
     * Entries after `since` (`since: 0` = as many as `limit` allows).
     * @param {number} since @param {number} limit
     */
    list(since, limit) {
      const from = Number.isFinite(since) && since > 0 ? entries.filter((e) => e.seq > since) : entries.slice(-limit);
      const window = from.length > limit ? from.slice(-limit) : from;
      return { entries: window, nextSeq: seq, dropped };
    },
    get size() { return entries.length; },
    get lastSeq() { return seq; },
  };
}

/**
 * A logger that mirrors everything into `ring` and delegates to `log`. Returns a NEW object: `log` may be a shared
 * module-level singleton (server/http/config.js `noopLog`, a test's injected logger), and wrapping it in place would
 * both leak the wrapper into every other user of it and stack a new layer on each startServer call.
 * @param {{ info?: Function, warn?: Function, error?: Function, debug?: Function }} log
 * @param {ReturnType<typeof createLogRing>} ring
 */
export function withLogRing(log, ring) {
  /** @type {any} */
  const out = {};
  for (const level of ['info', 'warn', 'error', 'debug']) {
    const original = typeof log?.[level] === 'function' ? log[level].bind(log) : null;
    out[level] = (...args) => { ring.push(level, ...args); original?.(...args); };
  }
  return out;
}

/**
 * The operator console service. Read-only except for the deliberate writes: a message to every connected player, the
 * maintenance switch (the server's own bandwidth-emergency gate, reused so clients already render it), closing one
 * room, the announcement catalog, and (owner only) the operator accounts.
 * @param {{
 *   enabled: boolean, problem?: string, secretSource?: 'env'|'file'|null, secret: string|null,
 *   lobby: any, network: any, registry: any, bandwidthEmergency?: any, assetCache?: any,
 *   serverSettings?: any, announcements?: any, accounts?: any, adminAccounts?: any, onebot?: any, ring: ReturnType<typeof createLogRing>,
 *   log?: { info?: Function, warn?: Function, error?: Function, debug?: Function },
 *   startedAt?: number, now?: () => number, build?: () => string,
 * }} deps
 */
export function createAdminService(deps) {
  const {
    enabled, problem = '', secretSource = null, secret = null,
    lobby, network, registry, bandwidthEmergency = null, assetCache = null,
    serverSettings = null, announcements = null, accounts = null, adminAccounts = null, onebot = null,
    ring, log = console, startedAt = Date.now(), now = Date.now, build = () => '',
  } = deps;
  /** @type {Map<string, { kind: 'owner'|'account', id: string, name: string, at: number }>} */
  const sessions = new Map();
  /** The tokens of one operator account, so a password reset / ban / delete ends that operator's sessions at once. */
  /** @type {Map<string, Set<string>>} */
  const accountSessions = new Map();
  /** @type {Map<string, { count: number, until: number }>} */
  const failures = new Map();

  /** @param {any} req */
  const clientKey = (req) => String(req?.socket?.remoteAddress || req?.headers?.['x-forwarded-for'] || 'unknown');

  /** A cookie map of the request (only what we need; no dependency on a parser). */
  function cookies(req) {
    const raw = String(req?.headers?.cookie || '');
    /** @type {Record<string,string>} */
    const out = {};
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out;
  }

  /** Cookie flags: the panel is same-origin only; `Secure` is added when the request reached us over TLS. */
  function cookieFlags(req) {
    const forwarded = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const secure = !!req?.socket?.encrypted || forwarded === 'https';
    return `HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure ? '; Secure' : ''}`;
  }

  const ownerIdentity = () => ({ kind: 'owner', id: ADMIN_OWNER_ID, name: '主密钥' });
  const newSessionToken = () => randomBytes(24).toString('hex');

  /** One login attempt against the shared throttle; `check` decides success and the identity it grants. */
  async function attemptLogin(req, check, error = 'BAD_CREDENTIALS') {
    const key = clientKey(req);
    const time = now();
    const state = failures.get(key);
    if (state && state.count >= ADMIN_LOGIN_MAX_FAILURES && time < state.until) {
      return { ok: false, status: 429, error: 'TOO_MANY_ATTEMPTS', retryAfterMs: state.until - time };
    }
    if (state && time >= state.until) failures.delete(key);
    const identity = await check();
    if (!identity) {
      const next = failures.get(key) || { count: 0, until: 0 };
      next.count++;
      next.until = time + ADMIN_LOGIN_WINDOW_MS;
      failures.set(key, next);
      log.warn?.(`[admin] 登录失败 source=${key} (${next.count}/${ADMIN_LOGIN_MAX_FAILURES})`);
      return { ok: false, status: 401, error };
    }
    failures.delete(key);
    const token = newSessionToken();
    sessions.set(token, { ...identity, at: time });
    if (identity.kind === 'account') {
      const set = accountSessions.get(identity.id) || new Set();
      set.add(token);
      accountSessions.set(identity.id, set);
    }
    while (sessions.size > ADMIN_SESSION_MAX) {
      const oldest = sessions.keys().next().value;
      sessions.delete(oldest);
      for (const set of accountSessions.values()) set.delete(oldest);
    }
    log.info?.(`[admin] 登录成功 ${identity.kind === 'owner' ? '主密钥' : `账号 ${identity.id}`} source=${key}`);
    return { ok: true, identity, cookie: `${ADMIN_COOKIE}=${token}; ${cookieFlags(req)}` };
  }

  /** Login with the shared secret: the owner identity (the operator who manages the accounts). */
  function login(req, candidate) {
    return attemptLogin(req, () => (enabled && secretEquals(String(candidate ?? ''), secret) ? ownerIdentity() : null), 'BAD_SECRET');
  }

  /** Login with a named operator account (server/adminAccounts.js). */
  async function loginAccount(req, id, password) {
    if (!enabled) return { ok: false, status: 401, error: 'UNAVAILABLE' };
    if (!adminAccountsAvailable()) return { ok: false, status: 503, error: 'UNAVAILABLE' };
    return attemptLogin(req, async () => {
      const found = await adminAccounts.authenticate(id, password);
      return found ? { kind: 'account', id: found.id, name: found.name } : null;
    });
  }

  const loggedOut = (req) => `${ADMIN_COOKIE}=; ${cookieFlags(req)}; Max-Age=0`;

  /** End every session of one operator account (a password reset, a ban or a deletion). */
  function dropAccountSessions(id) {
    const set = accountSessions.get(id);
    if (!set) return;
    for (const token of set) sessions.delete(token);
    accountSessions.delete(id);
  }

  /**
   * Who this request is: the owner (Bearer secret or an owner cookie) or a named operator account, or null.
   * @param {any} req
   * @returns {{ kind: 'owner'|'account', id: string, name: string }|null}
   */
  function identity(req) {
    if (!enabled) return null;
    const auth = String(req?.headers?.authorization || '');
    if (auth.startsWith('Bearer ')) return secretEquals(auth.slice(7).trim(), secret) ? ownerIdentity() : null;
    const session = sessions.get(cookies(req)[ADMIN_COOKIE] || '');
    return session ? { kind: session.kind, id: session.id, name: session.name } : null;
  }

  /** Back-compat boolean: every authenticated request also carries an identity (identity() returns it). */
  function authenticate(req) { return !!identity(req); }

  /** A room as the console shows it: the public room state plus the running match's phase, round and fixed groups. */
  function roomView(room) {
    const state = room.toState();
    const match = room.match;
    const view = {
      code: state.code, mode: state.mode, difficulty: state.difficulty, capacity: state.capacity,
      inMatch: state.inMatch, maxAiPerRoom: state.maxAiPerRoom, aiPicksLast: state.aiPicksLast,
      hostId: state.hostId, ageMs: Math.max(0, now() - (room.createdAt || now())),
      humans: state.seats.filter((s) => s && !s.isBot).length,
      bots: state.seats.filter((s) => s && s.isBot).length,
      ready: state.seats.filter((s) => s && s.ready).length,
      spectators: state.spectators.length,
      seats: state.seats.map((s) => (s ? { seat: s.seat, name: s.name, isBot: s.isBot, ready: s.ready, connected: s.connected } : null)),
    };
    if (match) {
      view.phase = match.phase;
      view.round = match.round;
      view.solo = !!match.isSolo;
      view.paused = !!match.paused;
      view.matchStartedAt = match.startedAt || null;
      // the fixed A–E pool groups (docs/PLAYER_CAPACITY.md) — what the client draws as group letters
      view.poolGroups = Array.isArray(match.poolGroups)
        ? match.poolGroups.map((g) => ({ id: g.id, playerIds: (g.playerIds || []).slice(), scale: g.scale }))
        : [];
      view.matchCount = room.matchCount || 0;
    }
    return view;
  }

  function rooms() {
    const list = [...(lobby?.rooms?.values?.() || [])].map(roomView);
    list.sort((a, b) => a.code.localeCompare(b.code));
    return { rooms: list, at: now() };
  }

  function overview() {
    const mem = process.memoryUsage();
    const stats = lobby?.stats?.() || { rooms: 0, matches: 0, humans: 0, bots: 0, spectators: 0 };
    let connected = 0;
    let sessions = 0;
    for (const session of registry?.byPlayerId?.values?.() || []) {
      sessions++;
      if (session.connected) connected++;
    }
    const emergency = bandwidthEmergency?.status?.() || null;
    return {
      at: now(),
      version: { app: APP_VERSION, protocol: PROTOCOL_VERSION, build: build(), node: process.version },
      host: { platform: process.platform, arch: process.arch, hostname: os.hostname(), cpuCount: os.cpus().length,
        loadavg: process.platform === 'win32' ? null : os.loadavg().map((v) => Math.round(v * 100) / 100),
        uptimeSec: Math.round(process.uptime()) },
      process: { startedAt, uptimeSec: Math.round((now() - startedAt) / 1000),
        rssMb: Math.round((mem.rss / 1048576) * 10) / 10, heapUsedMb: Math.round((mem.heapUsed / 1048576) * 10) / 10,
        heapTotalMb: Math.round((mem.heapTotal / 1048576) * 10) / 10 },
      system: { totalMb: Math.round(os.totalmem() / 1048576), freeMb: Math.round(os.freemem() / 1048576) },
      network: { connections: network?.connectionCount ?? 0, sessions, connectedPlayers: connected,
        congestion: network?.congestion?.() || null },
      lobby: stats,
      maintenance: emergency ? { active: !!emergency.active, reason: emergency.reason || '', source: emergency.source || '',
        sinceMs: emergency.startedAt ? Math.max(0, now() - emergency.startedAt) : 0, retryAt: emergency.retryAt || 0 } : null,
      assetCache: assetCache ? { required: !!(lobby?.requireAssetCache), limits: lobby?.assetCacheLimits ?? null,
        summary: safe(() => assetCache.currentSummary?.() ?? assetCache.summary?.() ?? null) } : null,
      settings: serverSettings ? safe(() => serverSettings.get?.() ?? null) : null,
      // list() returns { revision, pinnedId, items }, NOT an array — `.length` on it was always undefined.
      announcements: announcementsAvailable()
        ? safe(() => { const l = announcements.list(); return { count: (l.items || []).length, pinnedId: l.pinnedId || null }; })
        : null,
      logs: { buffered: ring.size, lastSeq: ring.lastSeq },
    };
  }

  /** Any admin action must never take the server down: run it and report a failure as data. */
  function safe(fn) { try { return fn(); } catch (error) { return { error: String(error?.message || error) }; } }

  /**
   * A message from the operator to every connected player: a toast (immediate) and a CUSTOM ticker line (kept in the
   * strip). The frames are the ones the client already knows (public/js/main.js m.toast / m.ticker).
   * @param {string} text @param {'info'|'success'|'warn'|'error'} kind
   */
  function broadcast(text, kind = 'info') {
    const clean = String(text ?? '').trim().slice(0, ADMIN_BROADCAST_TEXT_MAX);
    if (!clean) return { ok: false, error: 'EMPTY_TEXT' };
    const tone = ['info', 'success', 'warn', 'error'].includes(kind) ? kind : 'info';
    const toast = { t: 'm.toast', kind: tone, text: clean };
    const ticker = { t: 'm.ticker', text: clean.slice(0, 200), id: null, type: 'CUSTOM', priority: 0, playerId: null };
    let sent = 0;
    for (const [ws, conn] of network?.conns || []) {
      if (conn?.closing) continue;
      send(ws, toast); send(ws, ticker); sent++;
    }
    log.info?.(`[admin] 全服广播（${tone}）→ ${sent} 个连接：${clean}`);
    return { ok: true, connections: sent, kind: tone };
  }

  /**
   * Turn the server's own protection on or off. Reused rather than reimplemented: `bandwidthEmergency.trip` refuses new
   * rooms and joins and freezes running matches, and every client already renders that state.
   *
   * `autoResume: false` on purpose: a maintenance window ends when the operator says so, not after `autoResumeMs`.
   *
   * NOTE for callers: tripping closes public HTTP connections, so the request that triggered it can be one of them.
   * server/http/admin.js therefore flushes its answer first and calls this from the response's `finish` handler.
   * @param {boolean} on
   */
  function setMaintenance(on) {
    if (!bandwidthEmergency) return { ok: false, error: 'UNAVAILABLE' };
    if (on) {
      const tripped = bandwidthEmergency.trip('maintenance', { source: 'admin', autoResume: false });
      log.info?.(`[admin] 维护模式开启（${tripped ? '已生效' : '此前已生效'}）`);
      return { ok: true, active: true, changed: !!tripped };
    }
    const resumed = bandwidthEmergency.resume();
    log.info?.(`[admin] 维护模式关闭（${resumed ? '已恢复' : '此前未开启'}）`);
    return { ok: true, active: false, changed: !!resumed };
  }

  /** Whether this deployment can be put into maintenance at all (no bandwidth control → no switch). */
  const maintenanceAvailable = () => !!bandwidthEmergency;

  /** Close one room: its humans and spectators get room.closed and return to the lobby. */
  function closeRoom(code) {
    const room = lobby?.getRoom?.(code);
    if (!room) return { ok: false, error: 'NO_SUCH_ROOM' };
    safe(() => lobby.disposeRoom(room, 'admin'));
    log.info?.(`[admin] 关闭房间 ${room.code}`);
    return { ok: true, code: room.code };
  }

  // ---- accounts (the operator's account console) ----------------------------------------------------
  //
  // The account store is optional: a deployment without accounts (or with the store failing to load) answers
  // UNAVAILABLE instead of pretending the console is empty.

  const accountsAvailable = () => !!accounts && typeof accounts.list === 'function';

  /** The accounts, optionally filtered by a name fragment. */
  async function listAccounts(query = '') {
    if (!accountsAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const result = await accounts.list({ query });
    return { ok: true, ...result, at: now() };
  }

  /** Set a new password for one account; its tokens are dropped, so every device logs in again. */
  async function resetAccountPassword(username, password) {
    if (!accountsAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const result = await accounts.setPassword(username, password);
    if (result.ok) log.info?.(`[admin] 重置了账号 ${result.account.username} 的密码`);
    return result;
  }

  /** Ban or unban an account. */
  async function setAccountBanned(username, banned, reason = '') {
    if (!accountsAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const result = await accounts.setBanned(username, { banned, reason });
    if (result.ok) log.info?.(`[admin] ${banned ? '封禁' : '解封'}了账号 ${result.account.username}`);
    return result;
  }

  /** Delete an account for good. */
  async function deleteAccount(username) {
    if (!accountsAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const result = await accounts.remove(username);
    if (result.ok) log.info?.(`[admin] 删除了账号 ${result.username}`);
    return result;
  }

  // ---- operator accounts (the 运维后台's own multi-operator accounts, docs/ADMIN.md) ---------------------
  //
  // Only the owner (the ADMIN_SECRET holder) manages these: creating an account is handing out console access, so it
  // stays a deliberate act by the operator who configured the server. The console itself works with any account.

  const adminAccountsAvailable = () => !!adminAccounts && typeof adminAccounts.authenticate === 'function';

  /** Whether this identity may manage the operator accounts (the owner only). */
  const isOwner = (identity) => !!identity && identity.kind === 'owner';

  /** The operator accounts: id, name, timestamps, disabled. Never a hash, a salt or a token. */
  async function listOperators() {
    if (!adminAccountsAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const result = await adminAccounts.list();
    return { ok: true, ...result, at: now() };
  }

  /** Create one operator account. The id is also the label players see under a published announcement. */
  async function createOperator({ id, password, name }) {
    if (!adminAccountsAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const result = await adminAccounts.create({ id, password, name: name === '' ? undefined : name });
    if (result.ok) log.info?.(`[admin] 创建运维账号 ${result.account.id}`);
    return result;
  }

  /** Set a new password for one operator account; its sessions end, so it logs in again. */
  async function setOperatorPassword(id, password) {
    if (!adminAccountsAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const result = await adminAccounts.setPassword(id, password);
    if (result.ok) { dropAccountSessions(result.account.id); log.info?.(`[admin] 重置了运维账号 ${result.account.id} 的密码`); }
    return result;
  }

  /** Disable (or re-enable) one operator account; disabling also ends its sessions. */
  async function setOperatorDisabled(id, disabled) {
    if (!adminAccountsAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const result = await adminAccounts.setDisabled(id, disabled);
    if (result.ok && disabled) dropAccountSessions(result.account.id);
    if (result.ok) log.info?.(`[admin] ${disabled ? '停用' : '恢复'}了运维账号 ${result.account.id}`);
    return result;
  }

  /** Delete one operator account and end its sessions. */
  async function deleteOperator(id) {
    if (!adminAccountsAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const result = await adminAccounts.remove(id);
    if (result.ok) { dropAccountSessions(result.id); log.info?.(`[admin] 删除了运维账号 ${result.id}`); }
    return result;
  }

  // ---- announcements (the operator's公告 console) ------------------------------------------------------
  //
  // Every write goes through the shared AnnouncementStore, not a parallel path: the CLI (tools/announcements.mjs) and
  // this console then produce the same hash-verified index. A publication keeps its id forever, but its title and body
  // can be corrected (update), and the identity that published it is recorded in `author` — players see which operator
  // a notice came from. Failures are returned as `error` text, never thrown: an operator's typo must not take the
  // server down.

  const announcementsAvailable = () => !!announcements && typeof announcements.list === 'function';

  /** The announcement catalog plus the current pinned id. */
  function listAnnouncements() {
    if (!announcementsAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const result = safe(() => announcements.list());
    if (result?.error) return { ok: false, error: result.error };
    const items = (result?.items || []).map((item) => ({
      ...item,
      pinned: item.id === result.pinnedId,
    }));
    return { ok: true, revision: result.revision || '', pinnedId: result.pinnedId || null, items, at: now() };
  }

  /** One announcement's verified Markdown body, or null for an unknown/unreadable id. */
  function readAnnouncement(id) {
    if (!announcementsAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const item = safe(() => announcements.read(String(id || '')));
    if (!item || item.error) return { ok: false, error: item?.error || 'NOT_FOUND' };
    return { ok: true, item };
  }

  /**
   * Publish a new announcement. `id` may be omitted (the store generates one); `pin` also makes it the sole pinned one.
   * `author` is the logged-in identity's id, recorded so players see which operator published it.
   * @param {{ id?: string, title?: string, markdown?: string, pin?: boolean, author?: string|null }} input
   */
  function publishAnnouncement(input) {
    if (!announcementsAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const result = safe(() => announcements.publish({
      id: input.id === undefined || input.id === '' ? undefined : String(input.id),
      title: String(input.title ?? ''),
      markdown: String(input.markdown ?? ''),
      pin: input.pin === true,
      author: typeof input.author === 'string' ? input.author : null,
    }));
    if (result?.error) return { ok: false, error: result.error };
    const who = result.author ? `（${result.author}）` : '';
    log.info?.(`[admin] ${result.author || 'CLI'} 发布公告 ${result.id}${input.pin === true ? '（并置顶）' : ''}${who}：${result.title}`);
    return { ok: true, item: result };
  }

  /**
   * Correct an already published announcement: the id, its position and its publication date survive, only the title
   * and the Markdown change. `author` is filled in when a publication without a recorded operator is edited.
   * @param {string} id @param {{ title?: string, markdown?: string, author?: string|null }} input
   */
  function updateAnnouncement(id, input) {
    if (!announcementsAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const result = safe(() => announcements.update(String(id || ''), {
      title: String(input.title ?? ''),
      markdown: String(input.markdown ?? ''),
      author: typeof input.author === 'string' ? input.author : null,
    }));
    if (result?.error) return { ok: false, error: result.error };
    log.info?.(`[admin] ${input.author || 'CLI'} 修改公告 ${result.id}：${result.title}`);
    return { ok: true, item: result };
  }

  /** Make one announcement the pinned one (the store keeps at most one). */
  function pinAnnouncement(id) {
    if (!announcementsAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const result = safe(() => announcements.pin(String(id || '')));
    if (result?.error) return { ok: false, error: result.error };
    log.info?.(`[admin] 置顶公告 ${id}`);
    return { ok: true };
  }

  /** Drop the pinned announcement; the catalog is untouched. */
  function unpinAnnouncement() {
    if (!announcementsAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const result = safe(() => announcements.unpin());
    if (result?.error) return { ok: false, error: result.error };
    log.info?.('[admin] 取消公告置顶');
    return { ok: true };
  }

  /**
   * Notify currently connected players about an ALREADY published announcement. Delivery is the spool the running
   * server polls (~1s), so success means "written", not "delivered" — the operator's console says the same.
   * @param {string} id
   */
  async function notifyAnnouncement(id) {
    if (!announcementsAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const clean = String(id || '').trim();
    if (!clean) return { ok: false, error: 'EMPTY_ID' };
    let command;
    try { command = await enqueueAnnouncementNotice({ store: announcements, id: clean, log }); }
    catch (error) { return { ok: false, error: String(error?.message || error) }; }
    log.info?.(`[admin] 提交公告通知 ${clean}`);
    return { ok: true, msgid: command.msgid };
  }

  // ---- OneBot 群招募 (docs/ADMIN.md §4.4) ----------------------------------------------------------------
  //
  // The forward-WS OneBot client (server/onebot.js) is optional (tests, deployments without the feature). The console
  // reads config + live status in one answer and never sees the access token: only `tokenSet`. A save persists through
  // the shared store (the same file the boot reads), re-evaluates the connection at once and refreshes the rooms'
  // room.state.recruit flag, so a running server picks the change up without a restart.

  const onebotAvailable = () => !!onebot && typeof onebot.broadcast === 'function' && typeof onebot.updateConfig === 'function';

  /** The masked config + live status, or UNAVAILABLE without the feature. */
  function onebotInfo() {
    if (!onebotAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const cfg = onebot.config?.get?.() || {};
    return { ok: true,
      config: {
        enabled: cfg.enabled === true, mode: cfg.mode === 'server' ? 'server' : 'client',
        url: cfg.url || '', tokenSet: !!cfg.token,
        groups: Array.isArray(cfg.groups) ? [...cfg.groups] : [],
        template: cfg.template || '', cooldownSec: Number.isInteger(cfg.cooldownSec) ? cfg.cooldownSec : 60,
        linkBase: cfg.linkBase || '',
      },
      status: safe(() => onebot.status() || null), at: now() };
  }

  /**
   * Validate + persist a config patch, re-evaluate the connection and refresh the rooms' recruit flag. `token` absent =
   * keep the stored one; `token: ''` = clear it.
   * @param {Record<string, unknown>} patch @param {string} actorId
   */
  async function updateOnebotConfig(patch, actorId) {
    if (!onebotAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const clean = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : null;
    if (!clean) return { ok: false, error: 'BAD_BODY' };
    /** @type {Record<string, unknown>} */
    const fields = {};
    for (const key of ['enabled', 'mode', 'url', 'groups', 'template', 'cooldownSec', 'linkBase']) if (Object.hasOwn(clean, key)) fields[key] = clean[key];
    if (Object.hasOwn(clean, 'token')) fields.token = String(clean.token ?? '');
    let next;
    try { next = await onebot.updateConfig(fields); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
    try { lobby?.refreshRecruitFlags?.(); } catch { /* a room refresh must not fail the save */ }
    log.info?.(`[admin] ${actorId} 保存了 OneBot 配置（${next.mode === 'server' ? '反向' : '正向'}，enabled=${next.enabled}，群 ${next.groups.length} 个，冷却 ${next.cooldownSec}s）`);
    return { ok: true, config: { enabled: next.enabled, mode: next.mode, url: next.url, tokenSet: !!next.token, groups: [...next.groups], template: next.template, cooldownSec: next.cooldownSec, linkBase: next.linkBase } };
  }

  /** Drop the reconnect backoff and dial now. */
  function onebotReconnect() {
    if (!onebotAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    safe(() => onebot.reconnectNow());
    log.info?.('[admin] 手动重连 OneBot');
    return { ok: true };
  }

  /** A fixed test line to every configured group: proof that endpoint, token and membership all work. */
  async function onebotTestSend() {
    if (!onebotAvailable()) return { ok: false, error: 'UNAVAILABLE' };
    const res = await onebot.broadcast('【卫戍协议：盟约】这是一条 OneBot 测试消息。如果你在群里看到它，说明招募通道正常。');
    log.info?.(`[admin] OneBot 测试消息：${res.sent}/${res.total}${res.failed?.length ? `（失败：${res.failed.map((f) => `${f.group}: ${f.error}`).join('; ')}）` : ''}`);
    return { ok: res.sent > 0, ...res };
  }

  return {
    enabled, problem, secretSource,
    identity, authenticate, login, loginAccount, loggedOut,
    overview, rooms, closeRoom, broadcast, setMaintenance, maintenanceAvailable,
    accountsAvailable, listAccounts, resetAccountPassword, setAccountBanned, deleteAccount,
    adminAccountsAvailable, isOwner,
    listOperators, createOperator, setOperatorPassword, setOperatorDisabled, deleteOperator,
    announcementsAvailable, listAnnouncements, readAnnouncement,
    publishAnnouncement, updateAnnouncement, pinAnnouncement, unpinAnnouncement, notifyAnnouncement,
    onebotAvailable, onebotInfo, updateOnebotConfig, onebotReconnect, onebotTestSend,
    /** @param {number} since @param {number} limit */
    logs: (since, limit) => ({ ...ring.list(since, limit), at: now() }),
    /** Diagnostics for the boot line; never includes the secret. */
    status: () => ({ enabled, problem, secretSource }),
  };
}
