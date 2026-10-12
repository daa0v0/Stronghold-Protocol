# 运维后台（/admin）

一个给**服主**用的只读监控 + 少量显式动作的网页控制台。默认**关闭**，配了密钥才出现。

## 1. 设计取舍（先看这三条，能省你很多疑问）

1. **没有默认口令。** 没配 `ADMIN_SECRET`（或 `ADMIN_SECRET_FILE`）时，`/admin` 与 `/api/admin/*` 一律返回 **404**，和任何不存在的路径一样。忘了配 = 没有后台，而不是"用弱口令的后台"。
   **打开 `/admin` 是 404 却不知道为什么？看启动日志**：后台关闭时服务器会打印一行 `[admin] 后台关闭：<具体原因>`（没设变量 / 密钥不足 16 字符 / 密钥文件读不到，三种各有各的文案）并指向本节；启用时打印 `[admin] 后台已启用（密钥来源：ADMIN_SECRET_FILE）`。404 刻意不暴露后台是否存在，所以日志是唯一的提示。
2. **设置是只读的。** `server/serverSettings.js` 开头写明「Private per-server settings … **no HTTP administration endpoint**」——这是本项目有意为之（AI 上限、预缓存准入、素材限速都走 CLI）。后台**显示**这些值，改还是用 `node tools/server-settings.mjs`。
3. **维护模式复用服务器自己的保护机制**，不是新开关：它调用的是带宽保护那条路径（`bandwidthEmergency.trip`），所以客户端显示的、行为上都和以前一致。

## 2. 启用

密钥按下面的顺序读取，**先命中的赢**（`server/admin.js readAdminSecret`）：

| 顺序 | 来源 | 谁写它 |
|---|---|---|
| 1 | 环境变量 `ADMIN_SECRET` | 你（Docker、临时运行） |
| 2 | 环境变量 `ADMIN_SECRET_FILE` 指向的文件 | 你 / systemd 凭据 / `scripts/install-service-linux.sh` |
| 3 | **`runtime/admin.secret`**（本机默认文件，已在 `.gitignore` 里） | `tools/admin-secret.mjs`（**本地启动脚本首次运行时会问你**）、`scripts/install-service-windows.ps1` |

### 第一次运行会问你

用 `scripts/start-windows.bat` / `start-windows.ps1` / `scripts/start.sh` 启动时，会先跑
`node tools/admin-secret.mjs ensure`（`scripts/launch.mjs` 的第 4 步之前）：

```
首次运行：请设置运维后台（/admin）的密钥。
  · 直接回车 = 自动生成 64 位随机密钥（推荐，稍后显示一次，请存到密码管理器）
  · 或输入你自己的密码（至少 6 个字符；12 个以上更适合公网）
密钥：
```

**长度要求**：最少 **6 个字符**（一个正常密码就行），少于 12 个时会**提醒**一次但不会拒绝：

> 密钥只有 6 个字符：本机/局域网够用，对公网开放建议 12 个以上（登录限流按来源地址计数，多地址并行尝试不受它限制）

为什么是 6 而不是更长：这个后台是你自己的控制台，门槛定得比你能记住的密码还长，结果只会是"生成了一串没人保存的随机串"。真正的防线是登录限流（每个来源地址 5 分钟 8 次，`server/admin.js`）+ 常量时间比较；6 个字符在这条防线后面足够，而**公网暴露**时它不够——那种情况下请用 12 位以上，或者干脆别把 `/admin` 开到公网（HTTPS + 反代白名单 / SSH 隧道，见 §8 建议）。

之后 `/admin` 就是登录页：**输入正确密钥进入控制台，输错显示「密钥无效。」**（连续错 8 次进限流）。
没有终端（服务、CI、管道）时它会直接生成一个并写进文件，而不是把后台留成关闭。
给 `scripts/launch.mjs` 加 `--no-admin` 可以跳过这一步（用于"就是要后台关闭"的场景）。

### 手动设置 / 查看 / 更换

```bash
node tools/admin-secret.mjs show              # 现在从哪来、是否生效（默认不打印密钥本身）
node tools/admin-secret.mjs show --reveal     # 连同密钥一起打印（忘了密钥时用）
node tools/admin-secret.mjs set               # 交互式设置（回车 = 自动生成）
node tools/admin-secret.mjs set --generate    # 直接生成一个新的
node tools/admin-secret.mjs rotate            # 换一个：已登录的会话立即失效
node tools/admin-secret.mjs off               # 删除默认文件，后台回到 404
```

改完**重启服务器**生效（`off` 同理）。`set --file=<路径>` 可以写到别处（那时服务器要用 `ADMIN_SECRET_FILE` 指向同一个文件）。

### 服务器上（推荐文件方式）

**方式一：环境变量**（`/etc/stronghold/stronghold.env`）

```ini
ADMIN_SECRET=把 openssl rand -hex 32 的输出贴这里     # 至少 6 个字符（少于 12 会在启动日志里提醒）；否则后台仍然关闭
```

**方式二：密钥文件**（推荐，进程环境里看不到，`ps eww` 也看不到）

```ini
ADMIN_SECRET_FILE=/etc/stronghold/admin.secret
```

```bash
sudo install -m 640 -o root -g stronghold /dev/null /etc/stronghold/admin.secret
openssl rand -hex 32 | sudo tee /etc/stronghold/admin.secret >/dev/null
sudo chmod 640 /etc/stronghold/admin.secret && sudo chown root:stronghold /etc/stronghold/admin.secret
sudo systemctl restart stronghold
```

`scripts/install-service-linux.sh` 会替你生成这个文件。改完重启服务，然后访问 `https://<你的域名>/admin`。

## 3. 认证

| 方式 | 用法 | 说明 |
|---|---|---|
| 登录表单 | 浏览器打开 `/admin`，输入密钥 | 成功后下发一个 **HttpOnly / SameSite=Strict / Path=/** 的 Cookie |
| Bearer | `curl -H "Authorization: Bearer $ADMIN_SECRET" …` | 给脚本用；不要把它写进 shell 历史 |

细节：

- 比较用 `crypto.timingSafeEqual`（定长、常量时间）。
- Cookie 里的值**不是密钥**，而是**每次进程启动新生成的 24 字节随机串**；重启服务即全部失效。
- 请求走 TLS 时（`req.socket.encrypted` 或 `X-Forwarded-Proto: https`）Cookie 额外带 `Secure`。
- 登录失败限流：**同一来源 5 分钟内 8 次**，超出返回 `429` + `Retry-After`（成功即清零）。
- 密钥长度 / 来源 / 失败尝试都会记到服务端日志。

## 4. 端点

全部返回 `application/json` 且 `Cache-Control: no-store`。除登录/登出外都需要认证。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/admin` | 控制台页面（无需登录也返回页面骨架，但拉不到任何数据） |
| POST | `/api/admin/login` | `{ secret }` → 200 + 下发 Cookie；401 密钥错；429 被限流 |
| POST | `/api/admin/logout` | 清除 Cookie |
| GET | `/api/admin/overview` | 版本/构建/Node、主机（CPU 核数、负载、内存）、进程（RSS/堆/运行时长）、网络（连接/会话/在线玩家/拥塞）、房间计数、维护状态、素材预缓存状态、**服务器设置（只读）**、日志环形缓冲大小 |
| GET | `/api/admin/rooms` | 每个房间一条：房间号、模式、难度、**容量**、真人/AI/观战数、是否进行中、**对局阶段与回合**、**固定卡池组（A–E，含成员与倍率）**、房主、存在时长、席位明细 |
| GET | `/api/admin/logs?since=&limit=` | 增量日志：`entries[{seq,at,level,text}]` + `nextSeq`（`since=0` 表示最近 limit 条，limit 上限 400） |
| POST | `/api/admin/broadcast` | `{ text, kind }` → 给**每个在线连接**推一条提示（`kind`: `info`/`success`/`warn`/`error`），同时进顶部滚动条。text 上限 300 字（超长截断，不报错），空白返回 400 |
| POST | `/api/admin/maintenance` | `{ on: true|false }` → 维护模式开关。**响应先发、开关后生效**（见下） |
| POST | `/api/admin/rooms/close` | `{ code }` → 关掉一个房间，里面的人收到 `room.closed{reason:"admin"}` 回到大厅；房间不存在返回 404 |
| GET | `/api/admin/packs` | 每个内容包一条：类型、ID、名称、版本、声明的 `app` 范围、是否 `compatible`、**是否已加载/被停用/待确认**、是否 `live`、内容量（替换项/补丁表/文案数）、扫描位置；另有当前策略 `policy` 与内容标识 `tag`、语言包数量 `languages` |
| POST | `/api/admin/packs` | 改内容包策略（见 §5）：`{ id, enabled }` 开关一个包、`{ id, confirmed: true }` 确认加载一个不兼容的包、或 `{ off: [], allow: [] }` 整体替换。返回更新后的同一份列表；涉及非实时类型时带 `restartRequired: true` |
| GET | `/api/admin/mods` | 每个**代码 mod** 一条：ID、名称、版本、入口、适用版本、是否启用、**本进程是否真的加载了**、失败原因；另有策略 `policy` 与被跳过清单 `skipped` |
| POST | `/api/admin/mods` | 改代码 mod 策略（见 §5）：`{ id, enabled }` 开关一个、或 `{ enabled: [...] }` 整体替换。**总是**返回 `restartRequired: true`（模块在启动时导入，运行中无法卸载） |

错误码：`400 BAD_BODY`、`401 UNAUTHORIZED`/`BAD_SECRET`、`404 NOT_FOUND`（未知端点、房间不存在，或 `packs` 里给了未知的包 ID）、`405 METHOD_NOT_ALLOWED`（已知端点用了错方法）、`409 LANGUAGE_LOCKED`（想停用语言包）、`413 BODY_TOO_LARGE`（> 8 KB）、`429 TOO_MANY_ATTEMPTS`、`500 WRITE_FAILED`（设置文件写不进去）、`503 UNAVAILABLE`（本部署没有带宽控制，无法维护模式 / 没有包注册表）。

## 5. 内容包与代码 mod 开关（本仓库对"设置只由 CLI 写"的唯一例外）

`serverSettings.js` 的原则是**服务器设置没有 HTTP 写入端点**：面板只展示，改动由 `node tools/server-settings.mjs …` 写。本仓库（2026-10-12，服主决定）为**内容包策略**开了唯一一个例外——mod 是运行中会反复开关的运维动作，从面板点比每次登服务器改文件现实。除此之外的一切设置仍然只由 CLI 写。

- 写入同一个文件、同一个校验器、同一个原子写入器（`serverSettings.js writeServerSettings`），所以 CLI 与面板永远一致。
- 策略内容：`off` = 本服务器不加载（不出现在索引、不下发文件、不计入内容标识）；`allow` = 版本范围不兼容但仍要加载。
- **语言包不能停用**（409 `LANGUAGE_LOCKED`）：它是客户端自身的一部分，且其他语言要回退到英文。
- **不兼容的包**：改变玩法的类型（`assets`/`data`）默认被扣住，点「确认加载」后才加载；不兼容的**语言包**照旧加载并标记（只影响文案，缺的会回退）。
- **生效时机**：`assets` 立即生效（索引、内容标识、文件下发同步变化）；`data` 需要**重启**（它的表在进程启动时就固定了），面板会显示「重启后生效」——这样索引、内容标识和 `/data/<name>.json` 永远不会互相矛盾。
- 每次改动都写日志（`[admin] 内容包策略：…`），并可从 `docs/PACKS.md` §4「The owner's switches」查到完整语义。

**代码 mod（`mods/`）** 与内容包同一份文件、同一个校验器、同一个面板原则：

- 目录是 `mods/<id>/`（`mod.json` + 入口模块），**从不下发、从不进内容包索引**；放进去**不会执行**，必须在这里或 `mods.enabled` 里明确启用。
- 面板列出 ID/名称/版本/入口/适用版本，以及**本进程是否真的跑起来了**与失败原因；`/healthz` 的 `mods.code` 与内容包 `tag` **分开报告**（代码 mod 只在服务端运行，客户端无法校验，只能被告知）。
- 改动**总是**需要重启（`restartRequired`）：模块在启动时导入一次，运行中无法卸载。面板据此显示，而不是假装已生效。
- 安全性：`mods/` 里的代码以**服务器自身权限**运行。只启用你读过或信任的 mod——面板上写明了这一点，`mods/README.md` 与 `docs/PACKS.md` §4 也写了。


## 6. 维护模式到底做了什么

开启后：

- **拒绝新访问**：建房、加入、观战、开局、快速匹配、大厅目录订阅都被拒（已有的人不踢）。
- **冻结进行中的对局**：客户端会显示保护状态，倒计时停住，断线保留窗口顺延。
- **切断普通 HTTP 连接**并暂停素材预缓存下载。
- **后台本身不受影响**：`/admin` 与 `/api/admin/*` 在保护闸门**之前**被应答，所以你在维护中依然能看、能广播、能关闭维护（这一点是刻意做的——否则开维护的那一刻自己就被踢出控制台了）。
- **不自动恢复**：手动开的维护模式**不会**在 2 分钟后自己解除（自动触发的带宽保护才是自动恢复的）。想解除只能点「关闭」或调 `POST /api/admin/maintenance {on:false}`。
- `/healthz` 在维护期间**仍然返回 200**：给编排器/监控探活用。

`POST /api/admin/maintenance` 的响应总是先发出，再真正切换保护状态——因为开启保护会断开普通 HTTP 连接，如果先切，触发这个动作的请求自己就会被切断，控制台会报"网络错误"而其实已经成功。

## 7. 安全建议

1. **一定要 TLS**。没有 HTTPS 时密钥和 Cookie 是明文，公网上等于公开。
2. 反向代理里再限制一层来源 IP：`deploy/nginx-stronghold.conf` 里 `/admin` 与 `/api/admin/` 两段有 `allow`/`deny` 模板（默认是示例 IP，**记得改**）。
3. 密钥用文件而不是环境变量（`ADMIN_SECRET_FILE`），文件 `640 root:stronghold`。
4. 不要把密钥贴进 Issue、截图或 shell 历史；轮换就是改文件内容 + `systemctl restart stronghold`。
5. 关掉后台 = 把 `ADMIN_SECRET`/`ADMIN_SECRET_FILE` 都清掉并重启（回到 404）。

## 8. 快速验证（curl）

```bash
BASE=https://game.example.com
SECRET=$(sudo cat /etc/stronghold/admin.secret)

# 没登录：401
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/admin/overview

# 带 Bearer：200，看一遍概览
curl -s -H "Authorization: Bearer $SECRET" $BASE/api/admin/overview | head -c 400

# 房间（20 人房里能看到 poolGroups 是 5 组 4 人）
curl -s -H "Authorization: Bearer $SECRET" $BASE/api/admin/rooms

# 全服广播
curl -s -H "Authorization: Bearer $SECRET" -H 'content-type: application/json' \
  -d '{"text":"22:30 维护重启，请提前结束本局","kind":"warn"}' $BASE/api/admin/broadcast

# 维护模式开/关
curl -s -H "Authorization: Bearer $SECRET" -H 'content-type: application/json' -d '{"on":true}'  $BASE/api/admin/maintenance
curl -s -H "Authorization: Bearer $SECRET" -H 'content-type: application/json' -d '{"on":false}' $BASE/api/admin/maintenance
```

## 9. 已知未做（有意保持小）

- **不能改服务器设置（一个例外）**：设置默认只读展示、写入在 CLI（见 §1 第 2 条）；唯一的例外是**内容包策略**（§5），它是运行中会反复开关的运维动作，所以 /admin 可以直接写。
- **不能踢单个玩家**：只能关整个房间（`rooms/close`）。房主自己可以在游戏里踢人。
- **不改房间容量/difficulty**：这些是房主的权力，后台不越权。
- **没有审计日志文件**：动作会写进服务端日志（`journalctl -u stronghold`），但不会单独落盘。
- 需要这些的话，扩展点在 `server/admin.js`（服务）+ `server/http/admin.js`（路由）+ `public/admin/admin.js`（面板），三层都很小。

## 10. 相关
- 部署：[DEPLOY-LINUX.md](DEPLOY-LINUX.md)、[DEPLOY-QUICKSTART.md](DEPLOY-QUICKSTART.md)
- 素材预缓存（后台能看到状态）：[ASSET_CACHE.md](ASSET_CACHE.md)
- 服务器设置（后台只读的那些值）：`tools/server-settings.mjs --help`
- 带宽保护的阈值与行为：`server/bandwidthEmergency.js` 头部注释
