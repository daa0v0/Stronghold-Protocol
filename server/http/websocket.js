// server/http/websocket.js — the real-time side of the server:
//
//   * session wiring: SessionRegistry (reconnect tokens) → Lobby (rooms, server/lobby.js) → Network (the socket
//     protocol, server/net.js), built from the startServer() options (config.js decides which go where);
//   * WebSocket (ws) at /ws, maxPayload 64 KB, permessage-deflate (WS_DEFLATE) → Network.handleConnection. Refused at
//     the upgrade: any other path 404; per-network socket limit for internet clients (maxConnectionsPerAddr, see net.js
//     clientAddress; local/LAN peers are exempt) 429; server full (maxConnections) or shutting down 503.

import { WebSocketServer } from 'ws';
import { Network, SessionRegistry, NET_DEFAULTS } from '../net.js';
import { Lobby } from '../lobby.js';
import { splitUrl } from './common.js';
import { netOptionsFrom, lobbyOptionsFrom } from './config.js';

/** Inbound WebSocket frame limit (DESIGN §8). */
export const WS_MAX_PAYLOAD = 64 * 1024;

// RFC 7692 raw DEFLATE. The server RETAINS its outbound 32 KiB dictionary across messages
// (`serverNoContextTakeover: false`) while the inbound side stays stateless (`clientNoContextTakeover: true`): a 20-seat
// room rebroadcasts a near-identical full m.public to 21 sockets several times a second, so the retained dictionary
// delta-compresses each repeat ~10× — the difference between a smooth game and a multi-second control backlog on a
// constrained link (test/wire-pressure.test.js). `concurrencyLimit` bounds the global zlib work; maxPayload still bounds
// the decompressed input. No custom browser inflater — browsers negotiate it themselves, a client that offers none gets
// plain frames. SP_WS_DEFLATE=0 disables it (docs/WIRE_PROTOCOL.md).
export const WS_DEFLATE = Object.freeze({
  serverNoContextTakeover: false, clientNoContextTakeover: true,
  serverMaxWindowBits: 15, concurrencyLimit: 4, threshold: 256,
  zlibDeflateOptions: Object.freeze({ level: 6, memLevel: 7 }),
});

/**
 * Does every permessage-deflate offer of this `Sec-WebSocket-Extensions` header cap the server window below
 * WS_DEFLATE.serverMaxWindowBits? ws cannot accept such an offer and refuses the whole handshake (400), so the upgrade
 * drops the header instead and the connection goes uncompressed. No browser sends `server_max_window_bits`.
 * @param {string | string[] | undefined} header
 */
export function narrowDeflateOffer(header) {
  if (typeof header !== 'string') return false;
  const offers = header.split(',').map((s) => s.trim()).filter((s) => /^permessage-deflate\b/i.test(s));
  if (!offers.length) return false;
  return offers.every((offer) => {
    const m = /(?:^|;)\s*server_max_window_bits\s*=\s*"?(\d+)"?/i.exec(offer);
    return !!m && Number(m[1]) < WS_DEFLATE.serverMaxWindowBits;
  });
}

/**
 * The session stack of one server.
 * @param {{ MatchClass?: Function, seedFn?: () => number, [option: string]: any }} opts startServer() options
 * @param {{ data: object, log: object, content?: { cs: string } | null,
 *   plugins?: ReturnType<typeof import('../plugins/roomSets.js').createRoomSets> | null,
 *   hosts?: ReturnType<typeof import('../match/host/index.js').createMatchHosts> | null,
 *   onebot?: ReturnType<typeof import('../onebot.js').createOneBotClient> | null }} deps the game data the lobby's
 *   matches use, the logger, the vanilla content (server/plugins/identity.js: welcome / room.state content, BattleSpec
 *   cs), the room sets a room's host chooses from (room.setPlugins: visual and content sets), the match hosts a room with
 *   gameplay plugins plays in (DESIGN §32.6), the OneBot 群招募 client (server/onebot.js)
 * @returns {{ registry: SessionRegistry, lobby: Lobby, network: Network }}
 */
export function createSessionStack(opts, { data, log, content = null, plugins = null, hosts = null, onebot = null }) {
  const netOptions = netOptionsFrom(opts);
  const registry = new SessionRegistry({ reconnectWindowMs: netOptions.reconnectWindowMs ?? NET_DEFAULTS.reconnectWindowMs });
  const lobbyOptions = lobbyOptionsFrom(opts);
  const lobby = new Lobby({ registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, content, plugins, hosts, onebot, options: lobbyOptions });
  const network = new Network({ registry, handler: lobby, log, options: netOptions, accounts: opts.accounts || null });
  return { registry, lobby, network };
}

/**
 * Count a socket in the traffic counters (traffic.js): its wire bytes from now until it closes, the payload of every
 * message it sends (ws.send wrapped) and receives.
 * @param {import('ws').WebSocket} ws
 * @param {import('node:http').IncomingMessage} req
 * @param {ReturnType<typeof import('./traffic.js').createTrafficCounter>} traffic
 */
function meterSocket(ws, req, traffic) {
  const socket = req.socket;
  traffic.wsOpen(socket);
  const send = ws.send;
  ws.send = function meteredSend(data, ...rest) {
    traffic.wsSent(data);
    return send.call(this, data, ...rest);
  };
  ws.on('message', (data) => traffic.wsReceived(data));
  ws.once('close', () => traffic.wsClose(socket));
}

/**
 * Serve the WebSocket endpoint /ws on `server` (its 'upgrade' event).
 * @param {import('node:http').Server} server
 * @param {{ network: Network, log: object, traffic?: ReturnType<typeof import('./traffic.js').createTrafficCounter>,
 *   extraUpgrade?: (req: any, parts: { rawPath: string, query: string } | null, socket: any, head: any) => boolean }} deps
 *   extraUpgrade: another WS endpoint on this server's port (server/onebot.js reverse mode, /onebot/ws): called first;
 *   when it returns true the request was answered and /ws logic skips.
 * @returns {WebSocketServer}
 */
export function attachWebSocket(server, { network, log, traffic = null, extraUpgrade = null }) {
  const compression = process.env.SP_WS_DEFLATE === '0' ? false : { ...WS_DEFLATE };
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: compression, clientTracking: false });
  wss.on('connection', (ws, req) => {
    if (traffic) meterSocket(ws, req, traffic);
    network.handleConnection(ws, req);
  });
  wss.on('error', (e) => log.error('[ws] server error', e));

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const parts = splitUrl(req.url || '/');
    if (extraUpgrade && extraUpgrade(req, parts, socket, head)) return;
    const reject = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
    };
    if (!parts || parts.rawPath !== '/ws') { reject(404, 'Not Found'); return; }
    const refused = network.admission(req);
    if (refused === 'per-address') { reject(429, 'Too Many Requests'); return; }
    if (refused) { reject(503, 'Service Unavailable'); return; }
    if (narrowDeflateOffer(req.headers['sec-websocket-extensions'])) delete req.headers['sec-websocket-extensions'];
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      log.error('[ws] upgrade failed', e);
      socket.destroy();
    }
  });
  return wss;
}
