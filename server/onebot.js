// server/onebot.js — OneBot 11 群招募支持 (docs/ADMIN.md §4.4): the persisted configuration store, the recruit message
// template, and the OneBot connection in EITHER direction (the operator picks in the 运维后台):
//
//   * mode 'client' — 正向 WS: this process is the WebSocket CLIENT dialing the OneBot implementation's own server
//     (e.g. NapCat / Lagrange.OneBot / go-cqhttp at ws://127.0.0.1:3001), reconnecting with capped backoff.
//   * mode 'server' — 反向 WS: this process hosts /onebot/ws on its own http port and the OneBot implementation dials
//     it (for OneBot hosts without a public address). The handshake is token-authenticated (Authorization: Bearer, or
//     ?access_token=) and FAILS CLOSED: without a configured token the path answers 404, with a wrong one 401. One bot
//     at a time — a fresh connection replaces the previous one.
//
//   * The operator configures the endpoint, the access token, the target group(s) and the message template in the
//     运维后台 (runtime/onebot.json; the token is stored 0600 alongside the accounts and is NEVER sent back to the
//     console — only whether one is set). In-room players get a 招募 button (room.recruit); the server renders the
//     template with the room's facts and pushes one send_group_msg per configured group.
//   * OneBot 11 wire format (github.com/botuniverse/onebot-11): a request is
//     `{ action, params, echo }`, answered by `{ status, retcode, data, echo }` (retcode 0 ok, 1 async accepted).
//     Events carry `post_type` and no echo — ignored here: this feature only ever SENDS.
//   * Failures must never reach the game loop: the client never throws out of a socket event, a send reports per-group
//     results as data, and an unanswered API call times out.
//
// i18n-ignore-file: operator configuration and QQ-bound text, never player-facing UI strings
import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { DIFFICULTY_NAMES } from '../shared/constants.js';

/** The shipped template (the operator can replace every word of it in the console). `{link}` needs the 链接基址. */
export const DEFAULT_RECRUIT_TEMPLATE = '【卫戍协议：盟约】房主 {host} 的房间 {room} 招募中（{players}/{capacity} 人），难度 {difficulty}。点击直接加入：{link}\n或在游戏大厅输入密钥 {room} 加入！';

export const ONEBOT_TEMPLATE_MAX = 600;
export const ONEBOT_GROUPS_MAX = 10;
export const ONEBOT_URL_MAX = 200;
export const ONEBOT_TOKEN_MAX = 128;
export const ONEBOT_LINK_BASE_MAX = 200;
/** Reverse WebSocket endpoint path on the game server's own port (the OneBot implementation dials it). */
export const ONEBOT_SERVER_PATH = '/onebot/ws';

/** An empty template is refused (the message would be useless), the default is restored by passing undefined. */
export function validRecruitTemplate(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return text.length > 0 && [...text].length <= ONEBOT_TEMPLATE_MAX && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text);
}

export function validOneBotUrl(value) {
  return typeof value === 'string' && value.length <= ONEBOT_URL_MAX && /^wss?:\/\/[^\s]+$/i.test(value);
}

export function validOneBotToken(value) {
  return typeof value === 'string' && value.length <= ONEBOT_TOKEN_MAX && !/[\u0000-\u001f]/.test(value);
}

/** 'client' = forward WS (this server dials the OneBot implementation), 'server' = reverse WS (the OneBot
 * implementation dials /onebot/ws on this server's own port — for OneBot hosts WITHOUT a public address). */
export function validOneBotMode(value) {
  return value === 'client' || value === 'server';
}

/** The public base URL recruit messages build their clickable join link with; '' disables the {link} placeholder. */
export function validLinkBase(value) {
  return typeof value === 'string' && value.length <= ONEBOT_LINK_BASE_MAX
    && (value === '' || (/^https?:\/\/\S+$/i.test(value) && !/[\u0000-\u001f]/.test(value)));
}

/** One target group: a decimal QQ group number as a string (5–20 digits), unique across the list. */
export function validGroupList(value) {
  if (!Array.isArray(value) || value.length > ONEBOT_GROUPS_MAX) return false;
  return value.every((g) => typeof g === 'string' && /^\d{5,20}$/.test(g)) && new Set(value).size === value.length;
}

export function validCooldownSec(value) {
  return Number.isInteger(value) && value >= 0 && value <= 3600;
}

const FIELDS = ['enabled', 'mode', 'url', 'token', 'groups', 'template', 'cooldownSec', 'linkBase'];

/**
 * The whole file must be valid (a partial manual edit is refused rather than half-applied), so `update()` merges the
 * patch onto the previous config and re-checks everything.
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>|null} null = invalid
 */
function checkedConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1
    || Object.keys(raw).some((key) => key !== 'version' && !FIELDS.includes(key))) return null;
  const out = {
    enabled: raw.enabled === true,
    mode: validOneBotMode(raw.mode) ? raw.mode : 'client',
    url: typeof raw.url === 'string' ? raw.url : '',
    token: validOneBotToken(raw.token) ? raw.token : null,
    groups: validGroupList(raw.groups) ? [...raw.groups] : null,
    template: validRecruitTemplate(raw.template) ? raw.template : null,
    cooldownSec: validCooldownSec(raw.cooldownSec) ? raw.cooldownSec : null,
    // files written before the reverse mode / link existed (no mode, no linkBase) stay valid: a missing new field is
    // its default, only a PRESENT-but-invalid value refuses the file
    linkBase: raw.linkBase == null ? '' : (validLinkBase(raw.linkBase) ? raw.linkBase : null),
  };
  if (out.url && !validOneBotUrl(out.url)) return null;
  for (const key of ['token', 'groups', 'template', 'cooldownSec', 'linkBase']) if (out[key] === null) return null;
  out.url = out.url || '';
  out.linkBase = out.linkBase || '';
  // the forward-WS url only drives the client mode; server mode needs nothing but the token and the groups
  if (out.mode === 'client' && !out.url) { out.groups = []; out.enabled = false; }
  return out;
}

/**
 * The persisted OneBot configuration (runtime/onebot.json beside the accounts). Load once, then explicit updates from
 * the console persist atomically and hand the new config back for the client to apply.
 * @param {{ file?: string, root?: string, log?: { warn?: Function, error?: Function } }} [opts]
 */
export function createOneBotConfig({ file, log = console } = {}) {
  const filePath = file || path.resolve('runtime', 'onebot.json');
  let state = Object.freeze({ version: 1, enabled: false, mode: 'client', url: '', token: '', groups: [], template: DEFAULT_RECRUIT_TEMPLATE, cooldownSec: 60, linkBase: '' });
  const ready = (async () => {
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') log.error?.(`[onebot] cannot read ${filePath}: ${e.message}`);
      return;
    }
    const checked = checkedConfig(raw);
    if (!checked) { log.error?.(`[onebot] ${filePath} 格式无效，忽略该文件（后台保存一次即可修复）`); return; }
    state = Object.freeze({ version: 1, mode: 'client', template: DEFAULT_RECRUIT_TEMPLATE, cooldownSec: 60, linkBase: '', ...checked });
  })();

  async function persist(next) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, filePath);
  }

  return {
    ready,
    file: filePath,
    get: () => state,
    /**
     * Validate a patch against the CURRENT config and persist it whole. `token` follows the console's rule: a missing
     * key keeps the stored one, an empty string clears it. Throws RangeError on an invalid value — the caller (the
     * admin endpoint) turns that into a 400.
     * @param {Record<string, unknown>} patch
     */
    async update(patch) {
      const merged = {
        version: 1,
        enabled: state.enabled, mode: state.mode, url: state.url, token: state.token,
        groups: [...state.groups], template: state.template, cooldownSec: state.cooldownSec, linkBase: state.linkBase,
      };
      for (const [key, value] of Object.entries(patch || {})) {
        if (!FIELDS.includes(key)) throw new RangeError(`未知字段 ${key}`);
        if (key === 'enabled') merged.enabled = value === true;
        else if (key === 'mode') { if (!validOneBotMode(value)) throw new RangeError('连接方式必须为 client（正向）或 server（反向）'); merged.mode = value; }
        else if (key === 'url') { const v = String(value ?? ''); if (v && !validOneBotUrl(v)) throw new RangeError('OneBot 地址必须为 ws:// 或 wss:// 开头'); merged.url = v; }
        else if (key === 'token') { if (!validOneBotToken(value === undefined ? '' : String(value))) throw new RangeError(`Token 至多 ${ONEBOT_TOKEN_MAX} 个字符`); merged.token = String(value); }
        else if (key === 'groups') { if (!validGroupList(value)) throw new RangeError(`群号必须为 ${ONEBOT_GROUPS_MAX} 个以内的 5–20 位数字字符串`); merged.groups = [...value]; }
        else if (key === 'template') { if (!validRecruitTemplate(value)) throw new RangeError(`招募模板不能为空，至多 ${ONEBOT_TEMPLATE_MAX} 字`); merged.template = String(value).trim(); }
        else if (key === 'cooldownSec') { if (!validCooldownSec(value)) throw new RangeError('冷却必须为 0–3600 的整数秒'); merged.cooldownSec = value; }
        else if (key === 'linkBase') { const v = String(value ?? '').trim(); if (!validLinkBase(v)) throw new RangeError('链接基址必须为 http(s):// 开头，或留空'); merged.linkBase = v; }
      }
      if (merged.enabled && merged.mode === 'client' && !merged.url) throw new RangeError('正向模式启用前必须填写 OneBot 的 ws(s):// 地址');
      if (merged.enabled && merged.mode === 'server' && !merged.token) throw new RangeError('反向模式暴露在服务器端口上，启用前必须设置 Access Token');
      const checked = checkedConfig(merged);
      if (!checked) throw new RangeError('OneBot 配置无效');
      const next = Object.freeze({ version: 1, ...checked });
      await persist(next);
      state = next;
      return next;
    },
  };
}

/**
 * Render the recruit template with a room's facts. `{placeholder}` is replaced when known and left alone when not, so
 * an operator's literal "{host}" typo never deletes text. Known: room host players capacity difficulty mode link.
 * `{link}` is the clickable join link (`linkBase/?room=CODE`), '' while the operator has not configured a base URL.
 * @param {string} template
 * @param {{ room: string, host: string, players: number, capacity: number, difficulty: string, mode: string, link: string }} facts
 */
export function renderRecruitTemplate(template, facts) {
  return template.replace(/\{(room|host|players|capacity|difficulty|mode|link)\}/g, (_, key) => String(facts[key] ?? ''));
}

/** The template facts of one room (lobby.js): the names the QQ group sees. */
export function recruitFacts(room, linkBase = '') {
  const host = room.seats.find((s) => s && s.playerId === room.hostId);
  return {
    room: room.code,
    host: host?.name || '',
    players: room.activeHumans().length,
    capacity: room.capacity,
    difficulty: String(DIFFICULTY_NAMES[room.difficulty] || room.difficulty),
    mode: room.mode === 'solo' ? '独立模拟' : '同盟模拟',
    link: linkBase ? `${String(linkBase).replace(/\/+$/, '')}/?room=${encodeURIComponent(room.code)}` : '',
  };
}

/**
 * The forward-WS OneBot 11 client. Life cycle: `start()` dials when the config says enabled, keeps the connection up
 * with capped backoff, and `applyConfig()` re-evaluates after every console save (endpoint or token change = redial).
 * @param {{
 *   config: { get: () => { enabled: boolean, url: string, token: string, groups: string[], template: string, cooldownSec: number } },
 *   log?: { info?: Function, warn?: Function, error?: Function },
 *   now?: () => number,
 *   WebSocketImpl?: new (url: string, opts: object) => any,
 *   connectTimeoutMs?: number, apiTimeoutMs?: number, retryBaseMs?: number, retryMaxMs?: number,
 * }} opts
 */
export function createOneBotClient({ config, log = console, now = Date.now, WebSocketImpl = WebSocket,
  connectTimeoutMs = 12_000, apiTimeoutMs = 12_000, retryBaseMs = 1000, retryMaxMs = 30_000 } = {}) {
  /** @type {any} */
  let ws = null;
  let stopping = true;
  let attempt = 0;
  let clientConnected = false;
  /** The (mode, enabled, url, token) the live connection was established with, so applyConfig can tell a real change
   * from a no-op save. */
  let dialled = '';
  let retryTimer = null;
  let retryAt = 0;
  let nextEcho = 1;
  /** @type {Map<string, { resolve: Function, reject: Function, timer: any }>} */
  const pending = new Map();
  let lastError = '';
  let lastErrorAt = 0;
  let sentCount = 0;
  let lastSentAt = 0;
  // reverse mode (the OneBot implementation dials ONEBOT_SERVER_PATH on this server's own port): one bot at a time —
  // a fresh connection replaces the previous one, so a reconnecting implementation never splits the message stream
  /** @type {WebSocketServer | null} */
  let wss = null;
  let serverActive = false;
  /** @type {Set<any>} */
  const serverClients = new Set();

  const conf = () => config.get();
  const fingerprint = () => { const c = conf(); return `${c.mode}|${c.enabled ? '1' : '0'}|${c.url}|${c.token}`; };

  /** Constant-time token compare for the reverse endpoint's handshake. */
  function tokenEquals(a, b) {
    const x = Buffer.from(String(a ?? ''), 'utf8');
    const y = Buffer.from(String(b ?? ''), 'utf8');
    if (x.length === 0 || x.length !== y.length) return false;
    return timingSafeEqual(x, y);
  }

  function failPending(message) {
    for (const [echo, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
      pending.delete(echo);
    }
  }

  /** One OneBot 11 frame from either direction's socket: settle the matching pending call, ignore events. */
  function handleSocketMessage(data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.echo != null && pending.has(String(msg.echo))) {
      const entry = pending.get(String(msg.echo));
      pending.delete(String(msg.echo));
      clearTimeout(entry.timer);
      // OneBot 11 retcode: 0 ok, 1 async accepted; everything else is a failure carrying `status`/`message`.
      if (msg.retcode === 0 || msg.retcode === 1) entry.resolve({ ok: true, data: msg.data ?? null, async: msg.retcode === 1 });
      else entry.reject(new Error(`${msg.status || 'failed'} (${msg.retcode})${msg.message ? `: ${msg.message}` : ''}`));
    }
    // events (post_type) are not consumed: this feature only sends
  }

  function noteError(message) {
    lastError = String(message || 'error');
    lastErrorAt = now();
  }

  function clearRetry() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retryAt = 0;
  }

  function closeServerClients() {
    for (const socket of serverClients) { try { socket.close(4000, 'config changed'); } catch { /* already gone */ } }
    serverClients.clear();
  }

  function scheduleReconnect() {
    if (stopping) return;
    clearRetry();
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(attempt, 8));
    attempt++;
    retryAt = now() + delay;
    retryTimer = setTimeout(() => { retryTimer = null; dial(); }, delay);
    retryTimer.unref?.();
  }

  function dial() {
    if (stopping) return;
    const c = conf();
    if (!c.enabled || c.mode !== 'client' || !c.url || ws) return;
    const headers = c.token ? { Authorization: `Bearer ${c.token}` } : {};
    let socket;
    try { socket = new WebSocketImpl(c.url, { headers }); } catch (e) {
      noteError(e?.message || 'connect failed');
      scheduleReconnect();
      return;
    }
    ws = socket;
    clientConnected = false;
    const openTimer = setTimeout(() => {
      if (ws === socket && !clientConnected) { noteError(`连接超时（${Math.round(connectTimeoutMs / 1000)}s）`); try { socket.terminate(); } catch { /* already gone */ } }
    }, connectTimeoutMs);
    openTimer.unref?.();
    socket.on('open', () => {
      clearTimeout(openTimer);
      if (ws !== socket) { try { socket.close(); } catch { /* never opened */ } return; }
      clientConnected = true;
      attempt = 0;
      log.info?.(`[onebot] 已连接 ${c.url}（正向）`);
    });
    socket.on('message', (data) => handleSocketMessage(data));
    socket.on('error', (e) => {
      if (ws !== socket) return;
      noteError(e?.message || 'socket error');
    });
    socket.on('close', () => {
      clearTimeout(openTimer);
      if (ws !== socket) return;
      ws = null;
      clientConnected = false;
      failPending('OneBot 连接已断开');
      if (!stopping && conf().enabled && conf().mode === 'client') scheduleReconnect();
    });
  }

  /** Lazily create the reverse-mode WebSocketServer (its upgrade requests come through the game server's listener). */
  function ensureWss() {
    if (wss) return wss;
    wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    wss.on('connection', (socket, req) => {
      for (const old of serverClients) { try { old.close(4000, 'replaced'); } catch { /* already gone */ } }
      serverClients.clear();
      serverClients.add(socket);
      log.info?.(`[onebot] OneBot 已连入（反向）${req?.socket?.remoteAddress ? ` ${req.socket.remoteAddress}` : ''}`);
      socket.on('message', (data) => handleSocketMessage(data));
      socket.on('close', () => {
        serverClients.delete(socket);
        if (serverClients.size === 0) { failPending('OneBot 连接已断开'); log.info?.('[onebot] OneBot 连接已断开（反向）'); }
      });
      socket.on('error', () => { /* the close handler cleans up */ });
    });
    wss.on('error', (e) => log.error?.('[onebot] 反向 WS 服务错误', e?.message || e));
    return wss;
  }

  /** One connection of the current mode with a live socket, or null. Reverse mode: the newest client. */
  function activeSocket() {
    const open = (s) => s && s.readyState === OPEN;
    if (conf().mode === 'server') {
      let newest = null;
      for (const socket of serverClients) if (open(socket)) newest = socket;
      return newest;
    }
    return open(ws) && clientConnected ? ws : null;
  }

  /**
   * The http upgrade hook (server/index.js → attachWebSocket): claims exactly /onebot/ws. Authenticated with the
   * configured token (`Authorization: Bearer` header, or `?access_token=` — the two forms OneBot implementations use).
   * Fails closed: without a configured token the path answers 404, and a wrong token answers 401.
   * @param {any} req @param {{ rawPath: string, query: string } | null} parts @param {any} socket @param {any} head
   * @returns {boolean} true = this request was answered here
   */
  function upgradeHook(req, parts, socket, head) {
    if (!parts || parts.rawPath !== ONEBOT_SERVER_PATH) return false;
    socket.on('error', () => {});
    const reject = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
    };
    const c = conf();
    if (stopping || !c.enabled || c.mode !== 'server') { reject(404, 'Not Found'); return true; }
    if (!c.token) { reject(503, 'Service Unavailable'); return true; }
    const header = String(req?.headers?.authorization || '');
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : new URLSearchParams(parts.query || '').get('access_token') || '';
    if (!given || !tokenEquals(given, c.token)) {
      log.warn?.(`[onebot] 反向 WS 握手被拒绝（Token 不匹配）${req?.socket?.remoteAddress ? `：${req.socket.remoteAddress}` : ''}`);
      reject(401, 'Unauthorized');
      return true;
    }
    ensureWss().handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return true;
  }

  /** Apply the (possibly changed) configuration: redial / relisten on a change, disconnect when disabled. */
  function applyConfig() {
    if (stopping) return;
    const c = conf();
    const mark = fingerprint();
    if (!c.enabled) {
      clearRetry();
      attempt = 0;
      if (ws) { const socket = ws; ws = null; clientConnected = false; try { socket.close(); } catch { /* ignore */ } }
      closeServerClients();
      serverActive = false;
      dialled = mark;
      return;
    }
    if (c.mode === 'server') {
      clearRetry();
      attempt = 0;
      if (ws) { const socket = ws; ws = null; clientConnected = false; try { socket.close(); } catch { /* ignore */ } }
      // a config change (the token, mostly) closes the authenticated clients so they re-handshake with it
      if (!serverActive || mark !== dialled) { ensureWss(); serverActive = true; closeServerClients(); }
      dialled = mark;
      return;
    }
    if (serverActive) { closeServerClients(); serverActive = false; }
    if (mark === dialled) return;
    dialled = mark;
    attempt = 0;
    clearRetry();
    if (ws) { const socket = ws; ws = null; clientConnected = false; try { socket.close(); } catch { /* ignore */ } }
    dial();
  }

  /** One OneBot action; resolves with the implementation's answer or rejects after apiTimeoutMs. */
  const OPEN = WebSocketImpl.OPEN ?? 1;
  function call(action, params) {
    const socket = activeSocket();
    if (!socket) return Promise.reject(new Error('OneBot 未连接'));
    const echo = `sp${now().toString(36)}${(nextEcho++).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(echo);
        reject(new Error(`OneBot 响应超时（${Math.round(apiTimeoutMs / 1000)}s）`));
      }, apiTimeoutMs);
      timer.unref?.();
      pending.set(echo, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ action, params, echo }));
      } catch (e) {
        clearTimeout(timer);
        pending.delete(echo);
        reject(e);
      }
    });
  }

  return {
    /** Test seams / diagnostics. */
    get connected() { return conf().mode === 'server' ? serverClients.size > 0 : clientConnected; },
    /** The configuration store this client follows (the console reads the config through it). */
    config,
    /** The http upgrade hook for the reverse endpoint; see upgradeHook. */
    upgradeHook,
    /**
     * Send the same text to every configured group. Never throws: the per-group results come back as data, and a
     * group the API refused does not stop the others.
     * @param {string} text
     * @returns {Promise<{ ok: boolean, sent: number, total: number, failed: { group: string, error: string }[] }>}
     */
    async broadcast(text) {
      const groups = conf().groups;
      const message = [{ type: 'text', data: { text: String(text ?? '') } }];
      const results = await Promise.allSettled(groups.map((group) => call('send_group_msg', {
        group_id: Number(group), message, auto_escape: false,
      })));
      /** @type {{ group: string, error: string }[]} */
      const failed = [];
      let sent = 0;
      for (let i = 0; i < groups.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled') { sent++; continue; }
        failed.push({ group: groups[i], error: String(r.reason?.message || r.reason || 'send failed') });
      }
      if (sent > 0) { sentCount += sent; lastSentAt = now(); }
      return { ok: sent > 0 && sent === groups.length, sent, total: groups.length, failed };
    },
    /** Whether an in-room 招募 button would have anything to send to (lobby room.state `recruit` flag). */
    recruitConfig() {
      const c = conf();
      if (!c.enabled || !c.groups.length) return null;
      return { cooldownSec: c.cooldownSec };
    },
    /** The configured recruit template (Lobby.recruit renders it with the room's facts). */
    recruitTemplate() { return conf().template; },
    /** The public base URL of `{link}` in the template ('' = the placeholder renders empty). */
    recruitLinkBase() { return conf().linkBase; },
    /** Re-evaluate after a console save (a config change redials at once instead of waiting for the backoff). */
    applyConfig,
    /** The console's write path: validate + persist through the store, then re-evaluate the connection at once. */
    async updateConfig(patch) {
      const next = await config.update(patch);
      applyConfig();
      return next;
    },
    /** Drop the backoff and dial now (the console's 立即重连; server mode closes the clients for a fresh handshake). */
    reconnectNow() {
      if (stopping) return;
      attempt = 0;
      clearRetry();
      if (conf().mode === 'server') { closeServerClients(); return; }
      if (ws) { const socket = ws; ws = null; clientConnected = false; try { socket.close(); } catch { /* ignore */ } }
      dial();
    },
    start() {
      if (!stopping) return;
      stopping = false;
      dialled = '';
      applyConfig();
    },
    close() {
      stopping = true;
      clearRetry();
      failPending('OneBot 客户端已关闭');
      if (ws) { const socket = ws; ws = null; clientConnected = false; try { socket.close(); } catch { /* ignore */ } }
      closeServerClients();
      try { wss?.close(); } catch { /* ignore */ }
      wss = null;
      serverActive = false;
    },
    /** What the console shows. Never the token itself. */
    status() {
      const c = conf();
      const isServer = c.mode === 'server';
      return {
        enabled: c.enabled, mode: c.mode, url: isServer ? '' : c.url,
        path: ONEBOT_SERVER_PATH, listening: isServer && !stopping && c.enabled,
        clients: serverClients.size,
        groups: c.groups.length,
        configured: isServer ? !!c.token : !!c.url,
        connected: this.connected, connecting: !isServer && !stopping && c.enabled && !!c.url && !clientConnected,
        lastError: lastError || null, lastErrorAt: lastErrorAt || null,
        sentCount, lastSentAt: lastSentAt || null, nextRetryInMs: !isServer && retryAt ? Math.max(0, retryAt - now()) : 0,
      };
    },
    /* exposed for tests */
    __pendingCount: () => pending.size,
    __apiTimeoutMs: apiTimeoutMs,
  };
}
