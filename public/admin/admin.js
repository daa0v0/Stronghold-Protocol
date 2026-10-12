// public/admin/admin.js — 运维后台 (docs/ADMIN.md). No dependencies, no build step: the console must load on a server
// that is already in trouble, so it is plain DOM + fetch against /api/admin/*.
//
// Every server value is written with textContent (never innerHTML): player names and room codes are attacker-controlled
// strings, and an operator console is exactly where a stored XSS would hurt most.
const API = '/api/admin';
const POLL_MS = 2000;
const $ = (id) => document.getElementById(id);

/** @type {{ since: number, timer: number|null, running: boolean }} */
const state = { since: 0, timer: null, running: false };

/**
 * One API call. Resolves `{ status, body }`; `status: 0` means the request itself failed (server restarting, offline).
 * A call with a body is a POST unless it says otherwise: `fetch` throws on a GET with a body, and swallowing that into
 * `status: 0` looks exactly like a server outage.
 * @param {string} path @param {{ method?: string, body?: object }} [opts]
 */
async function api(path, opts = {}) {
  try {
    const method = opts.method || (opts.body ? 'POST' : 'GET');
    const res = await fetch(API + path, {
      method,
      credentials: 'same-origin',
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
    });
    let body = null;
    try { body = await res.json(); } catch { /* a 503/404 html page */ }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
const text = (id, value) => { const el = $(id); if (el) el.textContent = value == null ? '—' : String(value); };
const secs = (n) => {
  const s = Math.max(0, Math.round(n || 0));
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  const h = Math.floor(s / 3600);
  return h + ' 时 ' + Math.floor((s % 3600) / 60) + ' 分';
};

/** Render the screens: disabled (404) / login (401) / dashboard (200). */
function screen(which) {
  show('screen-disabled', which === 'disabled');
  show('screen-login', which === 'login');
  show('dashboard', which === 'dashboard');
  show('btn-logout', which === 'dashboard');
}

function setState(textValue, cls) {
  const el = $('badge-state');
  el.textContent = textValue;
  el.className = 'badge ' + (cls || 'badge--dim');
}

// ---- overview ---------------------------------------------------------------------------------------------
function renderOverview(o) {
  text('badge-app', 'v' + o.version.app);
  text('badge-build', 'build ' + (o.version.build || '—'));
  text('stat-conn', o.network.connections);
  text('stat-sessions', o.network.sessions);
  text('stat-humans', o.network.connectedPlayers);
  text('stat-rooms', o.lobby.rooms);
  text('stat-matches', o.lobby.matches);
  text('stat-bots', o.lobby.bots);
  text('stat-spec', o.lobby.spectators);
  text('stat-rss', o.process.rssMb);
  text('stat-heap', o.process.heapUsedMb);
  text('stat-uptime', secs(o.process.uptimeSec));
  text('stat-load', o.host.loadavg ? o.host.loadavg.join(' / ') : 'n/a');
  text('stat-sysmem', Math.round((o.system.totalMb - o.system.freeMb) / 1024) + ' / ' + Math.round(o.system.totalMb / 1024) + ' GB');
  text('stat-host', o.host.hostname + ' · ' + o.host.platform + '/' + o.host.arch + ' · node ' + o.version.node);

  const maint = o.maintenance || {};
  const active = !!maint.active;
  const badge = $('maint-badge');
  badge.textContent = active ? '维护中' : '正常';
  badge.className = 'badge ' + (active ? 'badge--on' : 'badge--off');
  $('btn-maint-on').disabled = active;
  $('btn-maint-off').disabled = !active;

  $('info-settings').textContent = JSON.stringify(o.settings ?? '（不可用）', null, 2);
  $('info-assets').textContent = JSON.stringify(o.assetCache ?? '（不可用）', null, 2);
}

// ---- rooms ------------------------------------------------------------------------------------------------
function renderRooms(list) {
  const body = $('rooms-body');
  body.textContent = '';
  text('rooms-count', list.length);
  show('rooms-empty', list.length === 0);
  for (const r of list) {
    const tr = document.createElement('tr');
    const cell = (value, cls) => { const td = document.createElement('td'); td.textContent = value == null ? '—' : String(value); if (cls) td.className = cls; return td; };
    tr.append(
      cell(r.code),
      cell(r.mode === 'solo' ? '独立' : '同盟'),
      cell(r.difficulty),
      cell(r.capacity, 'num'),
      cell(r.humans, 'num'),
      cell(r.bots, 'num'),
      cell(r.spectators, 'num'),
      cell(r.inMatch ? '进行中' : '等待中', r.inMatch ? 'state-live' : 'state-idle'),
      cell(r.phase || '—', r.paused ? 'state-frozen' : null),
      cell(r.round || '—', 'num'),
      cell((r.poolGroups || []).map((g) => g.playerIds.length).join('+') || '—', 'grp'),
      cell(secs((r.ageMs || 0) / 1000)),
    );
    const td = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'btn btn--danger';
    btn.textContent = '关闭';
    btn.addEventListener('click', async () => {
      if (!confirm(`确定关闭房间 ${r.code}？房间内所有人会回到大厅。`)) return;
      const res = await api('/rooms/close', { body: { code: r.code } });
      if (res.status !== 200) alert('关闭失败：' + ((res.body && res.body.error) || res.status));
      await poll();
    });
    td.append(btn);
    tr.append(td);
    body.append(tr);
  }
}

// ---- logs -------------------------------------------------------------------------------------------------
function appendLogs(entries) {
  const box = $('logs');
  const follow = $('logs-follow').checked;
  for (const e of entries) {
    const line = document.createElement('div');
    line.className = 'l-' + (['info', 'warn', 'error', 'debug'].includes(e.level) ? e.level : 'info');
    const when = document.createElement('span');
    when.className = 't';
    when.textContent = new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false }) + ' ';
    line.append(when, document.createTextNode(e.text));
    box.append(line);
  }
  while (box.childElementCount > 400) box.removeChild(box.firstChild);
  if (follow) box.scrollTop = box.scrollHeight;
  text('logs-count', box.childElementCount);
}

// ---- polling ----------------------------------------------------------------------------------------------
let polling = false;
/**
 * 内容包 panel (docs/PACKS.md §4): the server-level mod switches. Every value goes in through textContent, like the rest
 * of this console. A language pack has no switch (it is part of the client's own UI); a pack that is outside its app
 * range and changes the game offers 确认加载 instead of 启用.
 * @param {{ packs?: any[], tag?: string, policy?: any }} body
 */
function renderPacks(body) {
  const tbody = $('packs-body');
  if (!tbody) return;
  tbody.textContent = '';
  const packs = (body && body.packs) || [];
  text('packs-count', packs.length);
  text('packs-tag', body && body.tag ? body.tag : '—');
  show('packs-empty', packs.length === 0);
  for (const p of packs) {
    const tr = document.createElement('tr');
    const cell = (value, cls) => {
      const td = document.createElement('td');
      td.textContent = value == null || value === '' ? '—' : String(value);
      if (cls) td.className = cls;
      tr.appendChild(td);
      return td;
    };
    cell(p.type);
    cell(p.id, 'mono');
    cell(p.name);
    cell(p.version);
    cell(p.app || '任意');
    cell(!p.enabled ? (p.reason === 'off' ? '已停用' : '待确认') : '已加载', !p.enabled ? 'state-frozen' : 'state-live');
    cell([p.overrides ? p.overrides + ' 项替换' : null, p.patches ? p.patches + ' 张表' : null, p.strings ? p.strings + ' 条文案' : null].filter(Boolean).join(' · '));
    const actions = document.createElement('td');
    actions.className = 'row';
    if (p.type !== 'lang') {
      actions.appendChild(packButton(p.enabled ? '停用' : '启用', p.enabled ? 'btn--danger' : 'btn--primary',
        () => setPack({ id: p.id, enabled: !p.enabled })));
      if (!p.compatible && !p.enabled) {
        actions.appendChild(packButton('确认加载', 'btn--warn', () => setPack({ id: p.id, confirmed: true })));
      }
    }
    if (p.live === false) {
      const note = document.createElement('span');
      note.className = 'dim';
      note.textContent = '重启后生效';
      note.title = '数据包的表在服务器启动时就固定了，切换要重启';
      actions.appendChild(note);
    }
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
}

/** A small button for the pack table. */
function packButton(label, cls, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn ' + (cls || 'btn--ghost');
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

/** Flip one pack switch, then redraw from the answer (the server re-scans in the same request). */
async function setPack(body) {
  const res = await api('/packs', { body });
  if (res.status === 200) {
    renderPacks(res.body);
    if (res.body && res.body.restartRequired) alert('已保存。这个数据包的表在服务器启动时固定，重启后生效。');
    return;
  }
  const why = res.body && res.body.error;
  alert(why === 'LANGUAGE_LOCKED' ? '语言包不能停用：它是客户端自身的一部分，其他语言还要回退到英文。'
    : why === 'UNKNOWN_PACK' ? '这个包已经不在了，列表已刷新。'
      : '操作失败：' + (why || res.status));
  poll();
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const ov = await api('/overview');
    if (ov.status === 404) { setState('后台未启用', 'badge--off'); screen('disabled'); return; }
    if (ov.status === 401 || ov.status === 0 && !state.running) { setState(ov.status === 0 ? '连接中断' : '需要验证', 'badge--off'); screen('login'); return; }
    if (ov.status === 200 && ov.body) { state.running = true; screen('dashboard'); renderOverview(ov.body); setState('运行中', 'badge'); }
    else setState('连接中断', 'badge--off');

    const rooms = await api('/rooms');
    if (rooms.status === 200 && rooms.body) renderRooms(rooms.body.rooms || []);

    const packs = await api('/packs');
    if (packs.status === 200 && packs.body) renderPacks(packs.body);

    const logs = await api('/logs?since=' + state.since + '&limit=200');
    if (logs.status === 200 && logs.body) {
      appendLogs(logs.body.entries || []);
      state.since = logs.body.nextSeq || state.since;
    }
  } finally {
    polling = false;
  }
}

function startPolling() {
  if (state.timer) return;
  poll();
  state.timer = setInterval(() => { if (!document.hidden) poll(); else return; }, POLL_MS);
}

// ---- actions ----------------------------------------------------------------------------------------------
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const err = $('login-error');
  err.hidden = true;
  const res = await api('/login', { method: 'POST', body: { secret: $('login-secret').value } });
  if (res.status === 200) {
    $('login-secret').value = '';
    await poll();
    startPolling();
    return;
  }
  err.textContent = res.status === 429
    ? '尝试次数过多，请稍后重试。'
    : res.status === 0 ? '无法连接服务器。' : '密钥无效。';
  err.hidden = false;
});

$('btn-logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST', body: {} });
  state.running = false;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  setState('已退出', 'badge--off');
  screen('login');
});

$('btn-bcast').addEventListener('click', async () => {
  const input = $('bcast-text');
  const value = input.value.trim();
  if (!value) return;
  const btn = $('btn-bcast');
  btn.disabled = true;
  const res = await api('/broadcast', { body: { text: value, kind: $('bcast-kind').value } });
  btn.disabled = false;
  if (res.status === 200) { input.value = ''; alert('已发送给 ' + res.body.connections + ' 个连接。'); }
  else alert('发送失败：' + ((res.body && res.body.error) || res.status));
});

async function maintenance(on) {
  if (on && !confirm('开启维护模式？\n\n· 拒绝新房间与新加入\n· 冻结进行中的对局\n· 断开普通 HTTP 连接（后台本身仍可用）')) return;
  const res = await api('/maintenance', { body: { on } });
  if (res.status !== 200) alert('操作失败：' + ((res.body && res.body.error) || res.status));
  setTimeout(poll, 400);
}
$('btn-maint-on').addEventListener('click', () => maintenance(true));
$('btn-maint-off').addEventListener('click', () => maintenance(false));

document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

// ---- boot -------------------------------------------------------------------------------------------------
(async () => {
  const first = await api('/overview');
  if (first.status === 404) { screen('disabled'); return; }
  if (first.status === 401 || first.status === 0) { setState(first.status === 0 ? '连接中断' : '需要验证', 'badge--off'); screen('login'); return; }
  state.running = true;
  screen('dashboard');
  renderOverview(first.body);
  setState('运行中', 'badge');
  startPolling();
})();
