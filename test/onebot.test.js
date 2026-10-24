// OneBot 群招募 (docs/ADMIN.md §4.4): the persisted config store (runtime/onebot.json), the forward-WS OneBot 11
// client, the recruit template rendering and the whole player path — room.state's recruit flag, room.recruit's
// cooldown and the 运维后台 endpoints. The OneBot side is a real WebSocketServer on 127.0.0.1 speaking the OneBot 11
// request/echo framing (github.com/botuniverse/onebot-11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import {
  DEFAULT_RECRUIT_TEMPLATE, ONEBOT_SERVER_PATH, createOneBotConfig, createOneBotClient, recruitFacts, renderRecruitTemplate,
  validGroupList, validLinkBase, validOneBotMode, validOneBotToken, validOneBotUrl, validRecruitTemplate,
} from '../server/onebot.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

const SECRET = 'unit-test-admin-secret-value';

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-onebot-')), name);
}

/** A fake OneBot 11 implementation: a ws server that records requests and answers them. */
function startFakeOneBot({ retcode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const { port } = wss.address();
      const state = { requests: [], auths: [] };
      wss.on('connection', (ws, req) => {
        state.auths.push(String(req.headers.authorization || ''));
        ws.on('message', (data) => {
          let msg;
          try { msg = JSON.parse(String(data)); } catch { return; }
          state.requests.push(msg);
          ws.send(JSON.stringify({ status: retcode === 0 ? 'ok' : 'failed', retcode, data: { message_id: 1 }, echo: msg.echo }));
        });
      });
      resolve({ wss, url: `ws://127.0.0.1:${port}`, ...state, close: () => new Promise((r) => wss.close(r)) });
    });
    wss.on('error', reject);
  });
}

/** Wait until `cond` holds (the client reconnects in the background, so poll instead of sleeping a fixed guess). */
async function until(cond, what, ms = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('config store: defaults, persistence, and the round trip through the file', async () => {
  const file = tmpFile('onebot.json');
  const store = createOneBotConfig({ file });
  await store.ready;
  const defaults = store.get();
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.mode, 'client');
  assert.equal(defaults.url, '');
  assert.deepEqual(defaults.groups, []);
  assert.equal(defaults.template, DEFAULT_RECRUIT_TEMPLATE);
  assert.equal(defaults.cooldownSec, 60);
  assert.equal(defaults.linkBase, '');

  const next = await store.update({ enabled: true, url: 'ws://127.0.0.1:3001', token: 'tok', groups: ['123456789'], template: '来 {room}！', cooldownSec: 30 });
  assert.equal(next.enabled, true);
  assert.equal(next.token, 'tok');
  // persisted: a fresh store reads the same values
  const reopened = createOneBotConfig({ file });
  await reopened.ready;
  const got = reopened.get();
  assert.equal(got.enabled, true);
  assert.equal(got.url, 'ws://127.0.0.1:3001');
  assert.equal(got.token, 'tok');
  assert.deepEqual(got.groups, ['123456789']);
  assert.equal(got.template, '来 {room}！');
  assert.equal(got.cooldownSec, 30);
});

test('config store: a malformed or partial file is ignored, not half-applied', async () => {
  const file = tmpFile('broken.json');
  fs.writeFileSync(file, '{"version":1,"enabled":true}');
  const store = createOneBotConfig({ file });
  await store.ready;
  assert.equal(store.get().enabled, false, 'a partial file (no url) must not half-enable the client');
  assert.equal(store.get().template, DEFAULT_RECRUIT_TEMPLATE);
});

test('config store: a file saved before the reverse mode / link existed still loads (missing = default)', async () => {
  const file = tmpFile('v1.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, enabled: true, url: 'ws://127.0.0.1:3001', token: 't', groups: ['123456789'], template: '模板 {room}', cooldownSec: 30,
  }));
  const store = createOneBotConfig({ file });
  await store.ready;
  assert.equal(store.get().enabled, true, 'the old configuration must survive an update');
  assert.equal(store.get().mode, 'client');
  assert.equal(store.get().linkBase, '');
  assert.deepEqual(store.get().groups, ['123456789']);
});

test('config store: update validation', async () => {
  const store = createOneBotConfig({ file: tmpFile('v.json') });
  await store.ready;
  await assert.rejects(() => store.update({ url: 'http://not-ws' }), /ws:\/\//);
  await assert.rejects(() => store.update({ groups: ['12'] }), /群号/);
  await assert.rejects(() => store.update({ groups: ['123456789', '123456789'] }), /群号/);
  await assert.rejects(() => store.update({ template: '   ' }), /模板/);
  await assert.rejects(() => store.update({ cooldownSec: -1 }), /冷却/);
  await assert.rejects(() => store.update({ nope: 1 }), /未知字段/);
  await assert.rejects(() => store.update({ enabled: true }), /地址/);
  await assert.rejects(() => store.update({ mode: 'server', enabled: true }), /Token/);
  await assert.rejects(() => store.update({ linkBase: 'ftp://x' }), /http/);
  // the reverse mode needs no url at all (the OneBot implementation dials this server)
  const reversed = await store.update({ mode: 'server', enabled: true, token: 'rev', groups: ['123456789'] });
  assert.equal(reversed.enabled, true);
  assert.equal(reversed.url, '');
  // clearing the url disables the feature in client mode (nothing to send to)
  const cleared = await store.update({ url: '', mode: 'client', enabled: false });
  assert.equal(cleared.enabled, false);
  assert.deepEqual(cleared.groups, []);
});

test('validators', () => {
  assert.equal(validOneBotUrl('ws://127.0.0.1:3001'), true);
  assert.equal(validOneBotUrl('wss://bot.example.com/ws'), true);
  assert.equal(validOneBotUrl('http://127.0.0.1:3001'), false);
  assert.equal(validOneBotUrl('ws://'), false);
  assert.equal(validOneBotToken('a'.repeat(128)), true);
  assert.equal(validOneBotToken('a'.repeat(129)), false);
  assert.equal(validGroupList(['123456789', '234567890']), true);
  assert.equal(validGroupList([]), true);
  assert.equal(validGroupList([123]), false);
  assert.equal(validRecruitTemplate('招募 {room}！'), true);
  assert.equal(validRecruitTemplate(''), false);
  assert.equal(validOneBotMode('client'), true);
  assert.equal(validOneBotMode('server'), true);
  assert.equal(validOneBotMode('both'), false);
  assert.equal(validLinkBase('https://game.example.com'), true);
  assert.equal(validLinkBase('http://127.0.0.1:3000'), true);
  assert.equal(validLinkBase(''), true);
  assert.equal(validLinkBase('ftp://x'), false);
  assert.equal(validLinkBase('game.example.com'), false);
});

test('renderRecruitTemplate: known placeholders are replaced, unknown ones kept', () => {
  const text = renderRecruitTemplate('{host} 的 {room}（{players}/{capacity}，{difficulty}，{mode}）来了', {
    room: 'ABCD', host: '博士', players: 2, capacity: 4, difficulty: '险境模拟', mode: '同盟模拟', link: '',
  });
  assert.equal(text, '博士 的 ABCD（2/4，险境模拟，同盟模拟）来了');
  assert.equal(renderRecruitTemplate('保持 {unknown} 和 {room}', { room: 'WXYZ' }), '保持 {unknown} 和 WXYZ');
});

test('renderRecruitTemplate: {link} is the clickable join link of the configured base URL', () => {
  const facts = recruitFacts({ code: 'ABCD', seats: [], activeHumans: () => 2, capacity: 4, difficulty: 'NORMAL', mode: 'coop' }, 'https://game.example.com/');
  assert.equal(facts.link, 'https://game.example.com/?room=ABCD', 'a trailing slash of the base URL does not duplicate');
  assert.equal(renderRecruitTemplate('点击加入：{link}', facts), '点击加入：https://game.example.com/?room=ABCD');
  const noBase = recruitFacts({ code: 'ABCD', seats: [], activeHumans: () => 2, capacity: 4, difficulty: 'NORMAL', mode: 'coop' });
  assert.equal(noBase.link, '', 'no base URL: {link} renders empty, the template keeps the rest');
});

test('client: dials with the token header, sends the OneBot 11 frame, reports the answer', async () => {
  const fake = await startFakeOneBot({ token: 's3cret' });
  const store = createOneBotConfig({ file: tmpFile('c.json') });
  await store.ready;
  await store.update({ enabled: true, url: fake.url, token: 's3cret', groups: ['111111111', '222222222'] });
  const client = createOneBotClient({ config: store, log: { info() {}, warn() {}, error() {} } });
  try {
    client.start();
    await until(() => client.connected, 'the client to dial the fake OneBot');
    assert.deepEqual(fake.auths, ['Bearer s3cret'], 'the access token rides the Authorization header');

    const res = await client.broadcast('招募测试');
    assert.deepEqual(res, { ok: true, sent: 2, total: 2, failed: [] });
    await until(() => fake.requests.length >= 2, 'both groups to be sent to');
    for (const req of fake.requests) {
    assert.equal(req.action, 'send_group_msg');
    assert.equal(req.params.group_id === 111111111 || req.params.group_id === 222222222, true);
      assert.deepEqual(req.params.message, [{ type: 'text', data: { text: '招募测试' } }]);
      assert.ok(req.echo, 'every request carries an echo');
    }
    assert.equal(client.status().sentCount, 2);
  } finally { client.close(); await fake.close(); }
});

test('client: a refused group is reported per group, a total failure reports sent 0', async () => {
  const fake = await startFakeOneBot({ retcode: 1200 });
  const store = createOneBotConfig({ file: tmpFile('f.json') });
  await store.ready;
  await store.update({ enabled: true, url: fake.url, groups: ['333333333'] });
  const client = createOneBotClient({ config: store, log: { info() {}, warn() {}, error() {} } });
  try {
    client.start();
    await until(() => client.connected, 'the connection');
    const res = await client.broadcast('测试');
    assert.equal(res.sent, 0);
    assert.equal(res.failed.length, 1);
    assert.match(res.failed[0].error, /1200/);
    assert.equal(client.status().lastError, null, 'a refused API call is not a socket error');
  } finally { client.close(); await fake.close(); }
});

test('client: recruiting without a connection reports every group as failed instead of throwing', async () => {
  const store = createOneBotConfig({ file: tmpFile('n.json') });
  await store.ready;
  await store.update({ enabled: true, url: 'ws://127.0.0.1:1/none', groups: ['444444444'] });
  const client = createOneBotClient({ config: store, log: { info() {}, warn() {}, error() {} }, retryBaseMs: 50, retryMaxMs: 100 });
  client.start();
  try {
    const res = await client.broadcast('测试');
    assert.equal(res.sent, 0);
    assert.equal(res.ok, false);
  } finally { client.close(); }
});

test('client: a config change redials, disabling disconnects', async () => {
  const fake = await startFakeOneBot();
  const store = createOneBotConfig({ file: tmpFile('r.json') });
  await store.ready;
  const client = createOneBotClient({ config: store, log: { info() {}, warn() {}, error() {} } });
  try {
    client.start();
    assert.equal(client.connected, false, 'not configured: nothing dials');
    await store.update({ enabled: true, url: fake.url, groups: ['555555555'] });
    client.applyConfig();
    await until(() => client.connected, 'the redial after enabling');
    // a different endpoint: the old socket goes away, the new one opens
    const fake2 = await startFakeOneBot();
    try {
    await store.update({ url: fake2.url });
      client.applyConfig();
    await until(() => client.connected && fake2.auths.length > 0, 'the new endpoint');
    await store.update({ enabled: false });
      client.applyConfig();
    await until(() => !client.connected && client.status().enabled === false, 'the disconnect after disabling');
    } finally { await fake2.close(); }
  } finally { client.close(); await fake.close(); }
});

test('end to end: the console configures OneBot, a room recruits into the QQ group, the cooldown holds', async () => {
  const fake = await startFakeOneBot();
  const configFile = tmpFile('e2e.json');
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, adminSecret: SECRET, onebotConfigFile: configFile });
  /** @type {TestClient | null} */
  let c = null;
  try {
    // the console: defaults, then the real configuration
    const first = await (await fetch(`${srv.url}/api/admin/onebot`, { headers: { authorization: `Bearer ${SECRET}` } })).json();
    assert.equal(first.ok, true);
    assert.equal(first.config.enabled, false);
    assert.equal(first.config.tokenSet, false);
    const saved = await (await fetch(`${srv.url}/api/admin/onebot/config`, {
      method: 'POST', headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, url: fake.url, token: 'grp-token', groups: ['987654321'], cooldownSec: 120 }),
    })).json();
    assert.equal(saved.ok, true, saved.error || '');
    assert.equal(saved.config.tokenSet, true);
    // the token is never sent back to the console
    const after = await (await fetch(`${srv.url}/api/admin/onebot`, { headers: { authorization: `Bearer ${SECRET}` } })).json();
    assert.equal(JSON.stringify(after).includes('grp-token'), false);
    assert.equal(after.config.tokenSet, true);
    await until(() => srv.onebot.connected && fake.auths.length > 0, 'the server to dial the fake OneBot');

    // the player path
    c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    await c.hello('博士');
    const created = await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 4 });
    assert.equal(created.t, 'ok', JSON.stringify(created));
    const state = await c.waitFor('room.state');
    assert.deepEqual(state.recruit, { cooldownSec: 120 });

    const sent = await c.request({ t: 'room.recruit', rid: null });
    assert.equal(sent.t, 'ok', JSON.stringify(sent));
    await until(() => fake.requests.length >= 1, 'the group message');
    const req = fake.requests[0];
    assert.equal(req.action, 'send_group_msg');
    assert.equal(req.params.group_id, 987654321);
    const text = req.params.message?.[0]?.data?.text || '';
    assert.ok(text.includes(state.code), `the template carries the room code: ${text}`);
    assert.ok(text.includes('博士'), `the template carries the host name: ${text}`);
    assert.ok(text.includes('1/4'), `the template carries the player count: ${text}`);

    // the per-room cooldown (120 s) answers RATE before anything is sent again
    const again = await c.request({ t: 'room.recruit', rid: null });
    assert.equal(again.t, 'error');
    assert.equal(again.code, 'RATE');
    assert.equal(fake.requests.length, 1, 'the refused attempt sent nothing');

    // the console's test line goes to the configured group too
    const testSend = await (await fetch(`${srv.url}/api/admin/onebot/test`, {
      method: 'POST', headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, body: '{}',
    })).json();
    assert.equal(testSend.ok, true, JSON.stringify(testSend));
    await until(() => fake.requests.length >= 2, 'the test message');
    assert.equal(fake.requests[1].action, 'send_group_msg');

    // reconnect endpoint answers ok
    const re = await (await fetch(`${srv.url}/api/admin/onebot/reconnect`, {
      method: 'POST', headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, body: '{}',
    })).json();
    assert.equal(re.ok, true);
  } finally {
    await c?.close().catch(() => {});
    await srv.close();
    await fake.close();
  }
});

test('end to end: no OneBot configured — no recruit flag, ONEBOT_UNAVAILABLE on the button', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, onebotConfigFile: tmpFile('off.json') });
  /** @type {TestClient | null} */
  let c = null;
  try {
    c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    await c.hello('博士');
    const created = await c.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY', capacity: 4 });
    assert.equal(created.t, 'ok', JSON.stringify(created));
    const state = await c.waitFor('room.state');
    assert.equal(state.recruit, undefined, 'an unconfigured server does not advertise the button');
    const refused = await c.request({ t: 'room.recruit', rid: null });
    assert.equal(refused.code, 'ONEBOT_UNAVAILABLE');
  } finally { await c?.close().catch(() => {}); await srv.close(); }
});

test('end to end: solo rooms cannot recruit', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, onebotConfigFile: tmpFile('solo.json') });
  /** @type {TestClient | null} */
  let c = null;
  try {
    c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    await c.hello('博士');
    const created = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'FUNNY' });
    assert.equal(created.t, 'ok', JSON.stringify(created));
    const state = await c.waitFor('room.state');
    assert.equal(state.recruit, undefined);
    const refused = await c.request({ t: 'room.recruit', rid: null });
    assert.equal(refused.code, 'WRONG_PHASE');
  } finally { await c?.close().catch(() => {}); await srv.close(); }
});

// ---- reverse mode (反向 WS): the OneBot implementation dials the game server -------------------------------------

/** A fake OneBot implementation as a reverse-mode CLIENT: it dials the game server and answers API requests. */
function fakeNapCat(ws, { replies = true } = {}) {
  const requests = [];
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    requests.push(msg);
    if (replies) ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: msg.echo }));
  });
  return {
    requests,
    /** Settles whether the socket is open or already closed (a replaced connection is closed by the server). */
    close: () => new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', resolve);
      ws.close();
    }),
  };
}

/** Connect a ws client like an OneBot implementation would. */
const dial = (url, token, query) => new Promise((resolve, reject) => {
  const ws = new WebSocket(query ? `${url}?access_token=${query}` : url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  ws.once('open', () => resolve(ws));
  ws.once('error', (e) => reject(e));
  ws.once('unexpected-response', (_req, res) => { ws.terminate(); reject(new Error(`HTTP ${res.statusCode}`)); });
});

test('reverse mode unit: /onebot/ws token handshake, message flow, replacement and the closed states', async () => {
  const store = createOneBotConfig({ file: tmpFile('rev.json') });
  await store.ready;
  const client = createOneBotClient({ config: store, log: { info() {}, warn() {}, error() {} } });
  const server = http.createServer(() => {});
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://localhost');
    if (client.upgradeHook(req, { rawPath: u.pathname, query: u.search ? u.search.slice(1) : '' }, socket, head)) return;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}${ONEBOT_SERVER_PATH}`;
  /** @type {any} */
  let bot = null;
  try {
    // not enabled: the path does not exist (fail closed)
    await assert.rejects(dial(url, 'x'), /HTTP 404/);
    await store.update({ mode: 'server', enabled: true, token: 'rev-token', groups: ['777777777'] });
    client.start();
    // a wrong token, and a missing one, are refused
    await assert.rejects(dial(url, 'wrong'), /HTTP 401/);
    await assert.rejects(dial(url, ''), /HTTP 401/);
    // the right token (header form) opens the channel and the message flows both ways
    bot = fakeNapCat(await dial(url, 'rev-token'));
    await until(() => client.connected, 'the implementation to be accepted');
    const res = await client.broadcast('反向测试');
    assert.deepEqual(res, { ok: true, sent: 1, total: 1, failed: [] });
    assert.equal(bot.requests[0].action, 'send_group_msg');
    assert.equal(bot.requests[0].params.group_id, 777777777);
    // the query-parameter form authenticates too (the form NapCat uses). The connection handler swaps the client set
    // synchronously, so from here on only bot2 receives.
    const bot2 = fakeNapCat(await dial(url, '', 'rev-token'));
    const res2 = await client.broadcast('第二条');
    assert.equal(res2.sent, 1);
    assert.equal(bot2.requests[0].action, 'send_group_msg');
    assert.equal(bot.requests.length, 1, 'the replaced connection no longer receives');
    // other paths are not claimed: the hook falls through, and this raw test server (no /ws handler) destroys them
    await assert.rejects(dial(`ws://127.0.0.1:${server.address().port}/nope`, ''), /ECONN|HTTP 404|closed|hang up/);
    await bot2.close();
    await until(() => !client.connected, 'the disconnect when the implementation leaves');
  } finally {
    client.close();
    await bot?.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('end to end: reverse mode — the console flips the mode, NapCat dials the game server, a room recruits', async () => {
  const configFile = tmpFile('rev-e2e.json');
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, adminSecret: SECRET, onebotConfigFile: configFile });
  /** @type {TestClient | null} */
  let c = null;
  /** @type {any} */
  let bot = null;
  try {
    const saved = await (await fetch(`${srv.url}/api/admin/onebot/config`, {
      method: 'POST', headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, mode: 'server', token: 'napcat-token', groups: ['555000111'], cooldownSec: 0, linkBase: 'https://game.example.com' }),
    })).json();
    assert.equal(saved.ok, true, saved.error || '');
    // the console sees the mode and the endpoint path, never the token
    const info = await (await fetch(`${srv.url}/api/admin/onebot`, { headers: { authorization: `Bearer ${SECRET}` } })).json();
    assert.equal(info.config.mode, 'server');
    assert.equal(info.status.path, ONEBOT_SERVER_PATH);
    assert.equal(info.status.listening, true);
    assert.equal(JSON.stringify(info).includes('napcat-token'), false);

    bot = fakeNapCat(await dial(`ws://127.0.0.1:${srv.port}${ONEBOT_SERVER_PATH}`, '', 'napcat-token'));
    await until(() => srv.onebot.connected, 'the implementation to connect');

    c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    await c.hello('博士');
    const created = await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 4 });
    assert.equal(created.t, 'ok', JSON.stringify(created));
    const sent = await c.request({ t: 'room.recruit', rid: null });
    assert.equal(sent.t, 'ok', JSON.stringify(sent));
    await until(() => bot.requests.length >= 1, 'the group message through the reverse channel');
    const text = bot.requests[0].params.message?.[0]?.data?.text || '';
    const state = await c.waitFor('room.state');
    assert.ok(text.includes('https://game.example.com/?room=' + state.code), `the template carries the clickable link: ${text}`);
  } finally {
    await c?.close().catch(() => {});
    try { await bot?.close(); } catch { /* ignore */ }
    await srv.close();
  }
});
