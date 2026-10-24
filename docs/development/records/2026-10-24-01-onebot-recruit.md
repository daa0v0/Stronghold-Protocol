# 2026-10-24 OneBot 11 群招募

## 需求

房主（或房内玩家）在等待房里可以一键向服主指定的 QQ 群发送招募信息，把房间密钥推给群友；目标群与招募信息模板在运维后台配置。连接方式 OneBot 11 WebSocket，**正向（本服作客户端拨号 OneBot 实现）与反向（OneBot 实现连入本服）后台自选**——用户的 OneBot（NapCat）所在机器没有公网、游戏服有公网，必须支持反向。招募信息里带**可点击直接进房的链接**（`{link}` 占位符 + 链接基址配置）。

## 实现

### server/onebot.js（新）

- `createOneBotConfig`：持久化配置 `runtime/onebot.json`（0600，与账号文件同目录），字段 `enabled / mode / url / token / groups / template / cooldownSec / linkBase`；整个文件必须有效（部分手改的文件整体忽略，不做半套用）。**缺失的新字段（旧版文件没有 mode/linkBase）按默认值处理，只有存在但非法的值才拒绝整个文件**——否则更新一次旧配置就被清空一次。`update()` 全量校验后原子落盘。
- `createOneBotClient`：双模式连接层。正向（client）：WS 客户端，Token 走 `Authorization: Bearer` 头，断线 1s 倍增至 30s 重连；反向（server）：`/onebot/ws` 升级钩子（`upgradeHook`，经 server/http/websocket.js 的 `extraUpgrade` 旁路挂在本服端口上），Token 校验用 `timingSafeEqual`（头或 `?access_token=`），未配置 Token 时路径 404、保存时拒绝启用；同一时刻只接受一个 OneBot 连接，新连接替换旧连接；配置变化断开已连入客户端让其用新 Token 重新握手。请求帧 `{ action, params, echo }`，应答按 `retcode`（0 ok、1 async）结算，事件帧忽略（本功能只发不收）。发送用消息段数组 `[{type:'text',…}]`，避免 CQ 码被解释。`broadcast()` 从不抛出：逐群 `Promise.allSettled`，失败按群返回。
- `renderRecruitTemplate` / `recruitFacts`：模板占位符 `{room} {host} {players} {capacity} {difficulty} {mode} {link}`，未知占位符原样保留；`{link}` = `链接基址/?room=房间密钥`（去基址尾斜杠、编码房间码），基址未配置渲染为空。

### 协议与大厅

- `shared/protocol.js`：新 C2S 消息 `room.recruit`（无字段）。新错误码 `ONEBOT_UNAVAILABLE`（shared/constants.js ERR + ERR_TEXT，四个语言包补翻译）。
- `server/lobby.js`：`Room.recruit`（`{cooldownSec}` 或 null，进 room.state）与 `Room.recruitAt`（每房冷却）；`Lobby.recruit` 处理器——同盟等待房（含观战席）的在线真人可用，独立模拟 / 对局中 / 紧急保护拒绝；冷却在发送前落定（连点不会双发），全部发送失败时返还冷却。`refreshRecruitFlags()` 在后台保存后刷新所有房间的标志并重播 room.state。

### 运维后台

- `server/admin.js` + `server/http/admin.js`：`GET /api/admin/onebot`（配置 + 连接状态；Token 只回 `tokenSet`，永不回显；反向模式回监听状态与连入数）、`POST /api/admin/onebot/config`（token 缺省=保持、空串=清除；mode/linkBase 一并透传；保存即应用并刷新房间标志）、`POST /api/admin/onebot/reconnect`（正向=立即重拨；反向=断开已连入客户端）、`POST /api/admin/onebot/test`（固定测试文案）。
- `public/admin/`：「OneBot 群招募」面板（启用、连接方式选择、地址 / 反向提示（含按页面地址生成的 `ws(s)://host/onebot/ws` 建议地址）、Token、群号、模板、链接基址、冷却、保存/重连/测试/清除 Token、状态徽标与原始状态）。

### 房间界面

- `public/js/screens/room.js`：`room.state.recruit` 存在时，邀请框内显示「招募」按钮（含本地秒级冷却倒计时，服务端冷却为准）；发送成功 toast「招募信息已发送」。

### 反向代理

- `deploy/nginx-stronghold.conf`：新增 `/onebot/ws` 的 Upgrade location 模板（Nginx 后面挂反向 WS 时需要）。

## 验证

- `node --test test/onebot.test.js`：16/16 通过——配置存取/校验/损坏文件忽略/旧版文件兼容（缺新字段=默认值）/反向无 Token 拒启、模板与 `{link}` 渲染、真实 ws 假 OneBot 的正向拨号/Token 头/请求帧/逐群失败报告/重拨号、反向单测（Token 头与 `?access_token=` 握手、错 Token 401、未启用 404、消息双向、新连接替换旧连接、其他路径不被认领），以及三条端到端链路（正向：后台配置 → 建房 → room.recruit → 假 OneBot 收到含房间密钥的 send_group_msg；反向：后台切 mode=server → NapCat 连入本服端口 → 招募经反向通道送达且模板含 `https://基址/?room=码`；冷却 RATE；未配置 ONEBOT_UNAVAILABLE；独立模拟 WRONG_PHASE）。
- `node tools/i18n.mjs check --all --strict`：四个语言包 100%。
- `npm run lint`（0 errors）、`npm run typecheck`、`npm run check:imports`、`node tools/ci.mjs --only smoke`、`node --test test/admin.test.js test/docs-consistency.test.js test/docs-paths.test.js test/wire-codec.test.js` 全部通过；未触及 `server/sim/`，golden 不受影响。
- 全量 `npm test`（9353 项）在本机有 33 项失败。与本次改动相关的只有 `test/package.test.js` 与 `test/plugin-package.test.js` 的「imports ./onebot.js (not shipped)」——打包白名单基于 `git ls-files`，新文件提交后即通过；其余失败用 `git stash` 前后对照确认为本分支/本机既有问题（缺 Python、未下载 `public/assets/`、性能阈值与本机负载），失败集合与干净树完全一致。

## 已知边界

- OneBot 侧事件（私聊、群消息）不消费；招募通道是单向发送。
- 反向模式同一时刻只接受一个 OneBot 连接（新连接替换旧连接）；多个机器人需要多个游戏服实例。
- 后台保存后，已打开的房间靠 `refreshRecruitFlags()` 重播 room.state 获得新按钮；若房间正处于对局，等回到等待房后的下一次广播生效。
- 测试消息发送失败返回 502，`failed[]` 带每群的错误文本。
- `{link}` 在链接基址未配置时渲染为空（模板里会留下一个空位），后台面板有提示。
