# 干员皮肤（SKINS）

本文件说明「干员皮肤」功能的规则、数据与实现，以及**从融合版（`stronghold-v0.2.1-fusion-server-release`）移植到本目录（上游 0.2.4）时改了哪些文件**。移植清单放在最后，做后续合并（例如把 LongQianChen 分支的 20 人容量并进来）时请以它为基准。

## 1. 这是什么

玩家在「干员调配」里给每个干员挑一款已安装的皮肤。皮肤是**纯外观**：不改数值、不改技能。它有两处表现：

- **头像 / 立绘**：卡牌、详情面板、列表里的 180×180 头像换成皮肤的。
- **战场模型**：带模型的皮肤在棋盘上、作战中使用自己的 Spine 模型；只带头像的皮肤战场仍用原皮。

和「干员调配」的技能 / 模组不同，皮肤是**公开的**：服务端把它放进 `m.public.players[].skins`，所以队友看得见你的皮肤。这也是为什么它不像调配那样锁在 INFO_CHECK——局内随时可换，换完立刻广播。

## 2. 数据

**内容住在数据包里，功能住在代码里**（docs/PACKS.md §4）：皮肤的内容是 `packs/stronghold-skins/`，一个 `data` 包，它按合并补丁叠加在基表上；`ui/skins.js`、`ui/skinPicker.js`、战斗/渲染管线与 `room.skins` 是功能，仍留在代码里。美术照旧在 `public/assets/`（不入 git），**包里只有路径**。

两份数据分工明确，这个分工是「按需安装」的关键：

| 位置 | 内容 | 说明 |
|---|---|---|
| `packs/stronghold-skins/patch.json` → `skins` | **目录**：`{ version, counts, chars: { <charId>: [{ id, name, group }] } }` | 本项目知道的**全部**皮肤。不含 URL——没安装的皮肤没有文件可指。当前 172 名干员 / **271 款**。 |
| `packs/stronghold-skins/patch.json` → `assets.chars[charId].skins[skinId]` | **已安装**：`{ name, group, avatar, spine? }` | 本服务器**真的有素材**的皮肤。有 `spine` 的才换战场模型；没有的只换头像。当前 271 款全部已安装，其中 **172 款带 Spine 模型，99 款只有头像**。 |
| `data/skins.json`、`data/assets.json` | **基表**：空目录（`counts` 全 0）与不含 `skins` 块的清单 | `npm run build-data` 产出的就是干净版本；包关掉时服务器下发的就是它——**没有包就没有皮肤**，这是刻意的。 |

服务器装载这个包（放进 `packs/` 即自动加载，无需配置），所以玩家看到的与迁包之前完全一样：`/data/skins.json` 与 `/data/assets.json` 都由服务器下发**打过补丁**的表（`server/http/static.js` 的 `dataTables`），客户端照旧用 `data.get('skins')` / `data.get('assets')` 读——客户端一行都不用改。服主在 `/admin → 内容包` 可以停用它，或用 `packs.off` 关掉。

内容仍然**只由工具生成**（AGENTS.md 的生成数据规则）：`node tools/skins-pack.mjs --migrate` 负责把基表里的内容搬进包，`--from=<源 assets.json>` 负责把新素材的清单合并进包（并补目录行），`--check` 在基表又变脏时报错。

皮肤 id 形如 `char_1014_nearl2@epoque#17`；**文件名**把它规范化成 `char_1014_nearl2_epoque_17`（`@`/`#` → `_`）。注意皮肤 id 含 `@` 和 `#`，所以不能用 `isId` 校验（`shared/protocol.js isSkinId`）。

关键点：**选择按 base chess id 存（`chess_char_1_01_a`），素材按干员 id 查（`char_498_inside`）**。两份数据都按干员分组，而服务端按棋子索引，所以两边各查一次。

## 3. 素材布局

```
public/assets/char/skin_avatar/<charId>_<series>_<n>.png              271 个，180×180 头像（16 MB）
public/assets/spine/op/<charId>/<charId>_<series>_<n>/front/*.skel|.atlas|.png    172 款皮肤的战场模型
                                                    /back/*.skel|.atlas|.png     （165 MB）
```

皮肤模型和原皮模型放在同一个 `spine/op/<charId>/` 目录下，各自一个子目录，`.skel` / `.atlas` / `.png` 三者同名——pixi-spine 靠 skeleton 的名字找 atlas，所以这个命名必须保持。

## 4. 协议

```
room.skins { skins }      C2S：skins = { [baseChessId]: skinId }
```

- 结构校验 `shared/protocol.js`：`SKIN_LIMITS`（≤ 160 条，id ≤ 64 字符）、`isSkinId`、`isSkinSelection`。消息 type 在 `C2S` 表里注册。
- 算「重消息」（`server/net.js HEAVY_TYPES`），和 `room.loadout` 共用限流桶。
- **任何房间阶段都接受**，包括对局中。

## 5. 服务端路径

| 位置 | 作用 |
|---|---|
| `server/lobby.js` `freezeSkins()` | 只保留 key 能用的条目：base chess（非精锐、可见）、`char_*`（自选干员）、`chess_char_*_diy*`（自选槽位）。skinId 本身不查数据——查不到只是不换模型，留着以后补素材还能生效。 |
| `server/lobby.js` `skins()` | 存到 session + seat；房间有对局时立刻转交 `match.setSkins()`。观战者的选择只留在 session（和它的调配一样）。 |
| `server/net.js` `Session.skins` | session 字段。 |
| `server/match/match/platform.js` `setSkins()` | 对局侧入口：**不锁阶段**（对比 `setLoadout` 只允许 INFO_CHECK），改完同时 `markPublic()` + `markPrivate(ps)`。 |
| `server/match/player/basics.js` `setSkins()` / `skinOf()` | PlayerState 上重新校验并冻结；`skinOf(chessRecord, pieceId, diyCharId)` 是唯一的查询入口，查找顺序 = base chess id → piece id → 自选干员的 charId，**和服务端 / 客户端必须保持一致**。 |
| `server/match/PlayerState.js` | `this.skins` 初始化，构造时从 `seat.skins` 载入。 |
| `server/match/match/views.js` | `publicView().players[].skins`（队友可见）；`_prepBoardUnits` / `benchUnit` 两处 UnitInfo 加 `skin`（侦察队友棋盘时看得到）。 |
| `server/match/player/views.js` | `m.private.skins`（自己的备战区）。 |
| `server/match/player/round.js` `battleInput()` | 作战输入 `u.skin`。 |
| `server/sim/units.js` / `battle/players.js` / `snapshot.js` | `Unit.skin` 透传到战斗 UnitInfo。 |

## 6. 客户端路径

| 位置 | 作用 |
|---|---|
| `public/js/ui/skins.js` | `skinsStore`（localStorage `skins`）、`setSkin` / `clearSkin` / `skinFor`、`availableSkins`（标记 `installed` 与 **`battle`**）、`hasBattleModel`（该皮肤有没有自己的战场模型）、`installSkinsSync`（`room.skins` 同步，welcome 后重发 + 编辑防抖 500 ms，RATE/TIMEOUT/OFFLINE 1.5 s 重试）。 |
| `public/js/ui/skinPicker.js` | 「干员调配」详情面板里的**皮肤**区块：头像网格，默认 + 各款皮肤，「已装配」角标；没素材的置灰不可选。区块顶部写 **「{n} 款可选 · {k} 款含战斗模型」**（不是"已安装"——那会让人以为选了就会换战场模型），**没有战场模型的皮肤打「仅头像」角标**，`title` 说明「无战斗模型，战场沿用原干员模型」（玩家反馈"皮肤进战斗就没了"）。 |
| `public/js/screens/loadout.js` | 在 `CultivationSection` 之后挂 `<SkinSection chess=… />`。 |
| `public/js/main.js` | `installSkinsSync({ net })`。 |
| `public/js/data.js` | `DATA_FILES.skins = 'skins.json'`。 |
| `public/js/ui/gameComponents.js` | `GAME_FILES` 加 `'skins'`。 |
| `public/js/assets.js` | `skinRecord()`；`avatarUrl` / `unitPictureUrl` 支持 `opts.skin`；`spineEntry` 支持 `opts.skin`（换模型并把原皮挂成 `fallback`）；`hasBackSpine(m, id, skinId)`；`defaultSpine()` 抽出来复用。 |
| `public/js/render/units.js` | `_loadPicture` / `_loadSpine` / `_wantsBack` / `_fallDur` 都带上 `this.info.skin`；兜底菱形按皮肤换 key。 |
| `public/js/render/app.js` | `switchPrep`：`skinMap` ← `m.private.skins`；`pieceInfo()` 给己方棋子加 `skin`（`ownSkin()`，查找顺序和服务端一致）。 |
| `public/js/render/app/info.js` | `renderInfo(UnitInfo)` 透传 `skin`。 |
| `public/css/screens/loadout.css` | 文件末尾的「皮肤选择」区块（自适应网格）。 |

## 7. 移植记录

本目录 = **LongQianChen 的 `feat/IncreasePlayerCapacity` 分支（提交 `c106fb7c`，已合并上游 v0.2.4）** + 融合版皮肤功能。也就是说 20 人容量、公告、大厅目录、素材预缓存、紧凑 wire 协议、带宽熔断、聊天全部来自 fork，皮肤是本目录新加的。做上游合并时按下面的清单核对。

皮肤改动相对**上游 v0.2.4** 的完整清单（用它和新版做三方合并）：

**新增文件**
```
packs/stronghold-skins/pack.json                          数据包清单（type: data）
packs/stronghold-skins/patch.json                         皮肤内容：目录 + 已安装清单（由 tools/skins-pack.mjs 生成）
public/assets/char/skin_avatar/**                        (271 个)
public/assets/spine/op/<charId>/<skinDir>/**             (172 个目录 / 1023 个文件)
public/js/ui/skins.js
public/js/ui/skinPicker.js
docs/SKINS.md                                            (本文件)
tools/skins-pack.mjs                                     (把皮肤内容搬进/合并进包的生成步骤)
```

**改动文件**（共 21 个代码/样式文件 + 基表）
```
data/assets.json                       不再含 skins 块（内容搬进 packs/stronghold-skins/）
data/skins.json                        空目录（同上；基表由 npm run build-data 产出）
server/data.js                         DATA_FILES 加 'skins'：让包能补丁 /data/skins.json（客户端要读的表）
shared/protocol.js                     SKIN_LIMITS / isSkinId / isSkinSelection + C2S['room.skins']
server/net.js                          Session.skins + HEAVY_TYPES 加 'room.skins'
server/lobby.js                        freezeSkins() + skins() + 分发 + 座位/welcome 字段
server/match/PlayerState.js            this.skins 初始化
server/match/player/basics.js          setSkins() / skinOf() + import isSkinId
server/match/player/views.js           m.private.skins
server/match/player/round.js           battleInput() 的 u.skin
server/match/match/platform.js         setSkins()
server/match/match/views.js            players[].skins + 两处 UnitInfo 的 skin
server/sim/units.js                    Unit.skin
server/sim/battle/players.js           _createAllyFromInput 透传 skin
server/sim/snapshot.js                 UnitInfo.skin
public/js/data.js                      DATA_FILES.skins
public/js/assets.js                    skinRecord / opts.skin / hasBackSpine(skinId) / defaultSpine / unitPictureUrl(opts)
public/js/main.js                      installSkinsSync
public/js/screens/loadout.js           挂 SkinSection
public/js/ui/gameComponents.js         GAME_FILES 加 'skins'
public/js/render/units.js              info.skin 四处
public/js/render/app.js                skinMap + ownSkin()
public/js/render/app/info.js           renderInfo 透传 skin
public/css/screens/loadout.css         皮肤区块样式
public/i18n/{en,ja,ko,zh-TW}.json      5 条皮肤文案（+ 1 条 fork 自己漏译的素材目录提示）
```

**合并时踩到的 3 个真问题（都已修）**
1. **紧凑 wire 协议**：`shared/wireSchema.js` 的 v1 目录是**冻结**的（有指纹测试），不能新增数字 id。`room.skins` 属于 post-v1 类型，按该仓库的策略登记进 `test/wire-codec.test.js` 的 `V1_JSON_FALLBACK.c2s`，走可读 JSON 帧（`encodeWire` 对未登记类型本来就自动回退）。
2. **i18n 硬性规则**：皮肤区块的文案必须进 4 个语言包，否则 `node tools/i18n.mjs check --all --strict` 不通过。已复用既有的 `默认` / `已装备`，新增 5 条并按 4 语言翻译（顺便补上 fork 自己缺的 `请先获取或导入当前素材目录 JSON。` 那条）。现在 4 个包都是 100%。
3. **皮肤 atlas 缺 `size:` 行**：融合版的皮肤图集导出时漏了官方每个 atlas 都有的 `size:` 行（341 个全缺），`test/assets.test.js` 的「every atlas on disk has size: lines」会失败。已按各 atlas 页面 PNG 的 IHDR 实际尺寸补上（不猜），多页图集也处理了。


## 7.1 修复：皮肤没有进入战斗（2026-10-12）

**症状**（玩家反馈）：准备阶段皮肤显示正常，**一进战斗就变回原皮**。

**根因**：`server/sim/battle/players.js` 的 `_makeAlly()` 构造 `new Unit({ … })` 时**没有把 `extra.skin` 放进 init 对象**，而 `server/sim/units.js` 是 `this.skin = init.skin ?? null`。于是整条链路上游全部正确（`battleInput()` 的 `u.skin` → `buildBattleSpec` 的 JSON 往返 → `_makeAlly(… { skin: inp.skin })`），却在**最后一步进入 Unit 构造函数时丢掉**；`snapshot.js` 的 `skin: u.skin ?? undefined` 因此永远发 `undefined`，战场只能画原皮。准备阶段不走 sim（`m.private.skins` + `render/app.js` 的 `ownSkin` 直接解析），所以完全不受影响——这正是"只有战斗里消失"的原因。

**修复**：`_makeAlly` 的 init 加一行 `skin: extra.skin ?? null`。

**为什么以前没测出来**：§9 原先那条验证只断言了 `b.start.spec.players[].units[].skin`（**战斗输入**带皮肤），没有断言模拟器**真的把它放进了单位**。现在 `test/skins-combat.test.js` 把每一跳都钉住了：对局 → `battleInput` → spec → `createBattleFromSpec` → `battle.fieldMeta()`（推进到单位登场后）→ `renderInfo` → `spineEntry` 解析出的 `.skel` 必须等于**皮肤自己的**骨架。

**顺带修正的产品问题**：选择器原本对全部 271 款都写「已安装 {k}」，玩家无从知道哪 99 款换了也不会影响战场。现在顶部写「{n} 款可选 · {k} 款含战斗模型」，并在这些皮肤上打「仅头像」角标（§6）。


## 8. 已知未做

- **99 款皮肤只有头像，没有战场模型**（58 名干员一款带模型的都没有，例如 浊心斯卡蒂 / 陈 / 煌 / 凯尔希 / 幽灵鲨）。选它们只换头像、立绘与详情面板，棋盘和作战仍用原干员模型——这是**素材集本身的边界**（融合版同样只有 172 款模型；`public/assets/spine/op/` 下对应的皮肤目录确实不存在）。要给这些皮肤补模型，只能从本机游戏客户端提取（`tools/local-extract.mjs` 那条路），不是改代码能解决的。选择器现在会把这些标成**「仅头像」**，见 §6。
- **结算页阵容**（`server/match/results.js` 的 `lineup`）没有带 `skin`，`public/js/screens/result.js` 也没消费——结算页的干员头像仍是原皮。融合版同样没做。
- 皮肤**不影响**「干员持有」的补位（stand-in）模型：补位出场时画的是补位干员，皮肤按被替换的棋子键查，因此通常不生效。
- 皮肤语音 / 皮肤专属立绘没有移植（融合版也没有）。
- 未做真机多人联机压测（本功能与人数无关，但 271 款皮肤的头像会在「干员调配」里一次性请求）。
- **5 款皮肤的 `anims` 引用了骨架里不存在的 clip**（从融合版继承的既有数据缺陷，不是移植引入）。渲染器对缺失 clip 是**静默忽略**（`render/spine.js` 的 `_play`/`_queue` 都有 `if (!this.has(name)) return false`，`_idleName` 还会退到 `Idle` 或第一个 clip），所以不会崩、不会卡动作，只是那一个动作没有专属动画：

  | 皮肤 | 缺失的 clip | 表现 |
  |---|---|---|
  | `char_183_skgoat@epoque#30` | `Skill_Loop` | 技能循环用回 idle |
  | `char_150_snakek@wild#1` | `Skill_Begin` | 技能起手用回 idle |
  | `char_426_billro@snow#3` | `Skill_Begin`、`Skill_2_Begin` | 两个技能的起手都用回 idle |
  | `char_388_mint@epoque#22` | `back:Die` | 该皮肤 Back 模型没有倒地动作，被击倒时改用 Front 模型（这正是 `_wantsBack` 的设计行为，官方原皮也有 131/135 个 Back 模型没有 Die） |
  | `char_4064_mlynar@epoque#28` | `back:Die` | 同上 |

  对照组：**172 款原皮模型和其余 167 款皮肤全部通过**同一项检查。若要修，应按骨架实际的 clip 名重算这 5 条 `anims`，而不是猜一个近似名字。


## 9. 验证

```bash
node --test            # 官方 0.2.4 发布包里没有 test/，无法运行上游测试套件
```

发布包不含 `test/`，所以本次移植用以下方式验证（结果都通过）：

1. **数据**：`/data/skins.json`（172 干员 / 271 款）与 `/data/assets.json`（172 干员带 skins 块，172 款带 spine）经 HTTP 正确返回。
2. **客户端资源解析**：`assets.js` 的 `avatarUrl` / `spineEntry` / `hasBackSpine` / `unitPictureUrl` 用真实清单跑 17 条断言，含「未知 skinId 回退原皮」「只有头像的皮肤回退原皮」；271 款头像文件、172 款模型文件（front + back 的 skel/atlas/texture）全部存在。
3. **协议与对局**：真实 WebSocket 会话验证 `room.skins` 被接受、未知 key 被丢弃、非法 skinId 返回 `BAD_MSG`、`m.public` / `m.private` 带上选择、**局内修改立刻生效并重播**。
4. **作战输入**：驱动一整局到 COMBAT，`b.start.spec.players[].units[]` 里上阵的棋子带上了 `skin: 'char_498_inside@kitchen#2'`——即服务端发给客户端模拟器的战斗输入确实携带皮肤。
   **但这条太浅**：它只证明了"输入带皮肤"，没证明"模拟器把它放进了单位"，`_makeAlly` 的缺陷就是这样漏过去的（见 §7.1）。现在由 `test/skins-combat.test.js` 全程钉住（对局 → 战斗输入 → spec → `createBattleFromSpec` → `battle.fieldMeta()` → `renderInfo` → `spineEntry` 的 `.skel`）。
5. **浏览器**：headless Chrome 打开页面 → 进大厅 → 打开「干员调配」→ 皮肤区块渲染、头像全部加载成功、点击后写入 `localStorage` 并标记「已装配」，**无任何 JS 异常或 console 报错**。修复后同一流程复核：全头像干员（浊心斯卡蒂）顶部显示「2 款可选 · 0 款含战斗模型」、两款都带「仅头像」角标与说明性 `title`；带模型干员（隐现）显示「2 款可选 · 2 款含战斗模型」、无角标。
6. **模型**：真实 `pixi-spine` 加载**全部 172 款**皮肤模型（front + back），被清单引用的每个 clip（idle / deploy / attack / die / skill / skills / reborn）在 skeleton 中都存在——原皮模型作为对照组同样全部通过（例外见 §8 的 5 款）。
7. **自动化**：`node --test test/skins-combat.test.js`（5 条：对局内的选择 → 战斗输入 → spec 往返 → 模拟器与 `fieldMeta` → 客户端解析到皮肤骨架；另有"只有头像的皮肤按文档回退原皮"与"选择器的 `battle` 标记与清单逐条一致"）。`node tools/golden.mjs` 全部 287 个场景不变（未设皮肤时 `skin` 仍为 `null`，确定性不受影响）。

手动试验：在本目录运行 `node server/index.js`（或 `scripts/launch.mjs`），浏览器打开 → 输入代号 → 「干员调配」→ 选一个**带模型**的干员（例如 隐现 / 澄闪 / 维娜；面板顶部会写「{n} 款可选 · {k} 款含战斗模型」）→ **皮肤** 区块选一款 → 开局上阵即可看到模型。带「仅头像」角标的那些在战场上不会变样（见 §8）。
