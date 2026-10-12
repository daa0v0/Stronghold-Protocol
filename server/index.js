// server/index.js — process entry & boot (DESIGN §1, §2). Plain node:http + ws, no framework: startServer() below
// wires the modules under server/http/, in this order —
//
//   http/config.js     ROOT, the served directories, the environment (PORT 3000, HOST '::' dual-stack, TRUST_PROXY auto, DEBUG),
//                      which startServer() options go to net.js / lobby.js, the console logger
//   http/websocket.js  session wiring (SessionRegistry → Lobby → Network) and the WebSocket at /ws (maxPayload 64 KB;
//                      refused at upgrade with 404 / 429 per network / 503)
//   http/static.js     the static mounts (/ → public/, /data/, /shared/, /sim/ `.js` only), the /data.js browser stand-in,
//                      the content packs (/packs/index.json, /packs/<id>/<file> — the registry is packs.js)
//   http/media.js      /media/bgm/act1 → public/assets/audio/bgm/act1.mp3 (audio addressed without its extension)
//   http/files.js      one file → response: MIME, gzip + memory cache, ETag / Last-Modified / 304, Cache-Control, ranges
//   http/buildTag.js   the build tag of the served browser runtime (/healthz `build`, public/js/ui/buildGuard.js)
//   http/routes.js     the request listener: security headers, 414 / 400 / 405, GET /healthz → JSON status, else static
//   http/common.js     what every answer shares: security headers, URL split, error page, JSON replies, bare 400
//   http/boot.js       a pending update package first (update.js: old files deleted, the install verified against
//                      MANIFEST.json), banner (Local / LAN / tunnel URLs), port-in-use hint, graceful shutdown on SIGINT /
//                      SIGTERM
//
// Per-network limits for internet clients (see net.js clientAddress; local/LAN peers are exempt): open sockets
// (maxConnectionsPerAddr, refused at upgrade with 429), rooms and running matches (lobby.js).
//
// Programmatic use (tests): `const srv = await startServer({ port: 0, quiet: true }); … await srv.close();`
// The server only auto-listens when this file is the process entry point.

import http from 'node:http';
import { DATA_FILES, getData, loadData } from './data.js';
import { applyDataPacks, dataPackTag } from './dataPacks.js';
// 房间人数策略 (docs/MODS.md): a data table the packs produce, applied before the lobby or a match can read it.
import { applyCapacityRules, capacityOptions, defaultSeats, groupedPoolMinPlayers } from '../shared/playerCapacity.js';
import { createHash } from 'node:crypto';
import { ROOT, listenAddress, bindCandidates, serveDirs, makeLogger, parseTrustProxy } from './http/config.js';
import { WS_MAX_PAYLOAD, createSessionStack, attachWebSocket } from './http/websocket.js';
import { DATA_SHIM_JS, createStaticHandler } from './http/static.js';
import { createPackRegistry } from './packs.js';
import { loadMods, modsReport, scanMods } from './mods.js';
import { createAnnouncementStore } from './announcements.js';
import { createAnnouncementNoticeMonitor } from './announcementNotices.js';
import { createServerSettings } from './serverSettings.js';
import { MIME, COMPRESSIBLE, acceptsGzip, parseRange } from './http/files.js';
import { BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag } from './http/buildTag.js';
import { createRequestHandler } from './http/routes.js';
import { createAssetCacheHandler } from './http/assetCache.js';
import { createBandwidthEmergencyController, bandwidthEmergencyOptions } from './bandwidthEmergency.js';
import { answerClientError } from './http/common.js';
import { lanUrls, displayHost, isProcessEntry, runMain } from './http/boot.js';
import { createAdminService, createLogRing, readAdminSecret, weakSecretWarning, withLogRing } from './admin.js';
import { createAdminHandler } from './http/admin.js';

// The public API of this module (tests and tools import it from here); the code lives in ./http/.
export {
  ROOT, WS_MAX_PAYLOAD, DATA_SHIM_JS, MIME, COMPRESSIBLE, BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag,
  acceptsGzip, parseRange, createStaticHandler, lanUrls, parseTrustProxy,
};

/**
 * Build and start the HTTP + WebSocket server.
 * @param {{
 *   port?: number, host?: string, quiet?: boolean, log?: object,
 *   publicDir?: string, dataDir?: string, sharedDir?: string, packsDir?: string, announcementsDir?: string,
 *   serverSettingsDir?: string,
 *   MatchClass?: Function, seedFn?: () => number,
 *   lobbyGraceMs?: number, reconnectWindowMs?: number, heartbeatMs?: number, helloTimeoutMs?: number,
 *   ratePerSec?: number, rateBurst?: number, maxConnections?: number, maxRooms?: number, compactWire?: boolean, runtimeCache?: boolean,
 *   maxConnectionsPerAddr?: number, maxRoomsPerAddr?: number, maxMatchesPerAddr?: number, resyncMinGapMs?: number,
 *   heavyPerSec?: number, heavyBurst?: number, trustProxy?: 'auto' | boolean, soloReconnectWindowMs?: number,
 *   assetCacheLimits?: { totalBps?: number, clientBps?: number, maxDownloads?: number, maxDownloadsPerClient?: number },
 *   assetCacheBuildCatalog?: Function,
 *   bandwidthEmergency?: object | false,
 * }} [opts]
 * @returns {Promise<{ port: number, host: string, url: string, server: http.Server, wss: import('ws').WebSocketServer,
 *                     lobby: import('./lobby.js').Lobby, network: import('./net.js').Network,
 *                     registry: import('./net.js').SessionRegistry, packs: ReturnType<typeof createPackRegistry>,
 *                     announcements: ReturnType<typeof createAnnouncementStore>,
 *                     serverSettings: ReturnType<typeof createServerSettings>,
 *                     close: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  // Validate operator options before starting any session/watch timers.
  const emergencyOptions = bandwidthEmergencyOptions(opts.bandwidthEmergency === false ? { enabled: false } : opts.bandwidthEmergency || {});
  const { port, host } = listenAddress(opts);
  const baseLog = opts.log || makeLogger(!!opts.quiet);
  const { publicDir, dataDir, sharedDir, packsDir, modsDir, adminSecretFile } = serveDirs(opts);
  // 运维后台 (docs/ADMIN.md): mirror the process log into a bounded ring so the console can show recent lines. A new
  // logger object wraps it (never the caller's object, which may be a shared singleton). Off unless a secret is set.
  // `opts.adminSecret` is for tests and embedders; the environment (ADMIN_SECRET / ADMIN_SECRET_FILE) and the default file
  // (runtime/admin.secret, tools/admin-secret.mjs) are the normal paths.
  const adminSecret = readAdminSecret(
    opts.adminSecret ? { ...process.env, ADMIN_SECRET: String(opts.adminSecret), ADMIN_SECRET_FILE: '' } : process.env,
    { defaultFile: opts.adminSecret ? '' : adminSecretFile },
  );
  const logRing = createLogRing();
  const log = adminSecret.secret ? withLogRing(baseLog, logRing) : baseLog;
  // Say WHY it is off, once, in the console. A missing secret means /admin and /api/admin/* answer 404 exactly like any
  // other unknown path (docs/ADMIN.md §1 — no default password, and the 404 must not announce that a console exists), so
  // without this line the only symptom is a 404 with no explanation anywhere. The message names the next step.
  const sourceName = { env: 'ADMIN_SECRET', file: 'ADMIN_SECRET_FILE', default: 'runtime/admin.secret' }[adminSecret.source] || '';
  if (!adminSecret.secret) log.info(`[admin] 后台关闭：${adminSecret.problem}（docs/ADMIN.md §2 说明如何开启；配好后重启）`);
  else {
    log.info(`[admin] 后台已启用（密钥来源：${sourceName}）`);
    // Accepted, but worth saying once: this is the line between "my own server" and "the internet can reach it".
    const weak = weakSecretWarning(adminSecret.secret);
    if (weak) log.warn?.(`[admin] ${weak}`);
  }

  // The owner's private settings (runtime/server-settings.json, /admin) come first: the pack registry reads their
  // content-pack policy on every scan (docs/PACKS.md §4).
  const serverSettings = createServerSettings({ dir: opts.serverSettingsDir, root: ROOT, log,
    onChange: (next) => applySettings(next) });

  // content packs (docs/PACKS.md): scanned first — the start log names them, and a "data" pack's patches belong to the
  // tables the match and the simulation run on (and to the same tables /data/<name>.json serves) — and again whenever
  // their folders change.
  const packs = createPackRegistry({ publicDir, dataDir, packsDir }, { log,
    policy: () => serverSettings.get().packs });
  packs.refresh(true);
  // The content identity of this server (docs/PACKS.md §4; shared/contentTag.js): one tag over the packs in force, in the
  // start log, in GET /healthz (clients compare it with the tag they compute from the index) and on the returned object.
  const content = packs.content();
  if (content.packs.length) log.info(`[packs] content ${content.tag}: ${content.summary}`);

  // The process-wide singleton serves the default data dir; a custom dir (tests) gets its own copy.
  const baseData = opts.dataDir ? loadData(dataDir, { log }) : getData({ dir: dataDir, log });
  const dataPacks = applyDataPacks(baseData, packs.list('data'), { log, known: DATA_FILES });
  const data = dataPacks.tables;
  const dataPackTagValue = dataPackTag(dataPacks, (t) => createHash('sha256').update(t).digest('hex'));

  // 房间人数策略 (docs/MODS.md): which room sizes the lobby offers, its default, and the grouping/unite rules a big room
  // needs. The base table is the upstream baseline and the shipped 20-player policy is a data pack, so this applies
  // whatever the packs produced — before the lobby can create a room, and before any match reads the rules.
  const capacityRules = applyCapacityRules(data.capacity);
  if (capacityRules.rejected.length) log.warn(`[capacity] 忽略无效字段：${capacityRules.rejected.join(', ')}`);
  log.info(`[capacity] 房间人数 ${capacityOptions().join('/')}（默认 ${defaultSeats()}，${groupedPoolMinPlayers()} 人起分组）`);

  // 代码 mod (docs/PACKS.md §4): a folder under mods/ that the owner installs AND enables. Always scanned (so /admin can
  // say what is there), loaded only when its id is in the settings — a folder dropped in must never run — and loaded here,
  // after the packs and the data tables, so a mod may register content and see what the server will simulate with.
  const modScan = scanMods(modsDir);
  for (const w of modScan.warnings) log.warn(`[mods] ${w.where}: ${w.warning}`);
  for (const k of modScan.skipped) log.warn(`[mods] ${k.where} skipped: ${k.problems.join('; ')}`);
  const modRuntime = await loadMods(modScan.mods, { enabled: serverSettings.get().mods?.enabled || [], data, packs, log });
  const modsState = modsReport(modScan, { enabled: serverSettings.get().mods?.enabled || [] }, modRuntime);
  if (modsState.mods.length && !modRuntime.loaded.length) {
    log.info(`[mods] ${modsState.mods.length} code mod(s) present, none enabled (runtime/server-settings.json, /admin)`);
  }

  const { registry, lobby, network } = createSessionStack(opts, { data, log, packs });
  const announcements = createAnnouncementStore({ dir: opts.announcementsDir, root: ROOT, log });
  const announcementNotices = createAnnouncementNoticeMonitor({ store: announcements, network, log });
  const serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, packsDir, packs,
    dataTables: dataPacks.overrides.size ? dataPacks.overrides : null, runtimeCache: opts.runtimeCache, log });
  // A persisted owner limit overrides the programmatic/env fallback. A null setting means the
  // default unlimited limiter, while keeping tests and embedders' explicit opts usable.
  const fallbackAssetCacheLimits = opts.assetCacheLimits;
  const initialAssetCacheLimits = serverSettings.get().assetCacheLimits ?? fallbackAssetCacheLimits ?? undefined;
  const assetCache = createAssetCacheHandler({ publicDir, dataDir, log, limits: initialAssetCacheLimits, trustProxy: opts.trustProxy,
    buildCatalog: opts.assetCacheBuildCatalog, requireAssetCache: () => serverSettings.get().requireAssetCache });
  let warmingAssetSummary = null;
  function warmAssetSummary() {
    if (!warmingAssetSummary) warmingAssetSummary = assetCache.summary()
      .catch((error) => { log.warn('[asset-cache] admission summary unavailable', error.message); })
      .finally(() => { warmingAssetSummary = null; });
    return warmingAssetSummary;
  }
  function applySettings(next) {
    lobby.setAiLimit(next.maxAiPerRoom);
    lobby.setAssetCachePolicy({ required: next.requireAssetCache, getSummary: assetCache.currentSummary });
    assetCache.setLimits(next.assetCacheLimits ?? fallbackAssetCacheLimits);
    // Runtime enabling fails closed until a summary is ready; ordinary optional startup stays lazy.
    if (next.requireAssetCache && !assetCache.currentSummary()) void warmAssetSummary();
    // A content-pack policy change (off / allow, docs/PACKS.md §4) takes effect at once: the registry re-reads the
    // folders and applies the policy in the same tick, so the index, /healthz.mods and the served pack files follow.
    packs.refresh(true);
  }
  applySettings(serverSettings.get());
  if (serverSettings.get().requireAssetCache) await warmAssetSummary();
  const startedAt = Date.now();
  // The tag is per process (see buildTag): read the browser runtime once, here, not on every /healthz.
  resetBuildTag();
  buildTag();

  let requestHandler;
  const bandwidthEmergency = createBandwidthEmergencyController({
    ...(opts.bandwidthEmergency || {}), ...emergencyOptions,
    getMetrics: () => assetCache.metrics(), getCongestion: () => network.congestion(),
    canResume: () => [...lobby.rooms.values()].every((room) => !room.match || room.activeHumans().some((seat) => seat.connected)),
    log,
    onChange: (state) => {
      if (state.active) {
        assetCache.trip(state.reason);
        requestHandler?.abortPublicRequests();
        // `finish` only means handed to TCP, not delivered. Close ordinary HTTP sockets too,
        // including finished keep-alive transfers; Node deliberately excludes upgraded WebSockets.
        server.closeAllConnections?.();
      } else assetCache.resume();
      network.setEmergency(state);
      lobby.setEmergency(state);
      log.warn(`[bandwidth-emergency] ${state.active ? state.action === 'retry-delayed'
        ? '现有对局仍未具备恢复条件，继续保护' : '保护开启，下载和新访问已切断，对局冻结'
        : '尝试恢复访问和对局'} (${state.reason || 'recovery'})`);
    },
  });
  const adminService = createAdminService({
    enabled: !!adminSecret.secret, secret: adminSecret.secret, secretSource: adminSecret.source, problem: adminSecret.problem,
    lobby, network, registry, bandwidthEmergency, assetCache, serverSettings, announcements, packs, settingsDir: serverSettings.dir,
    serverMods: modsState,
    ring: logRing, log, startedAt, build: buildTag,
    // `adminNow` lets a test move the clock and watch a session expire (docs/ADMIN.md §3); production never sets it.
    ...(opts.adminNow ? { now: opts.adminNow } : {}),
  });
  const admin = createAdminHandler({ admin: adminService, serveStatic, log });
  requestHandler = createRequestHandler({ serveStatic, announcements, assetCache, admin,
    emergency: () => network.emergency, health: { startedAt, network, registry, lobby, bandwidthEmergency, packs, serverMods: modsState }, log });
  const server = http.createServer(requestHandler);
  server.on('clientError', answerClientError);
  const wss = attachWebSocket(server, { network, log });
  // Prime before accepting connections; only commands submitted to a running server are broadcast.
  announcementNotices.start();
  serverSettings.start();

  // The address actually bound. The default may fall back to IPv4; the returned host and url follow that.
  let boundHost;
  try {
    // A host with IPv6 switched off refuses '::'. Fall back to IPv4 rather than not booting. Only the default is
    // retried: an explicit HOST is literal (server/http/config.js bindCandidates).
    let bound = null;
    let lastError = null;
    const candidates = bindCandidates(host);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        await new Promise((resolve, reject) => {
          const onError = (e) => { server.off('listening', onListening); reject(e); };
          const onListening = () => { server.off('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, candidate);
        });
        bound = candidate;
        break;
      } catch (e) {
        lastError = e;
        const retry = ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL'].includes(e.code) && i < candidates.length - 1;
        if (!retry) break;
        log.warn(`[boot] cannot bind ${candidate} (${e.code}) — falling back to IPv4 only`);
      }
    }
    if (bound === null) throw lastError;
    boundHost = bound;
  } catch (e) {
    bandwidthEmergency.close();
    serverSettings.close();
    assetCache.close();
    announcementNotices.close();
    network.close(); // stop heartbeat/sweep timers of the half-built server
    throw e;
  }
  server.on('error', (e) => log.error('[http] server error', e));
  bandwidthEmergency.start();

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${displayHost(boundHost)}:${actualPort}`;

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      bandwidthEmergency.close();
      serverSettings.close();
      assetCache.close();
      announcementNotices.close();
      try { lobby.shutdown('shutdown'); } catch (e) { log.error('[shutdown] lobby', e); }
      network.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => { server.closeAllConnections?.(); }, 500).unref();
      });
      try { wss.close(); } catch { /* ignore */ }
    })();
    return closing;
  }

  return { port: actualPort, host: boundHost, url, server, wss, lobby, network, registry, packs, announcements, serverSettings,
    mods: modsState, modScan, bandwidthEmergency, admin: adminService,
    dataPacks: { applied: dataPacks.applied, tag: dataPackTagValue, overrides: dataPacks.overrides }, close };
}

// `node server/index.js` / npm start: listen, print the banner, stop on SIGINT / SIGTERM (http/boot.js).
if (isProcessEntry(import.meta.url)) runMain(startServer);
