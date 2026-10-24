// server/http/admin.js — the 运维后台 routes (docs/ADMIN.md), answered before the emergency gate in routes.js.
//
//   GET  /admin[/…]           → public/admin/index.html (the console; every other file under /admin/ is static)
//   GET  /api/admin/overview  → process, host, lobby, network, maintenance, settings (authenticated)
//   GET  /api/admin/rooms     → one entry per room, with the running match's phase/round and its fixed pool groups
//   GET  /api/admin/logs      → the log ring since `?since=` (authenticated)
//   GET  /api/admin/session   → who this session is (owner, or one operator account)
//   POST /api/admin/login     { secret } or { id, password } → 200 + the per-session cookie
//   POST /api/admin/logout    → 200 + a cleared cookie
//   POST /api/admin/broadcast { text, kind } → a toast + a CUSTOM ticker line to every connection
//   POST /api/admin/maintenance { on } → the server's own protection on/off (refuses new visits, freezes matches)
//   POST /api/admin/rooms/close { code } → close one room
//
//   GET  /api/admin/announcements      → the catalog (metadata + pinned id)
//   GET  /api/admin/announcements?id=   → one announcement's verified Markdown
//   POST /api/admin/announcements/publish { id?, title, markdown, pin } → publish a new one
//   POST /api/admin/announcements/update { id, title, markdown } → correct a published one (id and date survive)
//   POST /api/admin/announcements/pin { id } · /unpin {} → the sole pinned announcement
//   POST /api/admin/announcements/notify { id } → notify connected players about a published one
//
//   GET  /api/admin/operators            → the operator accounts (owner only)
//   POST /api/admin/operators/create     { id, password, name? } (owner only)
//   POST /api/admin/operators/password   { id, password } (owner only)
//   POST /api/admin/operators/disabled   { id, disabled } (owner only)
//   POST /api/admin/operators/delete     { id } (owner only)
//
//   GET  /api/admin/onebot               → the OneBot 群招募 config (token masked) + live connection status
//   POST /api/admin/onebot/config        { enabled?, url?, token?, groups?, template?, cooldownSec? } → save (token absent = keep, '' = clear)
//   POST /api/admin/onebot/reconnect     {} → drop the backoff and dial now
//   POST /api/admin/onebot/test          {} → send a fixed test line to every configured group
//
// With no ADMIN_SECRET the whole prefix answers 404: a deployment that forgot the secret has no console at all (there is
// deliberately no default password). Unauthenticated API calls answer 401; the console shell itself is public, it only
// ever draws a登录 form until the API answers.
//
// i18n-ignore-file: operator-facing administration API and logs, never player-facing UI text
import { ADMIN_ANNOUNCEMENT_BODY_MAX_BYTES, ADMIN_API_PREFIX, ADMIN_BODY_MAX_BYTES, ADMIN_UI_PATH } from '../admin.js';
import { sendError, sendJson } from './common.js';

/**
 * Read a JSON body, bounded. `undefined` = too large, `null` = malformed.
 *
 * On overflow this stops reading and resolves `undefined` WITHOUT touching the socket: the caller answers 413 and only
 * then drops the request (`res.once('finish', …)` below). Destroying the request here would kill the connection before
 * the answer is flushed, and the operator would see a network error instead of the status.
 * @param {any} req @param {number} [limit]
 * @returns {Promise<object|null|undefined>}
 */
function readJsonBody(req, limit = ADMIN_BODY_MAX_BYTES) {
  return new Promise((resolve) => {
    let size = 0;
    let over = false;
    let chunks = [];
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) { over = true; chunks = []; req.pause(); resolve(undefined); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) return;
      if (!chunks.length) { resolve({}); return; }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null);
      } catch { resolve(null); }
    });
    req.on('error', () => { if (!over) resolve(null); });
  });
}

const wantJson = (req) => {
  const accept = String(req.headers.accept || '');
  return accept.includes('application/json') || String(req.headers['content-type'] || '').includes('application/json');
};

/** The leaf names below /api/admin. Anything else is 404; a known leaf with the wrong method is 405. */
const READ_ENDPOINTS = new Set(['/overview', '/rooms', '/logs', '/session']);
const WRITE_ENDPOINTS = new Set(['/broadcast', '/maintenance', '/rooms/close']);
/** The account console's write endpoints (the list is read by GET /api/admin/accounts). */
const ACCOUNT_WRITE_ENDPOINTS = new Set(['/accounts/password', '/accounts/ban', '/accounts/delete']);
/** The announcement console's write endpoints (the catalog is read by GET /api/admin/announcements). */
const ANNOUNCEMENT_WRITE_ENDPOINTS = new Set([
  '/announcements/publish', '/announcements/update', '/announcements/pin', '/announcements/unpin', '/announcements/notify',
]);
/** The operator-account endpoints (owner only; the list is read by GET /api/admin/operators). */
const OPERATOR_WRITE_ENDPOINTS = new Set(['/operators/create', '/operators/password', '/operators/disabled', '/operators/delete']);
/** The OneBot 群招募 endpoints (the config + status are read by GET /api/admin/onebot). */
const ONEBOT_WRITE_ENDPOINTS = new Set(['/onebot/config', '/onebot/reconnect', '/onebot/test']);

/**
 * @param {{ admin: any, serveStatic: (req: any, res: any, rawPath: string, query: string) => Promise<void>,
 *           log?: { warn?: Function } }} deps
 * @returns {(req: any, res: any, parts: { rawPath: string, query: string }) => Promise<boolean>} true = answered
 */
export function createAdminHandler({ admin, serveStatic, log = console }) {
  const isUi = (path) => path === ADMIN_UI_PATH || path === `${ADMIN_UI_PATH}/` || path.startsWith(`${ADMIN_UI_PATH}/`);
  const isApi = (path) => path === ADMIN_API_PREFIX || path.startsWith(`${ADMIN_API_PREFIX}/`);

  /** @param {any} req @param {any} res @param {number} status @param {object} body */
  const json = (req, res, status, body) => sendJson(req, res, status, body);

  return async function handle(req, res, parts) {
    const path = parts.rawPath;
    if (!isUi(path) && !isApi(path)) return false;

    // No secret configured: the console does not exist (fail closed, and indistinguishable from any other 404).
    if (!admin.enabled) { sendError(req, res, 404, '未找到 · Not found'); return true; }

    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (method !== 'GET' && method !== 'POST') {
      res.setHeader('Allow', 'GET, HEAD, POST');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return true;
    }

    // ---- the console shell: public, but empty without the API ----
    if (isUi(path)) {
      if (method !== 'GET') { sendError(req, res, 405, '不支持的请求方法 · Method not allowed'); return true; }
      if (path.includes('..')) { sendError(req, res, 400, '请求地址无效 · Bad request'); return true; }
      // /admin and /admin/ → the panel; anything else under /admin/ stays a static file
      const target = path === ADMIN_UI_PATH || path === `${ADMIN_UI_PATH}/` ? `${ADMIN_UI_PATH}/index.html` : path;
      await serveStatic(req, res, target, parts.query);
      return true;
    }

    // ---- login / logout are the only unauthenticated API calls ----
    if (path === `${ADMIN_API_PREFIX}/login`) {
      if (method !== 'POST') { json(req, res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }); return true; }
      const body = await readJsonBody(req);
      if (body === undefined) { json(req, res, 413, { ok: false, error: 'BODY_TOO_LARGE' }); res.once('finish', () => req.destroy()); return true; }
      if (!body) { json(req, res, 400, { ok: false, error: 'BAD_BODY' }); return true; }
      // Two ways in: the shared secret (the owner, who manages the operator accounts) or one named account with its
      // own password. Both share one throttle and both answer the same cookie shape.
      // The account path accepts the credential as `password`, falling back to `secret`: the console's single input
      // naturally fills both, and a script that only knows `secret` keeps working.
      const accountId = typeof body.id === 'string' ? body.id.trim() : '';
      const result = accountId
        ? await admin.loginAccount(req, accountId, typeof body.password === 'string' ? body.password
          : typeof body.secret === 'string' ? body.secret : '')
        : await admin.login(req, body.secret);
      if (!result.ok) {
        res.setHeader('Cache-Control', 'no-store');
        if (result.retryAfterMs) res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
        json(req, res, result.status, { ok: false, error: result.error, retryAfterMs: result.retryAfterMs });
        return true;
      }
      res.setHeader('Set-Cookie', result.cookie);
      json(req, res, 200, { ok: true, identity: result.identity });
      return true;
    }
    if (path === `${ADMIN_API_PREFIX}/logout`) {
      if (method !== 'POST') { json(req, res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }); return true; }
      res.setHeader('Set-Cookie', admin.loggedOut(req));
      json(req, res, 200, { ok: true });
      return true;
    }

    // ---- everything else needs a credential; the session also says WHO is acting ----
    const session = admin.identity(req);
    if (!session) {
      if (wantJson(req) || isApi(path)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        json(req, res, 401, { ok: false, error: 'UNAUTHORIZED' });
      } else sendError(req, res, 401, '需要管理员密钥 · Admin secret required');
      return true;
    }

    // Dispatch by the leaf below /api/admin, so an UNKNOWN path is 404 while a KNOWN path with the wrong method is 405.
    const leaf = path.slice(ADMIN_API_PREFIX.length);

    // ---- the account console: its own leaves, so the operator's account work never shares the room endpoints ----
    if (leaf === '/accounts' || ACCOUNT_WRITE_ENDPOINTS.has(leaf)) {
      if (leaf === '/accounts') {
        if (method !== 'GET') { json(req, res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }); return true; }
        if (!admin.accountsAvailable?.()) { json(req, res, 503, { ok: false, error: 'UNAVAILABLE' }); return true; }
        const q = new URLSearchParams(parts.query);
        const result = await admin.listAccounts(q.get('q') || '');
        json(req, res, result.ok ? 200 : 503, result);
        return true;
      }
      if (method !== 'POST') { json(req, res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }); return true; }
      const body = await readJsonBody(req);
      if (body === undefined) { json(req, res, 413, { ok: false, error: 'BODY_TOO_LARGE' }); res.once('finish', () => req.destroy()); return true; }
      if (!body) { json(req, res, 400, { ok: false, error: 'BAD_BODY' }); return true; }
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      if (!username) { json(req, res, 400, { ok: false, error: 'BAD_BODY' }); return true; }
      if (leaf === '/accounts/password') {
        const result = await admin.resetAccountPassword(username, typeof body.password === 'string' ? body.password : '');
        json(req, res, result.ok ? 200 : 400, result);
        return true;
      }
      if (leaf === '/accounts/ban') {
        const result = await admin.setAccountBanned(username, body.banned !== false, typeof body.reason === 'string' ? body.reason : '');
        json(req, res, result.ok ? 200 : 400, result);
        return true;
      }
      const result = await admin.deleteAccount(username);
      json(req, res, result.ok ? 200 : 404, result);
      return true;
    }

    // ---- the operator accounts: owner only (creating an account is handing out console access) ----
    if (leaf === '/operators' || OPERATOR_WRITE_ENDPOINTS.has(leaf)) {
      if (!admin.adminAccountsAvailable?.()) { json(req, res, 503, { ok: false, error: 'UNAVAILABLE' }); return true; }
      if (!admin.isOwner(session)) { json(req, res, 403, { ok: false, error: 'OWNER_ONLY' }); return true; }

      if (leaf === '/operators') {
        if (method !== 'GET') { json(req, res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }); return true; }
        const result = await admin.listOperators();
        json(req, res, result.ok ? 200 : 503, result);
        return true;
      }

      if (method !== 'POST') { json(req, res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }); return true; }
      const body = await readJsonBody(req);
      if (body === undefined) { json(req, res, 413, { ok: false, error: 'BODY_TOO_LARGE' }); res.once('finish', () => req.destroy()); return true; }
      if (!body) { json(req, res, 400, { ok: false, error: 'BAD_BODY' }); return true; }
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) { json(req, res, 400, { ok: false, error: 'BAD_BODY' }); return true; }
      const password = typeof body.password === 'string' ? body.password : '';
      const name = typeof body.name === 'string' ? body.name : '';
      let result;
      if (leaf === '/operators/create') result = await admin.createOperator({ id, password, name });
      else if (leaf === '/operators/password') result = await admin.setOperatorPassword(id, password);
      else if (leaf === '/operators/disabled') result = await admin.setOperatorDisabled(id, body.disabled !== false);
      else result = await admin.deleteOperator(id);
      const status = result.ok ? 200 : result.error === 'NO_SUCH_ACCOUNT' ? 404 : 400;
      json(req, res, status, result);
      return true;
    }

    // ---- the announcement console: its own leaves, so publishing never shares the room endpoints ----
    if (leaf === '/announcements' || ANNOUNCEMENT_WRITE_ENDPOINTS.has(leaf)) {
      if (!admin.announcementsAvailable?.()) { json(req, res, 503, { ok: false, error: 'UNAVAILABLE' }); return true; }

      if (leaf === '/announcements') {
        if (method !== 'GET') { json(req, res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }); return true; }
        const q = new URLSearchParams(parts.query);
        const id = q.get('id');
        const result = id ? admin.readAnnouncement(id) : admin.listAnnouncements();
        json(req, res, result.ok ? 200 : 404, result);
        return true;
      }

      if (method !== 'POST') { json(req, res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }); return true; }
      // Publishing carries a Markdown document, so this leaf gets the wider cap; the others keep the generic one.
      const limit = leaf === '/announcements/publish' || leaf === '/announcements/update' ? ADMIN_ANNOUNCEMENT_BODY_MAX_BYTES : ADMIN_BODY_MAX_BYTES;
      const body = await readJsonBody(req, limit);
      if (body === undefined) { json(req, res, 413, { ok: false, error: 'BODY_TOO_LARGE' }); res.once('finish', () => req.destroy()); return true; }
      if (!body) { json(req, res, 400, { ok: false, error: 'BAD_BODY' }); return true; }

      if (leaf === '/announcements/publish') {
        const result = admin.publishAnnouncement({
          id: typeof body.id === 'string' ? body.id.trim() : undefined,
          title: body.title, markdown: body.markdown, pin: body.pin === true,
          author: session.id,
        });
        json(req, res, result.ok ? 200 : 400, result);
        return true;
      }
      if (leaf === '/announcements/update') {
        const result = admin.updateAnnouncement(body.id, {
          title: body.title, markdown: body.markdown, author: session.id,
        });
        json(req, res, result.ok ? 200 : 400, result);
        return true;
      }
      if (leaf === '/announcements/pin') {
        const result = admin.pinAnnouncement(body.id);
        json(req, res, result.ok ? 200 : 400, result);
        return true;
      }
      if (leaf === '/announcements/unpin') {
        const result = admin.unpinAnnouncement();
        json(req, res, result.ok ? 200 : 400, result);
        return true;
      }
      const result = await admin.notifyAnnouncement(body.id);
      json(req, res, result.ok ? 200 : 400, result);
      return true;
    }

    // ---- the OneBot 群招募 console: its own leaves, so a bad config edit never shares the room endpoints ----
    if (leaf === '/onebot' || ONEBOT_WRITE_ENDPOINTS.has(leaf)) {
      if (!admin.onebotAvailable?.()) { json(req, res, 503, { ok: false, error: 'UNAVAILABLE' }); return true; }

      if (leaf === '/onebot') {
        if (method !== 'GET') { json(req, res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }); return true; }
        json(req, res, 200, admin.onebotInfo());
        return true;
      }

      if (method !== 'POST') { json(req, res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }); return true; }
      const body = await readJsonBody(req);
      if (body === undefined) { json(req, res, 413, { ok: false, error: 'BODY_TOO_LARGE' }); res.once('finish', () => req.destroy()); return true; }
      if (!body) { json(req, res, 400, { ok: false, error: 'BAD_BODY' }); return true; }

      if (leaf === '/onebot/config') {
        const result = await admin.updateOnebotConfig(body, session.id);
        json(req, res, result.ok ? 200 : 400, result);
        return true;
      }
      if (leaf === '/onebot/reconnect') {
        json(req, res, 200, admin.onebotReconnect());
        return true;
      }
      const result = await admin.onebotTestSend();
      json(req, res, result.ok ? 200 : 502, result);
      return true;
    }

    if (READ_ENDPOINTS.has(leaf)) {
      if (method !== 'GET') { json(req, res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }); return true; }
      if (leaf === '/overview') { json(req, res, 200, admin.overview()); return true; }
      if (leaf === '/session') { json(req, res, 200, { ok: true, identity: session }); return true; }
      if (leaf === '/rooms') { json(req, res, 200, admin.rooms()); return true; }
      const q = new URLSearchParams(parts.query);
      const since = Number(q.get('since')) || 0;
      const limit = Math.min(400, Math.max(1, Number(q.get('limit')) || 200));
      json(req, res, 200, admin.logs(since, limit));
      return true;
    }

    if (!WRITE_ENDPOINTS.has(leaf)) {
      log.warn?.(`[admin] unknown endpoint ${path}`);
      json(req, res, 404, { ok: false, error: 'NOT_FOUND' });
      return true;
    }
    if (method !== 'POST') { json(req, res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }); return true; }

    const body = await readJsonBody(req);
    if (body === undefined) { json(req, res, 413, { ok: false, error: 'BODY_TOO_LARGE' }); res.once('finish', () => req.destroy()); return true; }
    if (!body) { json(req, res, 400, { ok: false, error: 'BAD_BODY' }); return true; }

    if (leaf === '/broadcast') {
      const result = admin.broadcast(body.text, body.kind);
      json(req, res, result.ok ? 200 : 400, result);
      return true;
    }
    if (leaf === '/maintenance') {
      if (typeof body.on !== 'boolean') { json(req, res, 400, { ok: false, error: 'BAD_BODY' }); return true; }
      if (!admin.maintenanceAvailable()) { json(req, res, 503, { ok: false, error: 'UNAVAILABLE' }); return true; }
      // Answer FIRST, switch after it is flushed: turning protection on closes public HTTP connections and cuts the asset
      // cache loose, so the very request that asked for it would otherwise die unanswered and the console would report a
      // network error for an action that in fact succeeded.
      json(req, res, 200, { ok: true, active: body.on });
      res.once('finish', () => admin.setMaintenance(body.on));
      return true;
    }
    const result = admin.closeRoom(body.code);
    json(req, res, result.ok ? 200 : 404, result);
    return true;
  };
}
