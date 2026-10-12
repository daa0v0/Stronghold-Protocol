# mods/ — code mods

A **code mod** is a folder with a module this server imports and runs **inside its own process**, with the server's
privileges. It is deliberately not a content pack: a pack's manifest never runs anything and a pack's files are served to
browsers, while a mod is code. So this tree is never served, never listed in `/packs/index.json`, and **a folder dropped
here does nothing until the server owner enables it**.

## Shipped examples

Real, enableable mods live here — read one instead of only a sketch:

| Folder | What it changes |
|---|---|
| `dup-strategies/` | 同一机变卡池内多名玩家可选同一张卡 (`shared/matchRules.js` `choiceDuplicates`) |
| `revive-teammate/` | 机变里新增「复生协议」：扣自己 10 点血量复活一名队友（卡片随 `packs/revive-teammate/` 下发，效果由本 mod 注册） |
| `shared-health-bar/` | 全队共用一条血条，大小可配置为队内所选方针总和的 `sum` 或 `max`（`shared/matchRules.js` `sharedLp`） |

Each ships its own `config.json` (an owner can keep the mod installed but off) and its own test under `test/match/`.
The rules a mod may change are listed in [docs/MODS.md](../docs/MODS.md) §4.6 — an ES module's exports cannot be reassigned
from outside, so behaviour changes go through a hook the core provides.

## Layout

```
mods/my-mod/mod.json      the manifest
mods/my-mod/main.mjs      the entry (any .mjs / .js path inside the folder)
```

```json
{
  "id": "my-mod",
  "name": "我的 mod",
  "version": "1.0.0",
  "app": ">=0.2.4",
  "authors": ["your name"],
  "entry": "main.mjs"
}
```

`id` must match the folder name; `entry` must be a path inside the folder (the loader reads nothing else from it). Anything
else is optional. `"type"` is a *pack* field: a manifest that has one is refused, so a pack copied here by mistake is
reported instead of silently running.

## Enabling

Nothing runs by default. The owner lists the ids in the private settings file, or flips them in the console:

```json
{ "version": 1, "mods": { "enabled": ["my-mod"] } }
```

- `/admin` → 代码 mod: the list, 启用 / 停用, and the reason a mod failed to load.
- A change takes effect at the **next start**: a module is imported once and cannot be unloaded from a running process, and
  the panel says so.
- The server reports what it runs in `GET /healthz` → `mods.code` (apart from the content tag on a purpose: a code mod runs
  server-side only, so a client cannot verify it — it is told, not trusted).

## What a mod can do

Its entry exports `setup(ctx)` (or a default function), which is awaited once at start, after the content packs and the
data tables:

```js
export async function setup(ctx) {
  ctx.log.info('hello from', ctx.id, ctx.version);
  // ctx = { id, version, log, data, packs, root }
  // The entry is an ordinary ES module of this process: it may import anything under server/ too — the simulation's
  // content extension points (server/sim/content/…) included, which is how a gameplay mod changes the game.
}
```

A mod that throws is reported in `/admin` and in the start log, and the server keeps booting: one broken mod must not take
the server down.

## The trust boundary

**Treat a downloaded mod as a downloaded executable.** Enabling one is giving its author whatever this server can do:
read and write its files, use its network, see every player. The loader gives you an explicit switch and an honest report;
it cannot make third-party code safe.

The full author's manual — both kinds of mod, every field and limit, what a mod can never do, testing and shipping:
[docs/MODS.md](../docs/MODS.md). Details and the owner's decisions: [docs/PACKS.md](../docs/PACKS.md) §4 "Code and gameplay
mods" and [docs/ADMIN.md](../docs/ADMIN.md) §5.
