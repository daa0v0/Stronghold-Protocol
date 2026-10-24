// public/admin/admin.js — 运维后台 (docs/ADMIN.md). No dependencies, no build step: the console must load on a server
// that is already in trouble, so it is plain DOM + fetch against /api/admin/*.
//
// Every server value is written with textContent (never innerHTML): player names and room codes are attacker-controlled
// strings, and an operator console is exactly where a stored XSS would hurt most.
const API = '/api/admin';
const POLL_MS = 2000;
const $ = (id) => document.getElementById(id);

/** @type {{ since: number, timer: number|null, running: boolean, identity: { kind: string, id: string, name: string }|null, editing: string|null }} */
const state = { since: 0, timer: null, running: false, identity: null, editing: null };

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

/** Who is logged in (owner, or one operator account). The badge is the only place the console names the identity. */
function renderIdentity(identity) {
  state.identity = identity || null;
  const badge = $('badge-who');
  if (!identity) { badge.hidden = true; badge.textContent = ''; $('operators-panel').hidden = true; return; }
  badge.hidden = false;
  badge.textContent = identity.kind === 'owner' ? '主密钥' : `${identity.name}（${identity.id}）`;
  // Only the owner manages the operator accounts: creating an account is handing out console access.
  $('operators-panel').hidden = identity.kind !== 'owner';
  if (identity.kind === 'owner') loadOperators();
}

/** Ask the server who this cookie belongs to (also covers a reload, where the login response is long gone). */
async function loadSession() {
  const res = await api('/session');
  if (res.status === 200 && res.body && res.body.identity) renderIdentity(res.body.identity);
  else renderIdentity(null);
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

// ---- accounts ----------------------------------------------------------------------------------------------
// The account console: the list with a name filter, and the three operator actions (reset the password, ban,
// delete). The server owns the rules; the console only asks and reports.

/** Render the account table. A username is attacker-controlled, so every cell goes through textContent. */
function renderAccounts(result) {
  const body = $('accounts-body');
  body.textContent = '';
  const list = (result && result.accounts) || [];
  text('accounts-count', (result && result.total) || 0);
  show('accounts-empty', list.length === 0);
  for (const a of list) {
    const tr = document.createElement('tr');
    const cell = (value, cls) => { const td = document.createElement('td'); td.textContent = value == null ? '—' : String(value); if (cls) td.className = cls; return td; };
    tr.append(
      cell(a.username),
      cell(a.createdAt ? new Date(a.createdAt).toLocaleString('zh-CN') : '—'),
      cell(a.skinCount, 'num'),
      cell(a.tokenCount, 'num'),
      cell(a.banned ? '已封禁' : '正常', a.banned ? 'state-frozen' : 'state-live'),
    );
    const td = document.createElement('td');
    td.className = 'acct-actions';
    const add = (label, cls, handler) => {
      const btn = document.createElement('button');
      btn.className = 'btn ' + cls;
      btn.textContent = label;
      btn.addEventListener('click', handler);
      td.append(btn);
      return btn;
    };
    add('重置密码', 'btn--ghost', async () => {
      const password = prompt(`为 ${a.username} 设置新密码（至少 8 位）。\n\n该账号的所有登录设备都会被登出。`);
      if (password == null) return;
      if (password.length < 8) { alert('密码至少 8 位。'); return; }
      const res = await api('/accounts/password', { body: { username: a.username, password } });
      if (res.status !== 200) alert('重置失败：' + ((res.body && res.body.error) || res.status));
      else alert('已重置 ' + a.username + ' 的密码。');
      await loadAccounts();
    });
    add(a.banned ? '解封' : '封禁', a.banned ? 'btn--ghost' : 'btn--warn', async () => {
      if (!a.banned) {
        const reason = prompt(`封禁 ${a.username} 的原因（可留空）：`) || '';
        if (!confirm(`确定封禁 ${a.username}？\n\n· 该账号无法登录\n· 已登录的设备会被登出\n· 账号数据保留，可随时解封`)) return;
        const res = await api('/accounts/ban', { body: { username: a.username, banned: true, reason } });
        if (res.status !== 200) alert('封禁失败：' + ((res.body && res.body.error) || res.status));
      } else {
        if (!confirm(`确定解封 ${a.username}？`)) return;
        const res = await api('/accounts/ban', { body: { username: a.username, banned: false } });
        if (res.status !== 200) alert('解封失败：' + ((res.body && res.body.error) || res.status));
      }
      await loadAccounts();
    });
    add('删除', 'btn--danger', async () => {
      if (!confirm(`确定删除账号 ${a.username}？\n\n此操作不可恢复：账号、皮肤与登录凭据全部清除，用户名会被释放。`)) return;
      const again = prompt('为确认，请再输入一次用户名：');
      if (again !== a.username) { alert('用户名不匹配，未删除。'); return; }
      const res = await api('/accounts/delete', { body: { username: a.username } });
      if (res.status !== 200) alert('删除失败：' + ((res.body && res.body.error) || res.status));
      else alert('已删除 ' + a.username + '。');
      await loadAccounts();
    });
    tr.append(td);
    body.append(tr);
  }
}

/** Ask the server for the accounts (optionally filtered by a name fragment). */
async function loadAccounts() {
  const q = ($('acct-query').value || '').trim();
  const res = await api('/accounts' + (q ? '?q=' + encodeURIComponent(q) : ''));
  if (res.status === 503) {
    text('accounts-count', 0);
    show('accounts-empty', true);
    $('accounts-empty').textContent = '这台服务器没有启用账号功能。';
    return;
  }
  if (res.status !== 200) { alert('读取账号失败：' + ((res.body && res.body.error) || res.status)); return; }
  renderAccounts(res.body);
}

// ---- announcements -----------------------------------------------------------------------------------------
// The公告 console: publish a Markdown notice, correct a published one, pin the one the lobby opens, and push an
// explicit notice to players who are already in a match. Every title/id is operator-supplied, so they go through
// textContent like everything else. The author recorded on each announcement is the identity that published it.

/** Render the announcement table. */
function renderAnnouncements(result) {
  const body = $('ann-body-list');
  body.textContent = '';
  const list = (result && result.items) || [];
  text('ann-count', list.length);
  show('ann-empty', list.length === 0);
  const pinned = (result && result.pinnedId) || '';
  const badge = $('ann-pinned');
  badge.hidden = !pinned;
  if (pinned) badge.textContent = '置顶：' + pinned;

  for (const a of list) {
    const tr = document.createElement('tr');
    const cell = (value, cls) => { const td = document.createElement('td'); td.textContent = value == null ? '—' : String(value); if (cls) td.className = cls; return td; };
    tr.append(
      cell(a.id, 'mono'),
      cell(a.title),
      cell(a.author || '—', a.author ? 'mono' : null),
      cell(a.publishedAt ? new Date(a.publishedAt).toLocaleString('zh-CN') : '—'),
      cell(a.pinned ? '已置顶' : '—', a.pinned ? 'state-live' : null),
    );
    const td = document.createElement('td');
    td.className = 'acct-actions';

    const add = (label, cls, handler) => {
      const btn = document.createElement('button');
      btn.className = 'btn ' + cls;
      btn.textContent = label;
      btn.addEventListener('click', handler);
      td.append(btn);
      return btn;
    };

    // 修改：把这条公告读回表单（编号不变，只改标题与正文）
    add('修改', 'btn--ghost', async () => {
      const res = await api('/announcements?id=' + encodeURIComponent(a.id));
      if (res.status !== 200 || !res.body.item) { alert('读取公告失败：' + ((res.body && res.body.error) || res.status)); return; }
      startEdit(res.body.item);
    });

    if (a.pinned) {
      add('取消置顶', 'btn--ghost', async () => {
        const res = await api('/announcements/unpin', { body: {} });
        if (res.status !== 200) alert('取消置顶失败：' + ((res.body && res.body.error) || res.status));
        await loadAnnouncements();
      });
    } else {
      add('置顶', 'btn--ghost', async () => {
        const res = await api('/announcements/pin', { body: { id: a.id } });
        if (res.status !== 200) alert('置顶失败：' + ((res.body && res.body.error) || res.status));
        await loadAnnouncements();
      });
    }

    add('通知在线玩家', 'btn--warn', async () => {
      if (!confirm(`向在线玩家弹出公告「${a.title}」？\n\n正在对局中的玩家也会收到。`)) return;
      const res = await api('/announcements/notify', { body: { id: a.id } });
      if (res.status !== 200) alert('通知失败：' + ((res.body && res.body.error) || res.status));
      else alert('已提交，约 1 秒内送达在线玩家。');
    });

    add('复制 ID', 'btn--ghost', async () => {
      try { await navigator.clipboard.writeText(a.id); alert('已复制：' + a.id); }
      catch { prompt('复制这个 ID：', a.id); }
    });

    tr.append(td);
    body.append(tr);
  }
}

/** Ask the server for the catalog. */
async function loadAnnouncements() {
  const res = await api('/announcements');
  if (res.status === 503) {
    text('ann-count', 0);
    show('ann-empty', true);
    $('ann-empty').textContent = '这台服务器没有启用公告功能。';
    return;
  }
  if (res.status !== 200) { $('ann-msg').textContent = '读取公告失败：' + ((res.body && res.body.error) || res.status); return; }
  renderAnnouncements(res.body);
}

/** 载入一条已发布公告进入表单：编号固定不可改，标题与正文可改。 */
function startEdit(item) {
  state.editing = item.id;
  $('ann-id').value = item.id;
  $('ann-id').readOnly = true;
  $('ann-title').value = item.title || '';
  $('ann-body').value = item.markdown || '';
  $('ann-pin').checked = false;
  $('ann-pin').disabled = true;
  $('btn-ann-publish').textContent = '保存修改';
  $('ann-form-summary').textContent = `修改公告 ${item.id}（编号与发布时间不变）`;
  $('ann-form-panel').open = true;
  $('ann-msg').textContent = item.author ? `原发布者：${item.author}` : '';
  $('ann-title').focus();
}

/** 回到发布新公告的状态。 */
function resetAnnouncementForm() {
  state.editing = null;
  $('ann-id').value = '';
  $('ann-id').readOnly = false;
  $('ann-title').value = '';
  $('ann-body').value = '';
  $('ann-pin').checked = false;
  $('ann-pin').disabled = false;
  $('btn-ann-publish').textContent = '发布';
  $('ann-form-summary').textContent = '发布新公告';
  $('ann-msg').textContent = '';
}

// ---- OneBot 群招募 ------------------------------------------------------------------------------------------
// The forward-WS OneBot client's console: config + live status in one answer (GET /onebot), saved whole
// (POST /onebot/config), plus 重连 and a fixed test line. The token never comes back — the form only says whether one
// is set, and an empty input means "leave it as is".

/** Parse the group textarea: numbers split by newlines, commas (both widths), semicolons or spaces. */
function parseGroups() {
  return ($('ob-groups').value || '').split(/[\s,，;；、]+/).map((s) => s.trim()).filter(Boolean);
}

/** The suggested reverse-WS URL for the OneBot implementation: this page's own host + the fixed path. */
function suggestServerUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host + ($('ob-path') ? $('ob-path').textContent : '/onebot/ws');
}

/** Show/hide the mode-specific fields. */
function renderOnebotMode(mode) {
  const server = mode === 'server';
  $('ob-url-row').hidden = server;
  $('ob-server-hint').hidden = !server;
  if (server) $('ob-server-url').textContent = suggestServerUrl();
}

function renderOnebotStatus(st) {
  const badge = $('ob-badge');
  if (!st) { badge.textContent = '—'; badge.className = 'badge badge--dim'; return; }
  const server = st.mode === 'server';
  if (st.connected) { badge.textContent = server ? '已连入' : '已连接'; badge.className = 'badge badge--on'; }
  else if (st.connecting) { badge.textContent = '连接中'; badge.className = 'badge badge--dim'; }
  else if (server && st.listening) { badge.textContent = '等待 OneBot 连入'; badge.className = 'badge badge--dim'; }
  else { badge.textContent = st.enabled ? '未连接' : '未启用'; badge.className = 'badge badge--off'; }
  const view = {
    ...st,
    lastErrorAt: st.lastErrorAt ? new Date(st.lastErrorAt).toLocaleString('zh-CN') : null,
    lastSentAt: st.lastSentAt ? new Date(st.lastSentAt).toLocaleString('zh-CN') : null,
  };
  $('ob-status').textContent = JSON.stringify(view, null, 2);
}

/** Load config + status into the form. The panel stays usable; 503 only means this deployment has no OneBot module. */
async function loadOnebot() {
  const res = await api('/onebot');
  if (res.status === 503) {
    $('ob-msg').textContent = '这台服务器没有启用 OneBot 群招募功能。';
    $('ob-status').textContent = '—';
    renderOnebotStatus(null);
    return;
  }
  if (res.status !== 200) { $('ob-msg').textContent = '读取 OneBot 配置失败：' + ((res.body && res.body.error) || res.status); return; }
  const { config, status } = res.body;
  $('ob-enabled').checked = !!config.enabled;
  $('ob-mode').value = config.mode === 'server' ? 'server' : 'client';
  renderOnebotMode(config.mode === 'server' ? 'server' : 'client');
  $('ob-url').value = config.url || '';
  $('ob-token').value = '';
  $('ob-token-hint').textContent = config.tokenSet ? '已设置' : '未设置';
  $('ob-groups').value = (config.groups || []).join('\n');
  $('ob-template').value = config.template || '';
  $('ob-link-base').value = config.linkBase || '';
  $('ob-cooldown').value = config.cooldownSec ?? 60;
  $('ob-msg').textContent = '';
  renderOnebotStatus(status);
}

/** Save the form (token only when typed) and refresh the status; server errors come back as Chinese text. */
$('btn-ob-save').addEventListener('click', async () => {
  const msg = $('ob-msg');
  const body = {
    enabled: $('ob-enabled').checked,
    mode: $('ob-mode').value,
    url: $('ob-url').value.trim(),
    groups: parseGroups(),
    template: $('ob-template').value,
    linkBase: $('ob-link-base').value.trim(),
    cooldownSec: Number($('ob-cooldown').value) || 0,
  };
  const token = $('ob-token').value;
  if (token) body.token = token;
  const btn = $('btn-ob-save');
  btn.disabled = true;
  const res = await api('/onebot/config', { body });
  btn.disabled = false;
  if (res.status !== 200) { msg.textContent = '保存失败：' + ((res.body && res.body.error) || res.status); return; }
  msg.textContent = '已保存并应用到运行中的服务器。';
  await loadOnebot();
});

$('ob-mode').addEventListener('change', () => renderOnebotMode($('ob-mode').value));

$('btn-ob-reconnect').addEventListener('click', async () => {
  const res = await api('/onebot/reconnect', { body: {} });
  $('ob-msg').textContent = res.status === 200
    ? ($('ob-mode').value === 'server' ? '已断开现有连接，OneBot 会用新配置重新连入。' : '已按当前配置重新连接。')
    : '重连失败：' + ((res.body && res.body.error) || res.status);
  setTimeout(loadOnebot, 800);
});

$('btn-ob-test').addEventListener('click', async () => {
  const res = await api('/onebot/test', { body: {} });
  if (res.status === 200) $('ob-msg').textContent = `测试消息已发送（${res.body.sent}/${res.body.total} 个群成功）。`;
  else $('ob-msg').textContent = '测试失败：' + ((res.body && res.body.error) || res.status) + (res.body && res.body.failed ? ` ${res.body.failed.map((f) => f.group + ': ' + f.error).join('; ')}` : '');
  await loadOnebot();
});

$('btn-ob-clear-token').addEventListener('click', async () => {
  if (!confirm('清除已保存的 OneBot Access Token？\n\n未设置 Token 的 OneBot 实现仍可连接（取决于其配置）。')) return;
  const res = await api('/onebot/config', { body: { token: '' } });
  $('ob-msg').textContent = res.status === 200 ? '已清除 Token。' : '清除失败：' + ((res.body && res.body.error) || res.status);
  await loadOnebot();
});

// ---- operators (the console's own operator accounts, owner only) ------------------------------------------
// Creating an account hands out console access, so these endpoints answer 403 for a non-owner identity and the
// section is hidden. The server owns the rules; the console only asks and reports.

function renderOperators(result) {
  const body = $('operators-body');
  body.textContent = '';
  const list = (result && result.accounts) || [];
  text('operators-count', (result && result.total) || 0);
  show('operators-empty', list.length === 0);
  for (const op of list) {
    const tr = document.createElement('tr');
    const cell = (value, cls) => { const td = document.createElement('td'); td.textContent = value == null ? '—' : String(value); if (cls) td.className = cls; return td; };
    tr.append(
      cell(op.id, 'mono'),
      cell(op.name),
      cell(op.createdAt ? new Date(op.createdAt).toLocaleString('zh-CN') : '—'),
      cell(op.lastLoginAt ? new Date(op.lastLoginAt).toLocaleString('zh-CN') : '从未登录'),
      cell(op.disabled ? '已停用' : '正常', op.disabled ? 'state-frozen' : 'state-live'),
    );
    const td = document.createElement('td');
    td.className = 'acct-actions';
    const add = (label, cls, handler) => {
      const btn = document.createElement('button');
      btn.className = 'btn ' + cls;
      btn.textContent = label;
      btn.addEventListener('click', handler);
      td.append(btn);
      return btn;
    };
    add('重置密码', 'btn--ghost', async () => {
      const password = prompt(`为运维账号 ${op.id} 设置新密码（至少 8 位）。\n\n该账号在所有设备上都要重新登录。`);
      if (password == null) return;
      if ([...password].length < 8) { alert('密码至少 8 位。'); return; }
      const res = await api('/operators/password', { body: { id: op.id, password } });
      if (res.status !== 200) alert('重置失败：' + ((res.body && res.body.error) || res.status));
      else alert('已重置 ' + op.id + ' 的密码。');
      await loadOperators();
    });
    add(op.disabled ? '恢复' : '停用', op.disabled ? 'btn--ghost' : 'btn--warn', async () => {
      if (!op.disabled && !confirm(`停用运维账号 ${op.id}？\n\n· 该账号无法登录\n· 已登录的会话立即失效`)) return;
      const res = await api('/operators/disabled', { body: { id: op.id, disabled: !op.disabled } });
      if (res.status !== 200) alert('操作失败：' + ((res.body && res.body.error) || res.status));
      await loadOperators();
    });
    add('删除', 'btn--danger', async () => {
      if (!confirm(`确定删除运维账号 ${op.id}？\n\n此操作不可恢复：该账号的登录凭据全部清除，ID 会被释放。`)) return;
      const again = prompt('为确认，请再输入一次账号 ID：');
      if (again !== op.id) { alert('ID 不匹配，未删除。'); return; }
      const res = await api('/operators/delete', { body: { id: op.id } });
      if (res.status !== 200) alert('删除失败：' + ((res.body && res.body.error) || res.status));
      else alert('已删除 ' + op.id + '。');
      await loadOperators();
    });
    tr.append(td);
    body.append(tr);
  }
}

/** Ask the server for the operator accounts. */
async function loadOperators() {
  if (!state.identity || state.identity.kind !== 'owner') return;
  const res = await api('/operators');
  if (res.status === 503) {
    text('operators-count', 0);
    show('operators-empty', true);
    $('operators-empty').textContent = '这台服务器没有启用运维账号功能。';
    return;
  }
  if (res.status === 403) { $('operators-panel').hidden = true; return; }
  if (res.status !== 200) { alert('读取运维账号失败：' + ((res.body && res.body.error) || res.status)); return; }
  renderOperators(res.body);
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
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const ov = await api('/overview');
    if (ov.status === 404) { setState('后台未启用', 'badge--off'); screen('disabled'); return; }
    if (ov.status === 401 || ov.status === 0 && !state.running) { setState(ov.status === 0 ? '连接中断' : '需要验证', 'badge--off'); screen('login'); return; }
    if (ov.status === 200 && ov.body) {
      state.running = true; screen('dashboard'); renderOverview(ov.body); setState('运行中', 'badge');
      await loadSession();
    }
    else setState('连接中断', 'badge--off');

    const rooms = await api('/rooms');
    if (rooms.status === 200 && rooms.body) renderRooms(rooms.body.rooms || []);

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
  // 账号 + 密码（运维账号）或留空账号直接用主密钥；两者共用同一个登录接口。
  // 两个字段都发：账号登录读 password，主密钥登录读 secret（服务端按有无账号 ID 二选一）。
  const id = $('login-id').value.trim();
  const credential = $('login-secret').value;
  const res = await api('/login', { method: 'POST', body: { id, password: credential, secret: credential } });
  if (res.status === 200) {
    $('login-secret').value = '';
    renderIdentity(res.body && res.body.identity ? res.body.identity : null);
    await poll();
    startPolling();
    return;
  }
  err.textContent = res.status === 429
    ? '尝试次数过多，请稍后重试。'
    : res.status === 503 ? '这台服务器没有启用运维账号功能。'
      : res.status === 0 ? '无法连接服务器。'
        : id ? '账号 ID 或密码错误。' : '密钥无效。';
  err.hidden = false;
});

$('btn-logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST', body: {} });
  state.running = false;
  state.identity = null;
  state.editing = null;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  renderIdentity(null);
  resetAnnouncementForm();
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

// The account console refreshes on demand (not on the 2 s poll): it changes rarely and the actions are explicit.
$('btn-acct-refresh').addEventListener('click', loadAccounts);
$('acct-query').addEventListener('search', loadAccounts);
$('acct-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadAccounts(); } });

// ---- announcement actions -----------------------------------------------------------------------------------
$('btn-ann-publish').addEventListener('click', async () => {
  const msg = $('ann-msg');
  const title = $('ann-title').value.trim();
  const markdown = $('ann-body').value;
  const editing = state.editing;
  const id = editing || $('ann-id').value.trim();
  if (!title) { msg.textContent = '标题不能为空。'; return; }
  if (!markdown.trim()) { msg.textContent = '正文不能为空。'; return; }
  if (!editing && id && !/^[a-z0-9_-]{1,64}$/.test(id)) { msg.textContent = 'ID 只能用小写字母、数字、下划线和连字符（1–64 位）。'; return; }
  const btn = $('btn-ann-publish');
  btn.disabled = true;
  if (!editing && $('ann-pin').checked && !confirm('发布并置顶？\n\n会取消当前的置顶公告，玩家进站将自动打开这一条。')) { btn.disabled = false; return; }
  // 修改已有公告：编号不变，只换标题与正文；发布新公告才需要 ID 与置顶。
  const res = editing
    ? await api('/announcements/update', { body: { id, title, markdown } })
    : await api('/announcements/publish', { body: { id: id || undefined, title, markdown, pin: $('ann-pin').checked } });
  btn.disabled = false;
  if (res.status !== 200) {
    msg.textContent = (editing ? '修改失败：' : '发布失败：') + ((res.body && res.body.error) || res.status);
    return;
  }
  msg.textContent = editing ? `已修改公告 ${id}（编号与发布时间不变）。` : '已发布：' + res.body.item.id;
  if (editing) resetAnnouncementForm();
  else {
    $('ann-id').value = res.body.item.id;
    $('ann-title').value = '';
    $('ann-body').value = '';
    $('ann-pin').checked = false;
  }
  await loadAnnouncements();
});

$('btn-ann-clear').addEventListener('click', resetAnnouncementForm);

// ---- operator account actions (owner only) -----------------------------------------------------------------
$('btn-op-create').addEventListener('click', async () => {
  const msg = $('op-msg');
  const id = $('op-id').value.trim();
  const name = $('op-name').value.trim();
  const password = $('op-password').value;
  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(id)) { msg.textContent = '账号 ID 只能用小写字母、数字、下划线和连字符（3–32 位，且以小写字母或数字开头）。'; return; }
  if ([...password].length < 8) { msg.textContent = '密码至少 8 位。'; return; }
  const res = await api('/operators/create', { body: { id, name, password } });
  if (res.status !== 200) {
    msg.textContent = '创建失败：' + (res.body && res.body.error === 'ID_TAKEN' ? '该 ID 已存在' : (res.body && res.body.error) || res.status);
    return;
  }
  msg.textContent = `已创建运维账号 ${id}，现在就能用它登录了。`;
  $('op-id').value = '';
  $('op-name').value = '';
  $('op-password').value = '';
  await loadOperators();
});

$('btn-op-clear').addEventListener('click', () => {
  $('op-id').value = '';
  $('op-name').value = '';
  $('op-password').value = '';
  $('op-msg').textContent = '';
});

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
  await loadSession();
  loadAccounts();
  loadAnnouncements();
  loadOnebot();
  startPolling();
})();
