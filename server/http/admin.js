// server/http/admin.js — the 运维后台 routes (docs/ADMIN.md), answered before the emergency gate in routes.js.
//
//   GET  /admin[/…]           → public/admin/index.html (the console; every other file under /admin/ is static)
//   GET  /api/admin/overview  → process, host, lobby, network, maintenance, settings (authenticated)
//   GET  /api/admin/rooms     → one entry per room, with the running match's phase/round and its fixed pool groups
//   GET  /api/admin/logs      → the log ring since `?since=` (authenticated)
//   POST /api/admin/login     { secret } → 200 + the per-process cookie
//   POST /api/admin/logout    → 200 + a cleared cookie
//   POST /api/admin/broadcast { text, kind } → a toast + a CUSTOM ticker line to every connection
//   POST /api/admin/maintenance { on } → the server's own protection on/off (refuses new visits, freezes matches)
//   POST /api/admin/rooms/close { code } → close one room
//
// With no ADMIN_SECRET the whole prefix answers 404: a deployment that forgot the secret has no console at all (there is
// deliberately no default password). Unauthenticated API calls answer 401; the console shell itself is public, it only
// ever draws a登录 form until the API answers.
//
// i18n-ignore-file: operator-facing administration API and logs, never player-facing UI text
import { ADMIN_API_PREFIX, ADMIN_BODY_MAX_BYTES, ADMIN_UI_PATH } from '../admin.js';
import { sendError, sendJson } from './common.js';

/**
 * Read a JSON body, bounded. `undefined` = too large, `null` = malformed.
 *
 * On overflow this stops reading and resolves `undefined` WITHOUT touching the socket: the caller answers 413 and only
 * then drops the request (`res.once('finish', …)` below). Destroying the request here would kill the connection before
 * the answer is flushed, and the operator would see a network error instead of the status.
 * @param {any} req
 * @returns {Promise<object|null|undefined>}
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    let over = false;
    let chunks = [];
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > ADMIN_BODY_MAX_BYTES) { over = true; chunks = []; req.pause(); resolve(undefined); return; }
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
const READ_ENDPOINTS = new Set(['/overview', '/rooms', '/logs', '/packs', '/mods']);
const WRITE_ENDPOINTS = new Set(['/broadcast', '/maintenance', '/rooms/close', '/packs', '/mods']);

/**
 * @param {{ admin: any, serveStatic: (req: any, res: any, rawPath: string, query: string) => Promise<void>,
 *           log?: { warn?: Function } }} deps
 * @returns {(req: any, res: any, parts: { rawPath: string, query: string }) => Promise<boolean>} true = answered
 */
export function createAdminHandler({ admin, serveStatic, log = console }) {
  const isUi = (path) => path === ADMIN_UI_PATH || path === `${ADMIN_UI_PATH}/` || path.startsWith(`${ADMIN_UI_PATH}/`);
  const isApi = (path) => path === ADMIN_API_PREFIX || path.startsWith(`${ADMIN_API_PREFIX}/`);

  /**
   * Every console answer is `no-store`: an authenticated payload must not be replayable by the browser cache, a shared
   * proxy or the back/forward cache after the session ends (docs/ADMIN.md §3).
   * @param {any} req @param {any} res @param {number} status @param {object} body
   */
  const json = (req, res, status, body) => {
    res.setHeader('Cache-Control', 'no-store');
    sendJson(req, res, status, body);
  };

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
      res.setHeader('Cache-Control', 'no-store');
      await serveStatic(req, res, target, parts.query);
      return true;
    }

    // ---- login / logout are the only unauthenticated API calls ----
    if (path === `${ADMIN_API_PREFIX}/login`) {
      if (method !== 'POST') { json(req, res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }); return true; }
      const body = await readJsonBody(req);
      if (body === undefined) { json(req, res, 413, { ok: false, error: 'BODY_TOO_LARGE' }); res.once('finish', () => req.destroy()); return true; }
      if (!body) { json(req, res, 400, { ok: false, error: 'BAD_BODY' }); return true; }
      const result = admin.login(req, body.secret);
      if (!result.ok) {
        res.setHeader('Cache-Control', 'no-store');
        if (result.retryAfterMs) res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
        json(req, res, result.status, { ok: false, error: result.error, retryAfterMs: result.retryAfterMs });
        return true;
      }
      res.setHeader('Set-Cookie', result.cookie);
      json(req, res, 200, { ok: true });
      return true;
    }
    if (path === `${ADMIN_API_PREFIX}/logout`) {
      if (method !== 'POST') { json(req, res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }); return true; }
      res.setHeader('Set-Cookie', admin.logout(req));
      json(req, res, 200, { ok: true });
      return true;
    }

    // ---- everything else needs the secret ----
    if (!admin.authenticate(req)) {
      if (wantJson(req) || isApi(path)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        json(req, res, 401, { ok: false, error: 'UNAUTHORIZED' });
      } else sendError(req, res, 401, '需要管理员密钥 · Admin secret required');
      return true;
    }

    // Dispatch by the leaf below /api/admin, so an UNKNOWN path is 404 while a KNOWN path with the wrong method is 405.
    const leaf = path.slice(ADMIN_API_PREFIX.length);

    // A leaf that is both readable and writable (/packs) is answered as a read for GET and falls through to the write
    // path otherwise; every other read-only leaf keeps answering 405 to anything but GET.
    if (READ_ENDPOINTS.has(leaf) && (method === 'GET' || !WRITE_ENDPOINTS.has(leaf))) {
      if (method !== 'GET') { json(req, res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }); return true; }
      if (leaf === '/overview') { json(req, res, 200, admin.overview()); return true; }
      if (leaf === '/rooms') { json(req, res, 200, admin.rooms()); return true; }
      if (leaf === '/packs') { json(req, res, 200, admin.packs()); return true; }
      if (leaf === '/mods') { json(req, res, 200, admin.mods()); return true; }
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
    if (leaf === '/packs') {
      // The one setting this fork lets the panel write (server/admin.js): a bad pack id is 404, a language pack that may
      // not be turned off is 409, a failed write is 500 — the console shows the error and reloads the list.
      const result = admin.setPacks(body);
      const status = result.ok ? 200 : result.error === 'UNKNOWN_PACK' ? 404 : result.error === 'LANGUAGE_LOCKED' ? 409
        : result.error === 'UNAVAILABLE' ? 503 : result.error === 'WRITE_FAILED' ? 500 : 400;
      json(req, res, status, result);
      return true;
    }
    if (leaf === '/mods') {
      // 代码 mod (docs/PACKS.md §4): the switch is written but the code was imported at start, so the answer always says
      // restartRequired — the console shows that instead of pretending it took effect.
      const result = admin.setMods(body);
      const status = result.ok ? 200 : result.error === 'UNKNOWN_MOD' ? 404 : result.error === 'UNAVAILABLE' ? 503
        : result.error === 'WRITE_FAILED' ? 500 : 400;
      json(req, res, status, result);
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
