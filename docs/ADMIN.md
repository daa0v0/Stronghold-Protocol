# 运维后台（/admin）

一个给**服主**用的只读监控 + 少量显式动作的网页控制台。默认**关闭**，配了密钥才出现。

## 1. 设计取舍（先看这三条，能省你很多疑问）

1. **没有默认口令。** 没配 `ADMIN_SECRET`（或 `ADMIN_SECRET_FILE`）时，`/admin` 与 `/api/admin/*` 一律返回 **404**，和任何不存在的路径一样。忘了配 = 没有后台，而不是"用弱口令的后台"。
2. **设置是只读的。** `server/serverSettings.js` 开头写明「Private per-server settings … **no HTTP administration endpoint**」——这是本项目有意为之（AI 上限、预缓存准入、素材限速都走 CLI）。后台**显示**这些值，改还是用 `node tools/server-settings.mjs`。
3. **维护模式复用服务器自己的保护机制**，不是新开关：它调用的是带宽保护那条路径（`bandwidthEmergency.trip`），所以客户端显示的、行为上都和以前一致。

## 1.1 多管理员账号

`ADMIN_SECRET` 是**主密钥**：它开启后台，也用来"以主密钥身份"登录。多位管理员不需要共用这一个字符串——后台自带**运维账号**（`server/adminAccounts.js`）：

- 账号文件在 `runtime/admin-accounts.json`（与玩家账号同目录，持久、可写；**不放** `.cache/`，也不进 `public/`）。密码是 scrypt 哈希，控制台永远看不到哈希、salt 或令牌。
- 每个账号有一个**账号 ID**（小写字母、数字、下划线、连字符，3–32 位）。它同时是登录名，也是**公告里显示的发布者 ID**。
- **只有主密钥能管理账号**（创建 / 重置密码 / 停用 / 删除）。创建账号等于交出后台权限，这件事只由配了 `ADMIN_SECRET` 的人做。
- 重置密码、停用、删除都会**立即结束该账号的所有会话**（已在线的控制台会掉回登录页）。
- 登录失败与主密钥共用同一套限流（同来源 5 分钟 8 次）。

## 2. 启用

**方式一：环境变量**（`/etc/stronghold/stronghold.env`）

```ini
ADMIN_SECRET=把 openssl rand -hex 32 的输出贴这里     # 至少 16 个字符，否则后台仍然关闭
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

**给同事开账号**：用主密钥登录后台 → 「运维账号」区块 → 填账号 ID、显示名称（可留空）、密码 → 创建。之后对方在登录页填**账号 ID + 密码**即可，不再需要主密钥。

## 3. 认证

| 方式 | 用法 | 说明 |
|---|---|---|
| 主密钥登录 | 浏览器打开 `/admin`，账号 ID 留空、填 `ADMIN_SECRET` | 身份为 `owner`，可以管理运维账号 |
| 运维账号登录 | 填账号 ID + 密码 | 身份为该账号；公告会记录发布者 |
| Bearer | `curl -H "Authorization: Bearer $ADMIN_SECRET" …` | 给脚本用；不要把它写进 shell 历史 |

细节：

- 比较用 `crypto.timingSafeEqual`（定长、常量时间），未知账号也会走一次等价的 scrypt 计算，避免账号枚举计时。
- Cookie 里的值**不是密钥**，而是**每次登录新生成的 24 字节随机串**（会话表保存在进程内存里）；重启服务即全部失效。
- 请求走 TLS 时（`req.socket.encrypted` 或 `X-Forwarded-Proto: https`）Cookie 额外带 `Secure`。
- 登录失败限流：**同一来源 5 分钟内 8 次**，超出返回 `429` + `Retry-After`（成功即清零）。
- 密钥长度 / 来源 / 失败尝试都会记到服务端日志。

## 4. 端点

全部返回 `application/json` 且 `Cache-Control: no-store`。除登录/登出外都需要认证。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/admin` | 控制台页面（无需登录也返回页面骨架，但拉不到任何数据） |
| POST | `/api/admin/login` | `{ secret }`（主密钥）或 `{ id, password }`（运维账号）→ 200 + 下发 Cookie + 当前身份；401 凭据错；429 被限流 |
| POST | `/api/admin/logout` | 清除 Cookie |
| GET | `/api/admin/session` | 当前登录身份：`{ kind: 'owner'\|'account', id, name }` |
| GET | `/api/admin/overview` | 版本/构建/Node、主机（CPU 核数、负载、内存）、进程（RSS/堆/运行时长）、网络（连接/会话/在线玩家/拥塞）、房间计数、维护状态、素材预缓存状态、**服务器设置（只读）**、日志环形缓冲大小 |
| GET | `/api/admin/rooms` | 每个房间一条：房间号、模式、难度、**容量**、真人/AI/观战数、是否进行中、**对局阶段与回合**、**固定卡池组（A–E，含成员与倍率）**、房主、存在时长、席位明细 |
| GET | `/api/admin/logs?since=&limit=` | 增量日志：`entries[{seq,at,level,text}]` + `nextSeq`（`since=0` 表示最近 limit 条，limit 上限 400） |
| POST | `/api/admin/broadcast` | `{ text, kind }` → 给**每个在线连接**推一条提示（`kind`: `info`/`success`/`warn`/`error`），同时进顶部滚动条。text 上限 300 字（超长截断，不报错），空白返回 400 |
| POST | `/api/admin/maintenance` | `{ on: true|false }` → 维护模式开关。**响应先发、开关后生效**（见下） |
| POST | `/api/admin/rooms/close` | `{ code }` → 关掉一个房间，里面的人收到 `room.closed{reason:"admin"}` 回到大厅；房间不存在返回 404 |
| GET | `/api/admin/accounts?q=` | 账号列表（`q` 按用户名片段过滤，大小写不敏感）：用户名、注册时间、皮肤数、登录设备数、是否封禁。**绝不返回密码哈希、salt 或 token** |
| POST | `/api/admin/accounts/password` | `{ username, password }` → 重置密码。密码至少 8 位；**该账号的所有登录设备被登出**（token 清空） |
| POST | `/api/admin/accounts/ban` | `{ username, banned, reason? }` → 封禁/解封。封禁后该账号无法登录，已登录的设备被登出，**账号数据保留**，可随时解封 |
| POST | `/api/admin/accounts/delete` | `{ username }` → 永久删除账号（密码、皮肤、token 全清），**用户名被释放**，可重新注册 |
| GET | `/api/admin/announcements` | 公告目录：`revision`、`pinnedId`、`items[{id,title,publishedAt,revision,author,bytes,pinned}]`（仅元数据，不含正文） |
| GET | `/api/admin/announcements?id=` | 单条公告的**已校验正文**（`markdown`）+ 元数据；ID 未知/正文不可读返回 404 |
| POST | `/api/admin/announcements/publish` | `{ id?, title, markdown, pin? }` → 发布新公告。`id` 省略则自动生成（`ann-<时间36进制>-<uuid前缀>`）；**同 ID 不可重发**（改用 `update`）。正文上限 128 KiB。**发布者记录为当前登录身份**（`author`） |
| POST | `/api/admin/announcements/update` | `{ id, title, markdown }` → **修改已发布公告**的标题与正文。编号、发布时间、历史位置都不变；revision 会变，玩家端会取到新正文。改的是最新一条时，目录 revision 也变，"下次不再显示"的玩家会重新看到。原发布者不会被改掉 |
| POST | `/api/admin/announcements/pin` | `{ id }` → 设为唯一置顶公告（自动取消原置顶）；ID 不存在返回 400 |
| POST | `/api/admin/announcements/unpin` | `{}` → 取消置顶，目录不变 |
| POST | `/api/admin/announcements/notify` | `{ id }` → 向**当前在线玩家**弹该公告（含正在对局中的）。只能指定已发布的公告；成功仅代表**已写入命令槽**，约 1 秒内由运行中的服务器投递 |
| GET | `/api/admin/operators` | 运维账号列表（**仅主密钥**）：`id`、`name`、`createdAt`、`lastLoginAt`、`disabled`。绝不返回哈希或令牌 |
| POST | `/api/admin/operators/create` | `{ id, password, name? }` → 创建运维账号（**仅主密钥**）。ID 3–32 位小写字母数字 `_-`；密码至少 8 位 |
| POST | `/api/admin/operators/password` | `{ id, password }` → 重置密码，该账号的所有会话立即失效 |
| POST | `/api/admin/operators/disabled` | `{ id, disabled }` → 停用/恢复；停用时会话立即失效，该账号无法登录 |
| POST | `/api/admin/operators/delete` | `{ id }` → 删除账号并结束其会话；ID 被释放 |
| GET | `/api/admin/onebot` | OneBot 群招募的配置（**Token 只回 `tokenSet`，绝不回显**）+ 实时连接状态（模式、正向地址 / 反向监听与连入数） |
| POST | `/api/admin/onebot/config` | `{ enabled?, mode?, url?, token?, groups?, template?, linkBase?, cooldownSec? }` → 校验、落盘并立即应用到运行中的服务器。`token` 缺省 = 保持不变，空串 = 清除；`mode`: `client`（正向）/ `server`（反向）。非法值返回 400 + 中文原因。保存后所有房间的 `room.state.recruit` 标志随之刷新 |
| POST | `/api/admin/onebot/reconnect` | `{}` → 清掉重连退避，按当前配置立刻拨号 |
| POST | `/api/admin/onebot/test` | `{}` → 向每个目标群发一条固定测试文案；任何一群失败都返回 502，`failed[]` 带每群的错误 |

错误码：`400 BAD_BODY`、`401 UNAUTHORIZED`/`BAD_SECRET`/`BAD_CREDENTIALS`、`403 OWNER_ONLY`、`404 NOT_FOUND`（未知端点或房间不存在）、`405 METHOD_NOT_ALLOWED`（已知端点用了错方法）、`413 BODY_TOO_LARGE`（> 8 KB；公告发布/修改端点放宽到 96 KB）、`429 TOO_MANY_ATTEMPTS`、`502`（OneBot 测试消息发送失败）、`503 UNAVAILABLE`（本部署没有带宽控制，无法维护模式；或本部署没有启用账号/公告/运维账号/OneBot 功能）。

## 4.1 账号管理（玩家账号）

控制台的「账号」区块列出所有账号，支持按用户名搜索，提供三个操作：

| 操作 | 行为 | 注意 |
|---|---|---|
| **重置密码** | 设置新密码 | 该账号的所有设备必须重新登录（旧 token 全部失效） |
| **封禁 / 解封** | 封禁后无法登录 | 数据保留，随时可解封；封禁会登出该账号的所有设备 |
| **删除** | 永久删除 | 不可恢复，用户名被释放 |

删除需要再输一次用户名确认。账号名规则与玩家端一致（3–24 个字符，含至少一个字母或数字，见 `shared/account.js`）。

账号功能是**可选**的：服务器没有启用账号（`createAccountStore` 未装配）时，这些端点返回 `503 UNAVAILABLE`，控制台的账号区块显示「这台服务器没有启用账号功能」。

## 4.2 运维账号管理（仅主密钥）

控制台的「运维账号」区块**只有用主密钥登录才出现**。它列出全部运维账号（ID、名称、创建时间、最近登录、状态），并提供：

| 操作 | 行为 | 注意 |
|---|---|---|
| **创建** | 填 ID、显示名称（可留空）、密码 | ID 就是公告里显示的发布者 ID；密码至少 8 位 |
| **重置密码** | 设置新密码 | 该账号在所有设备上重新登录（旧会话立即失效） |
| **停用 / 恢复** | 停用后无法登录 | 停用会立即踢掉该账号的会话；数据保留，可恢复 |
| **删除** | 永久删除 | 不可恢复，ID 被释放 |

删除需要再输一次账号 ID 确认。账号数上限 50。

## 4.3 公告的作者是谁

每条公告在玩家端的展示是：

```text
标题
（小字）发布者账号 ID
正文
```

- `author` 是**发布者**的账号 ID；`null` 表示这条公告不是通过后台账号发布的（例如 CLI 发布），此时不显示作者行。
- 用 `update` 修改公告**不会**改掉原发布者——改内容不等于换作者。
- 控制台的公告表格有「发布者」列；服务端日志同样记录谁发布、谁修改。
- 历史列表里每条也带同一个小字 ID。

## 4.4 OneBot 群招募

房间里的「招募」按钮（同盟等待房，房内任意在线真人，含观战席）把一条招募信息推送到你指定的 QQ 群，信息里可以带一条**点击直接进房的链接**。通道是 OneBot 11 WebSocket，**两种连接方式二选一**（后台面板里切换，保存即生效）：

- **正向（client，默认）**：本游戏服务器作为 WS **客户端**，去连接 OneBot 实现（NapCat / Lagrange.OneBot / go-cqhttp 等）开放的正向 WS 地址。适合 OneBot 和游戏服在同一台机器或同一内网。
- **反向（server）**：本游戏服务器在自己端口上开放 `ws(s)://本服地址:端口/onebot/ws`，OneBot 实现作为**客户端**连入（在 OneBot 侧配「反向 WebSocket 连接」，地址用后台面板显示的那条）。适合 OneBot 所在的机器**没有公网**、连不出去也进不来，但能主动拨出——它拨你，而不是你拨它。反向通道暴露在本服端口上，因此**必须设置 Token**（`Authorization: Bearer` 头或 `?access_token=` 都认），没有 Token 或 Token 不对一律拒绝；未配置 Token 时启用会被直接拒绝。同一时刻只接受一个 OneBot 连接，新连接会替换旧连接。

配置保存在 `runtime/onebot.json`（0600，与账号文件同目录），后台修改保存即生效，不需要重启：

| 字段 | 说明 |
|---|---|
| 启用 | 关掉即断开连接（反向还会断开连入的 OneBot），房间不显示「招募」按钮 |
| 连接方式 | `client` 正向 / `server` 反向，见上 |
| OneBot 地址 | 仅正向：`ws://` 或 `wss://` 开头，例如 `ws://127.0.0.1:3001` |
| Access Token | 正向：OneBot 实现的 access_token；反向：连入握手必须携带的口令。走 `Authorization: Bearer` 头。**后台只显示是否已设置，永不回显**，留空保存 = 不变 |
| 目标群号 | 每行一个，最多 10 个 5–20 位数字 |
| 模板 | 最多 600 字；占位符 `{room}` 房间密钥、`{host}` 房主、`{players}` 当前真人数、`{capacity}` 房间人数、`{difficulty}` 难度、`{mode}` 模式、`{link}` 直接加入链接；未知的占位符原样保留 |
| 招募链接基址 | `{link}` 用它生成 `基址/?room=房间密钥`，QQ 里点击即打开游戏页面并直接进房。填玩家能访问的地址（有 HTTPS 就填 `https://…`）；留空则 `{link}` 渲染为空 |
| 冷却 | 同一房间两次招募的最小间隔（0–3600 秒，默认 60） |

边界：

- **独立模拟、进行中的对局与紧急保护期间不能招募**；冷却期内服务端直接回 `RATE`，不会重复发送。
- 群号必须是 QQ 群里真实成员可收消息的目标——本服只负责把消息发给 OneBot 实现；OneBot 账号不在群里、被风控等失败会按群返回在测试与日志里。
- 发送用文本消息段而非 CQ 码字符串，玩家昵称里出现 `[CQ:...]` 也只会是普通文字。
- 未配置（或未启用）时 `room.state` 不带 `recruit`，玩家端不显示按钮；手动调 `room.recruit` 会得到 `ONEBOT_UNAVAILABLE`。
- 保存配置后已打开的房间会收到一次新的 `room.state`，按钮随之出现/消失；正在对局的房间等回到等待房后生效。
- HTTP 上报不支持——只有这两种 WebSocket 方式。

**反向模式与反向代理**：Nginx 后面挂反向 WS 时，给 `/onebot/ws` 加一段和 `/ws` 相同的 Upgrade 配置（`deploy/nginx-stronghold.conf` 有现成模板）；OneBot 直连本服端口则无需任何代理配置。

## 5. 维护模式到底做了什么

开启后：

- **拒绝新访问**：建房、加入、观战、开局、快速匹配、大厅目录订阅都被拒（已有的人不踢）。
- **冻结进行中的对局**：客户端会显示保护状态，倒计时停住，断线保留窗口顺延。
- **切断普通 HTTP 连接**并暂停素材预缓存下载。
- **后台本身不受影响**：`/admin` 与 `/api/admin/*` 在保护闸门**之前**被应答，所以你在维护中依然能看、能广播、能关闭维护（这一点是刻意做的——否则开维护的那一刻自己就被踢出控制台了）。
- **不自动恢复**：手动开的维护模式**不会**在 2 分钟后自己解除（自动触发的带宽保护才是自动恢复的）。想解除只能点「关闭」或调 `POST /api/admin/maintenance {on:false}`。
- `/healthz` 在维护期间**仍然返回 200**：给编排器/监控探活用。

`POST /api/admin/maintenance` 的响应总是先发出，再真正切换保护状态——因为开启保护会断开普通 HTTP 连接，如果先切，触发这个动作的请求自己就会被切断，控制台会报"网络错误"而其实已经成功。

## 6. 安全建议

1. **一定要 TLS**。没有 HTTPS 时密钥和 Cookie 是明文，公网上等于公开。
2. 反向代理里再限制一层来源 IP：`deploy/nginx-stronghold.conf` 里 `/admin` 与 `/api/admin/` 两段有 `allow`/`deny` 模板（默认是示例 IP，**记得改**）。
3. 密钥用文件而不是环境变量（`ADMIN_SECRET_FILE`），文件 `640 root:stronghold`。
4. 运维账号密码不要贴进 Issue、截图或聊天记录；密码只以 scrypt 哈希形式落在 `runtime/admin-accounts.json`。
5. 备份服务器时把 `runtime/admin-accounts.json` 一起备走（丢了就用主密钥重建账号）。
6. 不要把密钥贴进 Issue、截图或 shell 历史；轮换就是改文件内容 + `systemctl restart stronghold`。
7. 关掉后台 = 把 `ADMIN_SECRET`/`ADMIN_SECRET_FILE` 都清掉并重启（回到 404）。

## 7. 快速验证（curl）

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

# 建一个运维账号，然后用它登录、发一条公告
curl -s -H "Authorization: Bearer $SECRET" -H 'content-type: application/json' \
  -d '{"id":"alice","password":"a-long-enough-password","name":"小爱"}' \
  $BASE/api/admin/operators/create
curl -s -c /tmp/sp.jar -H 'content-type: application/json' \
  -d '{"id":"alice","password":"a-long-enough-password"}' $BASE/api/admin/login
curl -s -b /tmp/sp.jar -H 'content-type: application/json' \
  -d '{"title":"开服公告","markdown":"# 欢迎博士\n\n今晚 20:30 更新。"}' \
  $BASE/api/admin/announcements/publish

# 玩家端看到的（items[0].author 是 alice）
curl -s $BASE/api/announcements | head -c 300
```

## 8. 已知未做（有意保持小）

- **不能改服务器设置**：只读展示，写入在 CLI（见 §1 第 2 条）。
- **不能踢单个玩家**：只能关整个房间（`rooms/close`）。房主自己可以在游戏里踢人。
- **不改房间容量/difficulty**：这些是房主的权力，后台不越权。
- **不能看账号的密码或 token**：只有重置，没有查看；控制台也从不返回哈希、salt 或 token。
- **没有审计日志文件**：动作会写进服务端日志（`journalctl -u stronghold`），但不会单独落盘。
- **运维账号没有找回流程**：忘了密码只能由主密钥重置；账号文件丢失就重建账号。
- 需要这些的话，扩展点在 `server/admin.js`（服务）+ `server/http/admin.js`（路由）+ `public/admin/admin.js`（面板），三层都很小。

## 9. 相关

- 部署：[DEPLOY-LINUX.md](DEPLOY-LINUX.md)、[DEPLOY-QUICKSTART.md](DEPLOY-QUICKSTART.md)
- 素材预缓存（后台能看到状态）：[ASSET_CACHE.md](ASSET_CACHE.md)
- 服务器设置（后台只读的那些值）：`tools/server-settings.mjs --help`
- 带宽保护的阈值与行为：`server/bandwidthEmergency.js` 头部注释
- 公告的完整规则（含 CLI 与图片）：[ANNOUNCEMENTS.md](ANNOUNCEMENTS.md)
