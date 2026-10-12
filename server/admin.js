// server/admin.js — 运维后台 (docs/ADMIN.md): a read-mostly HTTP console over a running server.
//
// Design notes worth keeping:
//   * The panel is DISABLED unless ADMIN_SECRET (or ADMIN_SECRET_FILE) is set to at least ADMIN_MIN_SECRET_LEN
//     characters. There is no default password: a forgotten environment variable must fail closed, never open a public
//     console with a guessable secret (the fork this feature came from shipped `stronghold-admin-2026` as a fallback).
//   * Authenticating with `Authorization: Bearer <secret>` compares in constant time. The browser logs in once at
//     POST /api/admin/login and then carries a per-process random cookie token, so the secret itself never lands in a
//     cookie, a log line or the browser history.
//   * Every route is answered BEFORE the bandwidth-emergency gate (server/http/routes.js), because an operator needs the
//     console exactly when the server is protecting itself.
//   * Read-only where the repository already decided: serverSettings.js states that per-server settings have no HTTP
//     administration endpoint — the panel DISPLAYS them and the CLI (tools/server-settings.mjs) writes them.
//     THIS FORK'S EXTENSION (2026-10-12, the owner's decision): the **content-pack policy** is the one exception. Mods are
//     an operational switch an owner flips while running a server (which packs this server loads, and whether to confirm
//     one that is outside its app range), and every change is authenticated, logged and written through the same atomic
//     writer the CLI uses (serverSettings.js `writeServerSettings`). Everything else stays CLI-only.
//
// i18n-ignore-file: operator-facing administration API and logs, never player-facing UI text
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { APP_VERSION, PROTOCOL_VERSION } from '../shared/constants.js';
import { isIdentityPack } from '../shared/contentTag.js';
import { writeServerSettings } from './serverSettings.js';
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

/** The cookie value used while this process runs; never the secret itself. */
const newSessionToken = () => randomBytes(24).toString('hex');

/**
 * The operator console service. Read-only except for three deliberate actions: a message to every connected player, the
 * maintenance switch (the server's own bandwidth-emergency gate, reused so clients already render it), and closing one
 * room.
 * @param {{
 *   enabled: boolean, problem?: string, secretSource?: 'env'|'file'|null, secret: string|null,
 *   lobby: any, network: any, registry: any, bandwidthEmergency?: any, assetCache?: any,
 *   serverSettings?: any, announcements?: any, ring: ReturnType<typeof createLogRing>,
 *   log?: { info?: Function, warn?: Function, error?: Function, debug?: Function },
 *   startedAt?: number, now?: () => number, build?: () => string,
 * }} deps
 */
export function createAdminService(deps) {
  const {
    enabled, problem = '', secretSource = null, secret = null,
    lobby, network, registry, bandwidthEmergency = null, assetCache = null,
    serverSettings = null, announcements = null, packs = null, settingsDir = null, serverMods = null,
    ring, log = console, startedAt = Date.now(), now = Date.now, build = () => '',
  } = deps;
  const sessionToken = enabled ? newSessionToken() : '';
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

  /**
   * Whether this request carries a valid credential: the per-process cookie token, or the raw secret as a bearer token
   * (scripts and `curl`).
   * @param {any} req
   */
  function authenticate(req) {
    if (!enabled) return false;
    const auth = String(req?.headers?.authorization || '');
    if (auth.startsWith('Bearer ')) return secretEquals(auth.slice(7).trim(), secret);
    const token = cookies(req)[ADMIN_COOKIE];
    return !!token && secretEquals(token, sessionToken);
  }

  /**
   * Throttled login. Returns the `Set-Cookie` value on success.
   * @param {any} req @param {unknown} candidate
   * @returns {{ ok: true, cookie: string } | { ok: false, status: number, error: string, retryAfterMs?: number }}
   */
  function login(req, candidate) {
    const key = clientKey(req);
    const time = now();
    const state = failures.get(key);
    if (state && state.count >= ADMIN_LOGIN_MAX_FAILURES && time < state.until) {
      return { ok: false, status: 429, error: 'TOO_MANY_ATTEMPTS', retryAfterMs: state.until - time };
    }
    if (state && time >= state.until) failures.delete(key);
    if (!secretEquals(String(candidate ?? ''), secret)) {
      const next = failures.get(key) || { count: 0, until: 0 };
      next.count++;
      next.until = time + ADMIN_LOGIN_WINDOW_MS;
      failures.set(key, next);
      log.warn?.(`[admin] 登录失败 source=${key} (${next.count}/${ADMIN_LOGIN_MAX_FAILURES})`);
      return { ok: false, status: 401, error: 'BAD_SECRET' };
    }
    failures.delete(key);
    log.info?.(`[admin] 登录成功 source=${key}`);
    return { ok: true, cookie: `${ADMIN_COOKIE}=${sessionToken}; ${cookieFlags(req)}` };
  }

  const loggedOut = (req) => `${ADMIN_COOKIE}=; ${cookieFlags(req)}; Max-Age=0`;

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
      announcements: announcements ? safe(() => (announcements.list?.() || []).length) : null,
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

  /**
   * 代码 mod (docs/PACKS.md §4): what `mods/` holds, which of them the owner enabled, which ones this process actually
   * loaded (and why a skipped one was skipped). Only the owner sees this, and only the owner may change it.
   */
  function modsOverview() {
    if (!serverMods) return { available: false, mods: [], skipped: [], warnings: [], policy: null };
    const pol = serverSettings?.get?.().mods || null;
    const on = new Set(pol?.enabled || []);
    return {
      available: true,
      // `enabled` is the switch as the settings say it NOW — a change made here must show up before the restart — while
      // `running`/`error` stay the facts of this process (the boot-time report, server/mods.js modsReport).
      mods: (serverMods.mods || []).map((m) => ({ ...m, enabled: on.has(m.id) })),
      skipped: serverMods.skipped || [],
      warnings: serverMods.warnings || [],
      policy: pol ? { enabled: [...pol.enabled] } : null,
    };
  }

  /**
   * Enable or disable code mods: `{ id, enabled }` for one, or `{ enabled: [...] }` for the whole list. Written through
   * serverSettings.js, so the CLI and the panel share one file and one validator.
   *
   * Always `restartRequired`: a code mod is imported once at start and cannot be unloaded from a running process, so the
   * panel says so instead of pretending a switch took effect.
   * @param {{ enabled?: string[] } | { id?: string, enabled?: boolean } | any} body
   */
  function setMods(body) {
    if (!serverMods || !settingsDir) return { ok: false, error: 'UNAVAILABLE' };
    const known = new Map((serverMods.mods || []).map((m) => [m.id, m]));
    const current = [...((serverSettings?.get?.().mods?.enabled) || [])];
    /** @type {string[]} both branches below set it before use */
    let enabled;
    if (body && typeof body === 'object' && 'id' in body) {
      const id = String(body.id || '');
      if (!known.has(id)) return { ok: false, error: 'UNKNOWN_MOD' };
      const on = body.enabled !== false;
      enabled = on ? (current.includes(id) ? current : [...current, id]) : current.filter((x) => x !== id);
    } else if (body && typeof body === 'object' && Array.isArray(body.enabled)) {
      if (Object.keys(body).some((key) => key !== 'enabled')) return { ok: false, error: 'BAD_REQUEST' };
      enabled = body.enabled.map((x) => String(x));
      for (const id of enabled) if (!known.has(id)) return { ok: false, error: 'UNKNOWN_MOD' };
    } else return { ok: false, error: 'BAD_REQUEST' };
    try {
      writeServerSettings(settingsDir, { mods: { enabled } });
    } catch (error) {
      log.warn?.(`[admin] 代码 mod 策略写入失败：${String(error?.message || error)}`);
      return { ok: false, error: 'WRITE_FAILED', message: String(error?.message || error) };
    }
    try { serverSettings?.poll?.(); } catch (error) { log.warn?.('[admin] 代码 mod 策略刷新失败', error?.message || error); }
    log.info?.(`[admin] 代码 mod 策略：启用 [${enabled.join(', ')}]（重启后生效）`);
    return { ok: true, restartRequired: true, ...modsOverview() };
  }

  /**
   * The 内容包 panel (docs/PACKS.md §4): every pack the folders hold, whether the owner's policy lets it load and why not,
   * plus the content tag of what is in force. Read-only here; `setPacks` below is the one write this fork allows.
   */
  function packsOverview() {
    if (!packs) return { available: false, packs: [], policy: null, conflicts: [], tag: '', languages: 0 };
    const view = packs.overview();
    const content = packs.content();
    return { available: true, ...view, tag: content.tag, languages: content.languages };
  }

  /**
   * Change the owner's content-pack policy: either the whole policy (`{ off, allow }`) or one pack's switch
   * (`{ id, enabled }` to load it or not, `{ id, confirmed }` to accept one outside its app range). Written through
   * serverSettings.js, so the CLI and the panel share one file and one validator; the settings poll (≤1 s) picks it up and
   * the registry re-scans at once.
   *
   * Only a pack that changes the game can be turned off (PACK_TYPES[type].identity): a language pack is part of the
   * client's own UI, and the other languages fall back to English, so it stays on.
   * @param {{ off?: string[], allow?: string[], id?: string, enabled?: boolean, confirmed?: boolean }} body
   */
  function setPacks(body) {
    if (!packs || !settingsDir) return { ok: false, error: 'UNAVAILABLE' };
    const view = packs.overview();
    const known = new Map(view.packs.map((p) => [p.id, p]));
    const current = view.policy || { off: [], allow: [] };
    /** @type {string[]} the pack ids this change touches (both branches below set it before use) */
    let touched;
    let off = [...(current.off || [])];
    let allow = [...(current.allow || [])];
    /** @param {string[]} list @param {string} id @param {boolean} on */
    const toggle = (list, id, on) => (on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id));
    if (body && typeof body === 'object' && 'id' in body) {
      const id = String(body.id || '');
      const entry = known.get(id);
      if (!entry) return { ok: false, error: 'UNKNOWN_PACK' };
      if ('enabled' in body && body.enabled === false && !isIdentityPack({ type: entry.type })) return { ok: false, error: 'LANGUAGE_LOCKED' };
      if ('enabled' in body) off = toggle(off, id, body.enabled === false);
      if ('confirmed' in body) allow = toggle(allow, id, body.confirmed === true);
      touched = [id];
    } else if (body && typeof body === 'object' && (Array.isArray(body.off) || Array.isArray(body.allow))) {
      if (Object.keys(body).some((key) => !['off', 'allow'].includes(key))) return { ok: false, error: 'BAD_REQUEST' };
      if (Array.isArray(body.off)) off = body.off.map((x) => String(x));
      if (Array.isArray(body.allow)) allow = body.allow.map((x) => String(x));
      for (const id of [...off, ...allow]) {
        const entry = known.get(id);
        if (!entry) return { ok: false, error: 'UNKNOWN_PACK' };
        if (off.includes(id) && !isIdentityPack({ type: entry.type })) return { ok: false, error: 'LANGUAGE_LOCKED' };
      }
      touched = [...off, ...allow];
    } else return { ok: false, error: 'BAD_REQUEST' };
    try {
      writeServerSettings(settingsDir, { packs: { off, allow } });
    } catch (error) {
      log.warn?.(`[admin] 内容包策略写入失败：${String(error?.message || error)}`);
      return { ok: false, error: 'WRITE_FAILED', message: String(error?.message || error) };
    }
    // Nudge the controller so the answer below already reflects the change (it would land within its own poll anyway).
    try { serverSettings?.poll?.(); } catch (error) { log.warn?.('[admin] 内容包策略刷新失败', error?.message || error); }
    // A type that is not live (`data`: the tables were fixed at start) cannot be switched while the server runs: the panel
    // says so, and the registry keeps judging it by the policy of this process (server/packs.js) so the index, the content
    // tag and the served tables never disagree.
    const restartRequired = touched.some((id) => known.get(id)?.live === false);
    log.info?.(`[admin] 内容包策略：停用 [${off.join(', ')}]，确认加载 [${allow.join(', ')}]${restartRequired ? '（含非实时类型，重启后生效）' : ''}`);
    return { ok: true, restartRequired, ...packsOverview() };
  }

  /** Close one room: its humans and spectators get room.closed and return to the lobby. */
  function closeRoom(code) {
    const room = lobby?.getRoom?.(code);
    if (!room) return { ok: false, error: 'NO_SUCH_ROOM' };
    safe(() => lobby.disposeRoom(room, 'admin'));
    log.info?.(`[admin] 关闭房间 ${room.code}`);
    return { ok: true, code: room.code };
  }

  return {
    enabled, problem, secretSource,
    authenticate, login, loggedOut,
    overview, rooms, closeRoom, broadcast, setMaintenance, maintenanceAvailable,
    packs: packsOverview, setPacks, mods: modsOverview, setMods,
    /** @param {number} since @param {number} limit */
    logs: (since, limit) => ({ ...ring.list(since, limit), at: now() }),
    /** Diagnostics for the boot line; never includes the secret. */
    status: () => ({ enabled, problem, secretSource }),
  };
}
