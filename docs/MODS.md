# MODS.md — 写 mod 的规则与做法

这不是设计文档，而是**作者手册**：你要达成某个效果时该做哪一种 mod、清单怎么写、哪些字段有什么限制、提交前要跑什么。
机制与设计取舍在 [PACKS.md](PACKS.md)；两种 mod 的快速上手分别在 [../packs/README.md](../packs/README.md) 与
[../mods/README.md](../mods/README.md)。

## 0. 先决定做什么

| 你想要的效果 | 该做的 mod | 为什么 |
|---|---|---|
| 换美术 / 模型 / 音频 / 字体 | `assets` **内容包** | 服务器把替换表下发给浏览器，客户端按表改写素材 URL |
| 改数值、加干员/道具/羁绊/关卡、调整平衡 | `data` **内容包** | 服务器启动时合并补丁，并把**打过补丁的表**下发给浏览器 |
| 加/改界面与游戏文案、加一门语言 | `lang` **内容包** | 语言包实时生效，且不参与内容标识 |
| 加房间人数档位、人数分组规则、轮次上限 | `data` **内容包**（范例 `packs/capacity-20/`） | 这些是**策略**，住在 `data/capacity.json` |
| 改玩法逻辑、加新机制、注册新的内容钩子 | **代码 mod**（`mods/<id>/`） | 只有代码 mod 能运行代码，且必须由服主显式启用 |
| 改协议（新增消息、改座位表、改编码） | **都不是** | 见 §5：v1 位置表冻结，属于核心改动 |
| 改浏览器端代码（`public/js/**`） | **都不是** | 浏览器运行的是服务器下发的文件，属于核心改动 |

一句话：**内容包改数据，代码 mod 改行为；两者都不能改协议，也不能让包执行代码。**

## 1. 现状一览（本仓库自带的真实范例）

| 目录 | 类型 | 它做什么 | 测试 |
|---|---|---|---|
| `packs/capacity-20/` | `data` | 房间人数策略：4/8/10/16/20、默认 8、6 人起按 `poolGroupLayouts` 分组、轮次上限 | `test/capacity-pack.test.js` |
| `packs/stronghold-skins/` | `data` | 干员皮肤：目录 + 已安装清单（**美术仍在 `public/assets/`，不入 git**） | `test/skins-pack.test.js` |

两者都演示了同一个思路：**能力留在核心，策略/内容搬进包**。`capacity-20` 关掉后服务器回到上游基线（只有 4 人房、单池、不分组）；
`stronghold-skins` 关掉后皮肤整体消失（列表为空，界面自然降级）。

## 2. 硬规则（先读，能省你很多返工）

- **R1 包不执行代码。** 清单永远只是数据；唯一能运行代码的是 `mods/<id>/`，而且必须服主启用。
- **R2 永不手改 `data/*.json`。** 那是生成物：改 `tools/build-data.mjs` 或对应的生成工具（皮肤的 `tools/skins-pack.mjs`）并重跑。
- **R3 协议 v1 的位置表冻结。** 不能重排、不能复用 id；**新增字段**走既有的扩展槽并登记到 `test/wire-codec.test.js` 的
  `V1_EXTENSIONS`；**新增消息类型**必须走 JSON 回退（`V1_JSON_FALLBACK`）或一次真正的协议修订。
- **R4 美术不入 git。** `public/assets/` 被忽略；包可以携带**指向它的路径**（`stronghold-skins` 就是这么做的）。
- **R5 界面文案走 `t('…')`**，并在 `public/i18n/{en,ja,ko,zh-TW}.json` 四份里都有条目（`node tools/i18n.mjs check --all --strict` 必须 100%）。
- **R6 文档跟着代码走。** 改了规则就改 `docs/`；跑 `node --test test/docs-consistency.test.js test/docs-paths.test.js`。
- **R7 一个提交一个主题**，不要在提交信息里加署名 trailer。

## 3. 内容包

### 3.1 目录与清单

```
packs/<id>/pack.json        清单（必须）
packs/<id>/<你引用的文件>    清单里 files.<角色> 指到的文件
```

`pack.json` 的字段（其余字段会被忽略并给出警告；`files` 里未定义的角色也会警告）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | ✅ | `lang` / `assets` / `data` |
| `name` | ✅ | 显示名（≤60 字符） |
| `englishName` | — | 英文名（≤60） |
| `version` | — | 你自己定的版本号（≤40）；**内容标识包含它**，改版本等于改内容 |
| `app` | — | 适用版本范围，如 `">=0.2.4"`（≤60）。范围不匹配时：`identity` 包需服主确认才加载，语言包照常加载并标记 |
| `authors` | — | 字符串数组 |
| `credits` / `license` | — | ≤500 / ≤100 |
| `files` | ✅ | 角色 → 文件名（或文件列表，见各类型） |

`<id>` 规则：字母、数字、`.`、`_`、`-`（不能以 `-` 开头），≤64。**id 就是身份**：包名改了等于换了一个包。

### 3.2 `lang` — 语言

```json
{ "type": "lang", "lang": "ja", "name": "日本語", "englishName": "Japanese", "version": "1.0.0",
  "app": ">=0.2.0", "authors": ["you"], "fallback": ["en"], "files": { "ui": "ui.json", "data": "data.json" } }
```

- `files.ui` 必填，`files.data` 可选；两者都可以是文件**列表**。
- 单文件语言包：`public/i18n/<code>.json`，同样的字段放进 `_meta` 块（英语就是这么发的）。
- 语言包**不参与内容标识**（`identity: false`）、实时生效、**不能被服主停用**（请求会得到 `409 LANGUAGE_LOCKED`）。

### 3.3 `assets` — 美术 / 模型 / 音频 / 字体

```json
{ "type": "assets", "name": "我的美术", "version": "1.0.0", "app": ">=0.2.4",
  "files": { "map": "map.json", "media": ["a.png", "b.webp"] } }
```

- `map.json` 是 `{ "<本服务器的资源 URL>": "<本包池子里的文件，写成 /packs/<id>/<路径>>" }`。
- `media` 是**池子**：列出的文件才存在，其余路径一律 404。单文件上限与扩展名白名单见 `shared/packs.js`。
- 上限：**5000 条改写**；冲突（两个包改同一个 URL）按 id 较大者生效，并在日志与 `/admin` 里报告。
- `assets` 是 `live`：重新扫描后立刻生效，不需要重启。

### 3.4 `data` — 游戏数据表

```json
{ "type": "data", "name": "我的数值", "version": "1.0.0", "app": ">=0.2.4", "files": { "patch": "patch.json" } }
```

`patch.json` 的形状是 `{ "<数据文件名>": <合并补丁> }`：

- **补丁是 RFC 7386 合并补丁**：对象逐层合并、数组整体替换、`null` 删除该键、其余按值替换。
- `<数据文件名>` 必须在服务端的表名单里，否则整条被忽略并告警。当前名单：
  `config`、`chess`、`bonds`、`garrisons`、`items`、`bands`、`effects`、`choices`、`enemies`、`factions`、`waves`、
  `stages`、`bosses`、`tokens`、`assets`、`backups`、`skins`、`capacity`。
- 单文件上限 **8 MB**；`files.patch` 可以是多个文件（列表），按顺序合并。
- **服务器启动时**应用一次，并把**打过补丁的表**从 `/data/<名>.json` 下发——浏览器读到的就是服务器模拟用的那份。
  因此 `data` 包不是 `live`：停用/启用要**重启**，`/admin` 会明确返回 `restartRequired`。
- 例：`{"configuration"}` 不合法，`{"config": {"bossHpScale": {"per": 1.1}}}` 合法（键必须是真实表名）。

### 3.5 身份、内容标识与每局选择

- `identity: true`（`assets`、`data`）的包属于服务器的**内容身份**：`GET /healthz → mods.tag` 是所有 `identity` 包
  `type:id:version:size` 的哈希。页面自己也算一遍并比对，不一致就提示"请刷新页面"。
- 房主在**建房面板**里可以为**这一局**勾掉某些 `identity` 包（`room.create { mods }`，服务端回 `room.mods`）：
  - 只能**收窄**，不能加开服务器没加载的包；
  - **`data` 包不能按局关闭**（表在启动时就固定了），所以它们在面板上是锁定行；
  - 只能房主、只能在大厅里改，改动会取消其他人的准备状态。

### 3.6 服主开关（服务器级）

- 面板：`/admin → 内容包`（启用/停用、确认加载不兼容的 `identity` 包、看冲突）。
- 文件：`runtime/server-settings.json` → `packs: { "off": ["<id>"], "allow": ["<id>"] }`（`allow` = 确认加载不兼容的包）。
- 语义：`off` 优先；不兼容的 `identity` 包在被 `allow` 之前**不加载**（语言包例外）。

## 4. 代码 mod

### 4.1 目录与清单

```
mods/<id>/mod.json     清单
mods/<id>/main.mjs     入口（`entry` 指到的那个文件，路径必须在包内，`.mjs` / `.js`）
```

```json
{ "id": "my-mod", "name": "我的 mod", "version": "1.0.0", "app": ">=0.2.4",
  "authors": ["you"], "entry": "main.mjs" }
```

- 允许的字段只有 `id`、`name`、`version`、`app`、`authors`、`credits`、`license`、`entry`（其余警告；`type` 会被**拒绝**——
  那是包的字段，把包放进 `mods/` 会得到明确报错而不是静默执行）。
- 单文件上限 256 KB，最多 **64** 个 mod。
- 入口必须导出 `setup(ctx)`（或 `default` 函数）。

### 4.2 `setup(ctx)` 契约

```js
export async function setup(ctx) {
  ctx.log.info('hello from', ctx.id, ctx.version);
  // ctx = { id, version, log, data, packs, root }
  //   log   带 `[mod <id>]` 前缀的 logger
  //   data  服务器实际使用的数据表（已应用所有 data 包的补丁）
  //   packs 包注册表（只读使用）
  //   root  仓库根目录
}
```

- 入口是**本进程里的普通 ES 模块**：可以 `await import()` `server/` 下的任何东西，包括模拟的内容扩展点
  （`server/sim/content/…` 的 kits / traits / effects 注册表）。
- **加载时机**：启动时、所有内容包与数据表之后，按 **id 顺序**，`setup` 被 `await`。抛出的错误会被记录并跳过——
  一个坏 mod 不会让服务器起不来。
- 服务器重启才生效（模块无法热卸载），`/admin` 会说明这一点。

### 4.3 启用与报告

- 服主显式启用：`/admin → 代码 mod`，或 `runtime/server-settings.json` → `mods: { "enabled": ["my-mod"] }`。**默认一个都不启用**：
  把一个目录丢进 `mods/` 不会执行任何东西。
- `GET /healthz → mods.code` 报告正在运行的 mod（`[{ id, version }]`），与内容包 `tag` **分开**：代码 mod 只在服务端运行，
  浏览器无法校验，只能被告知。设置 → 问题反馈里也是这么写的。

### 4.4 信任边界

**下载来的 mod = 下载来的可执行文件。** 启用它等于把服务器能做的事交给它：读写本机文件、使用网络、看到每一名玩家。
加载器只能给你一个明确的开关和如实的报告，它不能让第三方代码变安全。只启用你读过或信任的 mod。

### 4.5 本仓库自带的 mod

它们是**可直接启用的真实 mod**，也是最好的抄写样板（每个都有自己的 `config.json`、自己的测试）：

| 目录 | 做什么 | 用到的扩展点 |
|---|---|---|
| `mods/dup-strategies/` | **开局选策略（方针）时，同一池组内多名玩家可以选择同一个**（原版队友已选的方针不能再选）。 | `shared/matchRules.js` 的 `bandDuplicates` |
| `mods/revive-teammate/` | **有人被淘汰的那一回合结算后，每个存活队友都会被问一次**：要不要扣自己 10 点血量把他救回来（**只有 1 点血**）。任一队友选择即可，先选的生效；准备期开始前未作答视为放弃。 | `shared/modChoices.js`（`registerModSettleHook` + `registerModChoice`）、`Match.offerModChoice/pickModChoice/autoModChoice`、`Match.revivePlayer()`/`applyLp()` |
| `mods/shared-health-bar/` | **全队共用一条血条**：所有人始终持有同一个血量值，大小可配置为队内所选方针 `totalHp` 的**总和**或**最高**（也可按建池时的当前血量取）。 | `shared/matchRules.js` 的 `sharedLp`、健康值收口 `Match.applyLp()` |

启用方式与任何 mod 一样：`/admin → 代码 mod → 启用`（或 `runtime/server-settings.json` 的 `mods.enabled`），然后**重启**。
不想要了就删掉目录、或在 `config.json` 里关掉它自己的开关。

### 4.6 mod 能用的扩展点

**ES 模块的导出不能被外部改写**，所以 mod 不能靠覆盖一个函数来改规则或加效果。核心为此提供三类入口，默认值都等于游戏本来的行为：

**① 可调的规则：`shared/matchRules.js`**

允许 mod 改的对局规则住在这里，而且**所有读取方都问它**（选牌路径、不变量审计、下发给客户端的视图），这样规则不可能只生效一半
（否则审计会拒绝一局游戏明明打完了的对局）：

| 规则 | 默认 | 含义 |
|---|---|---|
| `bandDuplicates` | `false` | 开局选策略（方针）时，同一池组内多人能否选同一个？`false` = 队友已选（`Match.bandTaken` 一名持有者） |
| `sharedLp` | `null` | 全队共用一条血条？`null` = 每人一条（原版）。否则 `{ mode: 'sum' \| 'max', source: 'band' \| 'lp' }`：血条大小 = 队内所选方针 `totalHp`（`band`）或建池时的当前血量（`lp`）的**总和**或**最高** |

规则分**两层**，因为一个 mod 是**按服务器加载、按房间生效**的：

- `setMatchRules({...})` 改的是**服务器级**规则（测试与诊断用；写错的键会被报告并忽略）；
- 每个 mod 在 `setup(ctx)` 里注册一个**按局提供者**，每局创建时问一次，可以回答自己这一局在不在：
  ```js
  registerMatchRuleProvider('my-mod', (m) => ({ bandDuplicates: m.modEnabled('my-mod') }));
  ```
- `Match.rules` 是两者合并后的结果，也是四个读取方真正读的东西（血量收口、方针抽选、下发视图、审计）。
  `Match.modEnabled(id)`：房间没有收窄时＝全部启用，收窄了就只看它选中的。

**①b mod 自己的可调选项（`mod.json` 的 `options`）**

一个 mod 常有旋钮（"总和还是最高？""按方针还是按当前血量？"）。它可以在 `mod.json` 里声明，**房间的房主按局设置**，
核心只按声明校验、不需要知道旋钮的含义（`shared/modOptions.js`）：

```json
"options": {
  "mode":   { "type": "enum", "values": ["sum", "max"], "default": "sum", "label": "血条大小", "description": "相加或取最高" },
  "source": { "type": "enum", "values": ["band", "lp"], "default": "band", "label": "血量来源" }
}
```

- `type` 只能是 `enum`（带 `values`）、`number`（可带 `min`/`max`）或 `boolean`；每项必须有 `default`。
- 声明**整块**不是对象 → 该 mod 被跳过；**单个选项**写错 → 只丢掉那一项并给出警告（一个旋钮的笔误不该让整个 mod 失效）。
- 房间提交的取值 `{ "<modId>": { "<option>": 值 } }` 会被逐项校验：未声明的键、类型不符、越界一律**拒绝**（`ERR.MODS` 带原因）；
  只有"服务器已启用 **且** 本局确实运行"的 mod 才能带取值。
- **取值优先级**：房间本局取值 > mod 自己的 `config.json`（服务器默认）> 声明里的 `default`。所以 mod 应当这样写：
  ```js
  const room = m.modOptions(MOD_ID);            // 房间设了什么（可能为空对象）
  const mode = room.mode ?? config.mode ?? 'sum';
  ```
- 房间界面（弹窗）按声明自动渲染控件：`enum` → 分段按钮、`boolean` → 开/关、`number` → 数字输入；只渲染房主可改，
  其他人看到同样的信息但不可点。界面只回传**房间已有的取值 + 这次改动**，从不把"默认值"写回房间——否则服务器默认就被永久压掉了。

- **`taken` 的形状不变**：`choiceDuplicates` 下它仍然只记录**第一个**持有者，其他人只出现在 `picks` 里——这样已经发布的
  客户端结构不用改，也让"谁先拿的"这个信息保持可读。
- **新字段要在协议守卫里登记**：视图里给客户端的新字段（例如 `m.public.sp.allowDuplicates`，客户端据此不再把已被选走的卡
  灰掉）要在 `test/wire-codec.test.js` 的视图允许清单里显式声明，理由和既有的 `card.soldOut` 一样：v1 之后新增的视图字段
  没有 v1 位置，必须写清楚它是谁加的、为什么。

**② 内容效果：`shared/modContent.js`**

机变卡的效果（`choice:<effectId>`）、kit / trait / effect 这类"内容"由 `server/sim/content/*.js` 注册：每个模块导出
`registerMeta(registry)`（对局开始前的注册）与/或 `install(battle)`（战斗内）。mod 用同一个形状注册自己：

```js
import { registerModContent } from '../../shared/modContent.js';

export async function setup(ctx) {
  registerModContent({
    name: 'my-effect',
    registerMeta(registry) {
      registry.choice('my_effect_id', { onChoicePick(ctx, ev) { /* … */ } });   // 键就是 choice:<id>
    },
  });
}
```

引擎把 mod 的模块排在自带内容**之后**注册，因此同名键**由 mod 覆盖内置实现**（`registry.register` 是替换）。处理器收到的 `ctx`
与内置内容完全一样，另外多一个 **`ctx.match`**：需要访问器没覆盖的服务端状态（读名册、改血量）时走这里。

> 一个真实的坑：`ctx.player` **不是**本次钩子的玩家，而是"取另一名玩家的嵌套上下文"的内置访问器（`ctx.player(playerId)`）。
> 要拿当前玩家，用 `ctx.match.players.get(ctx.playerId)`。

**③ 复活 API：`Match.revivableTeammates()` / `Match.revivePlayer(playerId, { lp })`**

`eliminate()` 的反面住在核心里（`server/match/match/revive.js`），因为它必须把**所有**认为该座位已出局的读者一起修好：
`alive` / `eliminatedRound` / 血量、商店（淘汰时被清空，活着的座位必须有）、以及进行中的领袖血池按存活人数重算。
规则（谁能复活、代价多少、回多少血）属于 mod；状态变更属于核心——一半复活的座位会让名册、视图和不变量审计互相矛盾。

**加一张新卡或一个新选择**：卡片本身是数据（例如 `choices.cards.tactic`），客户端也照它渲染。注意 **合补丁会整体替换数组**：
包要新增一个数组条目就必须给出**整张列表**，所以这类补丁应当由工具从 `data/*.json` 生成（`tools/capacity.mjs` 是现成范例），
而不是手抄——手抄的那一份会在游戏更新时悄悄过期。

**④ 一处健康值收口：`server/match/match/lp.js`**

血量在核心里有五个写入点（方针抽选赋初始值、战斗伤害、隐藏核心的重新分配、淘汰归零、中途退出）。规则若分别落在这些地方
就会各写各的、迟早漂移，所以全部收口成 `Match.applyLp(ps, value)` / `Match.loseLp(ps, loss)`：**没有规则时只写这一名玩家
（与原来逐字等价）**，有 `sharedLp` 规则时写全队存活者——这就是"一条血条"的实现。配套：

- `Match.sharedLpSize()` 算出这条血条该多大（按规则取总和或最高），`Match.initSharedLp()` 在**方针抽选结束**时调用，
  因为大小取决于全队选完的方针；
- 不变量审计（`audit.js` 的 `bands` 检查）与淘汰判定（`invariants.js` 的"活着就不能 0 血"）都改为**策略感知**：共享规则下
  一个人 0 血不等于他出局，而是**全队出局**（下一次结算执行淘汰）；
- 隐藏核心的重新分配在共享规则下把**队伍总量按人数均分**（保持"全队同一个值"），关闭规则时仍是原版的逐座位分配；
- 共享规则下血条为 0 时无法复活（`Match.revivePlayer` 返回 `TEAM_BAR_EMPTY`）——没有可回去的血量；
- **别和 `Match.teamLp` 搞混**：那是最终攻势/隐藏核心的合并血池（存活者 LP 之和，仅在首领阶段存在），是另一件事。
  最初我就是重名撞上了它，构造函数里的 `this.teamLp = null` 直接把 getter 覆盖成了报错——所以本规则叫 `sharedLp`。

> 界面：血量数值本身已经全队一致（每个座位显示同一个数），但**客户端仍按座位画 N 条进度条**。要把它画成"一条"需要下发一个
> 视图字段并在 `ui/teamPanel.js` / `ui/hud.js` 合并渲染——那是核心改动（协议视图字段要登记，见上面的注意事项），不属于这个
> mod 的范围。

**⑤ 让 mod 向玩家提问：`shared/modChoices.js`**

原版只有一种玩家选择（教鞭的个人选择，选中的卡变成悬赏）。mod 想"问点什么"（"花 10 点血量复活他？"）既不能新增消息
（那是协议修订），也不能改写 ESM 导出，所以**管道由核心提供、规则由 mod 提供**：

```js
import { registerModChoice, registerModSettleHook } from '../../shared/modChoices.js';

export async function setup(ctx) {
  registerModChoice({
    id: 'my-question',
    onPick(m, ps, { card, idx, data }) { /* 玩家作答 */ },
    onDecline(m, ps, { data }) { /* 超时或未作答 */ },
  });
  registerModSettleHook((m, { eliminated }) => {
    // 每一局里"有人出局"的那次结算各调用一次；eliminated 是本次出局的座位（不含中途退出的人）
    for (const out of eliminated) for (const ps of m.alivePlayers()) {
      m.offerModChoice(ps, 'my-question', { title: '…', desc: '…', cards: [{ … }, { … }], data: { target: out.playerId } });
    }
  });
}
```

机制与边界（都写进了代码与不变量）：

- **复用现有通道**：问题存在 `ps.personalChoice` 里，于是 `m.private`、`g.choice { idx, choiceId }` 与客户端的 `ChoiceView`
  全都不用改——**没有新增任何 wire 类型**；
- **窗口**：`settle.js` 在淘汰发生后调用结算钩子；`MOD_CHOICE_WINDOW`（SETTLE → 下一回合准备期）内可以作答，
  `enterPrep()` 一进来就 `expireModChoice`（走 mod 的 `onDecline`），所以"未作答＝放弃"由 mod 定义；
- **一次一个**：已经有选择在等待的玩家不会被再问（`BUSY`），**AI 座位从不被提问**（`BOT`）——它没法自己回答；
- **作答路由**：`g.choice` 在 `ps.personalChoice.modId` 存在时走 `pickModChoice` → mod 的 `onPick`，而不是变成悬赏；
- **不变量审计知道这回事**：`invariants.js` 里"个人选择只能在准备期、最多 3 张、不能重复"这套规则是**教鞭的**，
  对 mod 选择改为按窗口与 `cards ≤ 8` 检查——否则一局合法对局会被审计判违规（我在实现 mod 2 时就被它挡下来了）；
- **文案**：`mods/` 不在 i18n 扫描范围内（`tools/i18n.mjs` 只扫 `public/js`、`shared`、`server`），所以 mod 自带的中文
  不会让 `i18n check --strict` 失败；想让 mod 的卡也走四语言，就随 mod 附一个 `lang` 内容包（§3.1）；
- **与共享血条的交互**：两个 mod 同时启用时，10 点代价走 `Match.applyLp()`，共享规则下由**那条共享血条**承担（全队同减），
  复活者的血量也由共享血条决定（不再是 1 点）；血条为 0 时 `revivePlayer` 返回 `TEAM_BAR_EMPTY`，mod 会拒绝并如实记录。

## 5. 什么永远做不到（结构性限制）

| 不能做 | 为什么 |
|---|---|
| 让内容包执行代码 | 清单只描述数据；这是"包不能变木马"的前提 |
| 改协议 v1 的位置表、座位数上限、结果字段 | 服务器与每个浏览器必须对同一张冻结表达成一致（`shared/wireSchema.js`、`MAX_SEATS`） |
| 新增一条 C2S/S2C 消息 | 老客户端会拒绝未知类型；要么走 JSON 回退，要么做一次协议修订并同步所有客户端 |
| 改浏览器端代码 | 浏览器加载的是**服务器下发的** `public/js/**`；要改就是改仓库（核心改动 + 全套测试） |
| 绕开服务端校验（经济、掉落、结果） | 那些校验在服务端；对局数据包是按局收窄，不是按客户端指定 |
| 覆盖一个 ES 模块的导出（`import` 进来直接改写） | 模块绑定是只读的；改行为必须走核心提供的钩子（§4.6） |
| 手改 `data/*.json` 而不改生成器 | R2：CI 与守卫测试会按"生成物"对待这些文件 |

`packs/capacity-20/` 就是这条线的好例子：**能力**（协议能带 20 个座位、模拟能跑 20 个单位）在核心；**策略**（提供哪些人数档、
怎么分组、几轮）在包里。所以"20 人"可以是一个开关，而"座位表"不是。

## 6. 测试与检查

```bash
node tools/packs.mjs list                 # 找到了哪些包、跳过了哪些、为什么
node tools/packs.mjs check --strict       # 有任何问题就非零退出
node tools/skins-pack.mjs --check         # 皮肤包的基表是否仍然干净（同一思路的自检工具）
node tools/capacity.mjs --check           # 人数基线表是否与模块一致、随仓库发布的策略包能否干净地应用
node --test test/capacity-pack.test.js    # 你为这个包写的测试
node --test test/docs-consistency.test.js test/docs-paths.test.js
node tools/i18n.mjs check --all --strict  # 如果你加了界面文案
npm run ci                                # 提交前的全量（含 lint / 类型 / 导入边界）
```

给自己写的包配一个测试，最少覆盖四件事（照抄 `test/capacity-pack.test.js` 的结构即可）：

1. **包被正确发现**：`createPackRegistry(serveDirs({}))` 的索引里有它，`compatible`、`patches` 符合预期；
2. **基表没被污染**（如果你的包负责"把内容从基表搬出来"）；
3. **应用包后与预期完全一致**：`applyDataPacks(loadData(...), registry.list('data'), { known: DATA_FILES })` 之后再断言；
4. **真实服务器上的效果**：`startServer({ port: 0 })`，然后 `fetch('/data/<表>.json')`、必要时 `fetch('/healthz')`；
   再配一条**关掉包**的对照（`writeServerSettings(dir, { packs: { off: [id] } })`）。

浏览器行为（界面选项、素材改写）用 `SP_E2E=1` 的套件或一次性脚本验证；协议改动必须跑 `test/wire-codec.test.js`。

## 7. 打包与发布

- `packs/`（含 `packs/index.json` 的生成步骤）与 `mods/` 都随发布包发货（`tools/package.mjs` 的 `RUNTIME_DIRS` / `PLAYER_TOOLS`）；
  代码 mod 的**加载器** `tools/admin-secret.mjs` 之类则由启动脚本调用，也在发货清单里。
- **`data` 包需要服务器**：它由服务器在启动时合并并下发。纯静态托管只能拿到生成好的 `packs/index.json`，
  拿不到打过补丁的表——所以静态托管下生效的是**基表**（这也是 `data/capacity.json` 必须是可独立运行的基线的另一个原因）。
- 版本：包自己的 `version` 参与内容标识，改内容就改它，玩家的页面会提示刷新。

## 8. 提交前的检查清单

- [ ] 目录名 = `id`，清单字段拼写正确，`files.<角色>` 都有对应文件
- [ ] 没有手改 `data/*.json`（改动来自生成工具）
- [ ] 没有把美术/下载物放进 git（用包内的**路径**指向本机素材）
- [ ] 新增界面文案已在 4 份语言包里（`i18n.mjs check --all --strict` 100%）
- [ ] 为包/ mod 写了测试，并跑了相关文件 + `docs` 守卫
- [ ] 文档更新了（本文件、PACKS.md 或对应功能文档）
- [ ] 提交信息单一主题、无署名 trailer

## 9. 相关文档

| 文档 | 什么时候看 |
|---|---|
| [PACKS.md](PACKS.md) | 机制与设计取舍：索引、内容标识、服主开关、每局选择、代码 mod 的决策记录 |
| [../packs/README.md](../packs/README.md) | 三种内容包的快速上手与最小示例 |
| [../mods/README.md](../mods/README.md) | 代码 mod 的快速上手、`setup(ctx)` 示例、信任边界 |
| [PLAYER_CAPACITY.md](PLAYER_CAPACITY.md) | 20 人的规则本身（分组表、轮次、血池、验证方法） |
| [SKINS.md](SKINS.md) | 皮肤功能：内容在包、美术不在 git 的完整案例 |
| [DATA.md](DATA.md) | `data/*.json` 各表由谁生成 |
| [I18N.md](I18N.md) | 界面文案与语言包 |
