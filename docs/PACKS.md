# PACKS.md — content packs

A **content pack** is add-on content a server picks up from a folder: a manifest plus its files. The owner's decision of
2026-10-07 made the language pack the first type of one general mechanism, so that later resource packs (art, audio,
fonts) and server-side data packs reuse the same manifest, registry and index instead of each inventing its own. In
0.2.0 one type loads, **`lang`** (a language: docs/I18N.md "Adding a language"); `assets` and `data` are planned.

| File | Role |
|---|---|
| `shared/packs.js` | the format: the manifest, the pack types (`PACK_TYPES`), app version ranges, the index (browser, server and tools) |
| `shared/i18nPacks.js` | the `lang` type: language codes, the language fields, the fallback chain, the script family |
| `server/packs.js` | the registry: discovery, validation, the index, which pack files may be served |
| `server/http/static.js` | `GET /packs/index.json` (the live index) and `GET /packs/<id>/<file>` |
| `public/js/ui/lang.js` | the client of the `lang` entries: the language menu and the loader |
| `tools/packs.mjs` | `list`, `index` (the index file for a static host), `check` |
| `tools/package.mjs` | ships the committed packs and writes `packs/index.json` into the release zips |

## 1. Layouts

Two layouts, read by the same registry and listed alike:

```
packs/<id>/pack.json + its files      a folder pack — any type; the manifest names its files
public/i18n/<code>.json               a single-file language pack — its manifest is the file's `_meta` block
data/i18n/<code>.json                   (+ its game texts, when present)
```

The single file is the quickest way for a translator (one file, the format English has always had, and how English
ships); the folder is the layout every pack type shares — a pack distributed as one folder with its own readme and
licence, and the only layout a resource or data pack will have. A language can come either way; the menu does not tell
them apart.

The id of a folder pack is its folder name; the id of a single-file language pack is its language code. Ids are
letters, digits, `.`, `_` and `-` (at most 64), unique across types and without regard to case (Windows and macOS
would see one folder).

## 2. The manifest

`packs/<id>/pack.json`, or the `_meta` block of `public/i18n/<code>.json` (the same fields):

```json
{
  "type": "lang",
  "lang": "ja",
  "name": "日本語",
  "englishName": "Japanese",
  "version": "1.0.0",
  "app": ">=0.2.0",
  "authors": ["…"],
  "credits": "…",
  "license": "CC-BY-4.0",
  "fallback": ["en"],
  "files": { "ui": "ui.json", "data": "data.json" }
}
```

| Field | Meaning |
|---|---|
| `id` | optional: the folder or file name decides; a manifest that names another id gets a warning |
| `type` | `lang` (a single-file language pack may leave it out); planned: `assets`, `data` |
| `version` | the pack's own version |
| `app` | the app versions it is made for, a range: `>=0.2.0`, `>=0.2.0 <0.3.0`, `0.2.x`, `^0.2.0`, `~0.2.1`, `*`, alternatives with `||`. A pre-release (0.2.0-dev) counts as its release. Outside the range a language pack still loads — what it lacks falls back — and is flagged `compatible: false` (the server log, `tools/packs.mjs list`); a later type decides what an incompatible pack means for it |
| `name`, `englishName` | the name in its own language (a language pack: the language's own name, shown in the menu) and in English (the menu's tooltip) |
| `authors`, `credits`, `license` | who made it; free text (`license`: an SPDX id or text) |
| `files` | a folder pack: role → path inside the folder. Each type lists its roles and their extensions (`lang`: `ui` required, `data` optional, both `.json`) |
| the type's fields | `lang`: `lang`, `base`, `fallback`, `complete`, `machineTranslated`, `numberUnits` (docs/I18N.md) |
| `machineTranslated` | `lang`, optional: `true` when the pack's UI strings come from a machine (a translation, or a conversion such as the Traditional Chinese pack's). The index entry carries it (only when true, like `complete`) and the client shows a note under the language switch in 设置 while that language is in use (`public/js/ui/lang.js` `machineTranslationNote`). A value other than `true` / `false` is a warning and reads as false |

A **problem** keeps a pack from loading (unknown type, no `lang`, a file missing or outside the folder, broken JSON, an
id or a language already taken — the language folders' files come first, then the folders by id); a **warning** does
not (an id that differs, an app range this version is outside of, an unknown file role). Both are printed when the
server starts or notices a change, and by `node tools/packs.mjs list`.

## 3. Discovery and the index

The server's registry (`server/packs.js`) scans `public/i18n/`, `data/i18n/` and `packs/` when it starts and again
whenever something there changes: on a request for the index or a pack file it compares the names, sizes and times of
the files it reads (at most once a second, a few `stat` calls) and scans again if they differ. A pack dropped into a
folder shows on the next page load — no restart, no build step; a removed one leaves (a player whose stored language is
gone gets Chinese).

`GET /packs/index.json` (never cached) answers the packs of supported types:

```json
{ "version": 1, "app": "0.2.0", "packs": [
  { "id": "en", "type": "lang", "name": "English", "englishName": "English", "version": "0.2.0", "app": ">=0.2.0",
    "compatible": true, "authors": ["…"], "lang": "en", "fallback": [], "complete": true, "strings": 1017,
    "files": { "ui": "/i18n/en.json", "data": "/data/i18n/en.json" } } ] }
```

`files` holds URLs on this server, so a client never builds a path itself. A client reads the entries of its type
(`readPackIndex(json, 'lang')`: an entry of another type, with a bad id or a URL that is not a path on this server is
dropped).

**A static host** cannot list folders: `node tools/packs.mjs index` writes the same body to `packs/index.json`
(git-ignored), and `tools/package.mjs` writes it into the release zips. The live server answers `/packs/index.json`
itself and ignores that file. Serving the game from plain files needs the server's URL layout: `public/` at `/`,
`data/` at `/data/`, `shared/` at `/shared/`, `server/sim/` at `/sim/` and `packs/` at `/packs/` (the game itself still
needs the Node server for its rooms; DEPLOY.md).

**What is served.** `GET /packs/<id>/<file>` answers only a file that the manifest of a loaded folder pack names under a
role of its type, with that role's extension, inside the folder once links are resolved — `pack.json`, a readme, an
HTML or script file in the folder are never served; a pack of a planned type serves nothing. A single-file language
pack's files are the language folders' own (`/i18n/<code>.json`, `/data/i18n/<code>.json`).

## 4. The types

| Type | Status | Where it applies | Loader |
|---|---|---|---|
| `lang` | supported (0.2.0) | the client: UI strings, game texts | `public/js/ui/lang.js` (the menu, the strings: `shared/i18n.js`; the game texts: `public/js/data.js`) |
| `assets` | supported (0.2.5-dev) | the client: art, models, audio, fonts | `public/js/ui/assetPacks.js` (the map) + `public/js/data.js` `onManifest` (applied to the loaded `data/assets.json`) |
| `data` | supported (0.2.5-dev) | the server: data patches applied at start (the client is served the patched tables) | `server/dataPacks.js` (the merge) + `server/data.js` (the tables) + `server/http/static.js` (`/data/<name>.json`) |

A pack of a planned type is parsed and listed as not supported ("type "x" is planned …, not loaded by this
version"); it is never served and never changes anything.

### The `assets` type

An assets pack replaces or adds the resources the game draws and plays **without touching the code**. Every picture,
model and sound is resolved from URLs in `data/assets.json` — `assets.js` reads them for avatars, portraits, skill /
item / enemy icons and every Spine skeleton, atlas and texture; `audio.js` reads the manifest's own BGM and unit-SFX
entries. So the pack only hands the client a map from those URLs to its own files:

```
packs/hd-art/pack.json
packs/hd-art/map.json     { "/assets/char/avatar/char_x.png": "/packs/hd-art/img/x.png", … }
packs/hd-art/img/x.png
```

```json
{
  "type": "assets", "name": "高清立绘", "version": "1.0.0", "app": ">=0.2.0", "authors": ["…"],
  "files": { "map": "map.json", "media": ["img/x.png", "audio/lobby.mp3"] }
}
```

| Role | Meaning |
|---|---|
| `map` | required, one `.json`: resource URL of this server → a file of the pool, written as `/packs/<id>/<path>` |
| `media` | required, a list (one path is also accepted): every file the map may point at. Extensions: images, `.skel` / `.atlas`, audio, fonts, `.json` |

Rules the registry enforces, so a broken pack cannot half-apply:

- **A map value must be one of the pack's own `media` files.** A pack cannot point at the game's own art, at another
  pack, or at a file it did not declare (only named files are ever served: §3) — such a pack is skipped with the reason.
- **A map key must be a path on this server** (`/…`, never a scheme or `//host`).
- **Two packs may rewrite the same URL**: both load, the later id wins (the index is sorted by type then id), and
  `tools/packs.mjs check` and the server log report the conflict. `pack.overrides` in the index says how many URLs a
  pack rewrites.
- **Adding is the same as replacing**: a map entry for a URL nothing points at yet changes nothing until new data
  references it — content that a pack *adds* (a new operator, a new skin) therefore needs the `data` type as well.
- **Cache**: the client fetches each replacement with the pack's `version` in the query, so a new version is not served
  from a browser cache.
- A pack is data, never a program: `media` accepts art, models, audio and fonts, and an extension outside that list is
  refused.

The client half is small on purpose: `ui/assetPacks.js` reads `/packs/index.json`, fetches the maps, merges them (later
id wins) and rewrites the loaded manifest through the `data.js` transform hook. A pack dropped into `packs/` shows on
the next page load — the same as a language pack — and the game's own art is used when the index or a map cannot be read.

### The `data` type

A data pack patches the game's **data tables** (`data/*.json`): new operators, items, bonds, stages, a balance tweak, or
the data half of new art. It is a server-side type — the server merges the patches once at start and **serves the
patched tables** at `/data/<name>.json`, so a browser reads exactly what the server simulates with. That agreement is
the reason the type exists: the client must not be able to run different content than the server.

```
packs/my-pack/pack.json
packs/my-pack/patch.json   { "assets": { … }, "skins": { … } }   — one patch file may patch several tables
```

```json
{
  "type": "data", "name": "我的内容包", "version": "1.0.0", "app": ">=0.2.4", "authors": ["…"],
  "files": { "patch": ["patch.json"] }
}
```

| Rule | Why |
|---|---|
| A patch file is `{ "<data file>": <merge patch> }`, and `<data file>` must be one of the game's tables (`config`, `chess`, `bonds`, `garrisons`, `items`, `bands`, `effects`, `choices`, `enemies`, `factions`, `waves`, `stages`, `bosses`, `tokens`, `assets`, `backups`) | a typo in a table name is a pack that silently does nothing |
| Each value is a **JSON Merge Patch** (RFC 7386): objects merge recursively, scalars and arrays replace, `null` deletes a member | small patches that survive an upstream update, instead of a full table that freezes it |
| Each value must be an object: a patch may not replace a table with a scalar, and may not delete one | one broken pack must not take the game down |
| Two packs may patch the same table: their patches merge in pack order (the later id wins a member), and `tools/packs.mjs check` reports it | deterministic, and visible |
| `live: false` — a pack added or edited while the server runs takes effect at the **next start** | the simulation's data is fixed for the life of the process (every player of a room must run one rule set) |
| The file on disk is never written to: the merge happens on the loaded tables, which are deep-frozen, and only the patched tables are copied | an unpatched table is served byte for byte, and the install stays clean |

A patch for a table the game does not have is ignored with a warning; a patch that would not leave a table behind is
refused the same way. `server/dataPacks.js` exposes `mergePatch`, `collectDataPatches` and `applyDataPacks` (the tests
use them directly), and `dataPackTag(result, hash)` gives a short digest of the applied set — the content hash the
handshake will carry (see below).

Client-side data (the half a pack *adds* so new art has something to point at) is patched this way too: `assets.json`
carries the art manifest, so an art pack that adds an operator, a skin or an item ships a data pack for the manifest and
an assets pack for the files.



### The content tag (which packs a server runs)

A page has to be able to tell whether the content it loaded is still the content the server runs. `shared/contentTag.js`
turns a pack list into one short tag (`c0123456789ab`, two FNV-1a lanes) — an identity, not a security boundary — and
`server/packs.js` reports it:

| Where | What |
|---|---|
| `GET /healthz` → `mods: { tag, packs }` | the packs in force and the tag, always present (an empty pack list has its own tag) |
| the start log | `[packs] content c<…>: 2 pack(s) (assets:hd-art@1.0.0, data:balance)` |
| `GET /packs/index.json` → each entry's `size` | the bytes of the pack's own files: what lets a client reach the same tag |
| 设置 → 问题反馈 | `已加载内容包 N`, and `内容包与服务器不一致，请刷新页面` when this page is stale |
| the copied diagnostics | `content: tag c… \| page matches the server \| assets:hd-art@1.0.0, data:balance` |

The tag covers what both sides can compute from what they are told: the app version and, per pack, its **type, id,
version and size**. A pack edited without a version bump therefore moves the tag, and `public/js/ui/contentPacks.js`
(fed by the index) reaches the same value the server reports — a mismatch means a pack was added or changed after the
page loaded, and the player should reload.

Only the types that change **what the game is** count (`PACK_TYPES[type].identity`: `assets`, `data`). A language pack is
deliberately left out: it changes text a client opts into, so a stock server must not look modded and adding a
translation must not move the tag.

Not through the wire: the compact v1 position tables are frozen and a frame with extra values is rejected as malformed
(`docs/WIRE_PROTOCOL.md`), so `welcome` and a BattleSpec cannot simply grow a field. That is why the tag travels as
plain JSON (`/healthz`, the index) and why **per-room** mod state, when the create-room panel lands, will arrive as its
own JSON-fallback message type (the way `room.skins` and `m.chat` did), not as an extra `welcome` field.

### The owner's switches

A server owner decides which packs the server loads at all. The policy lives in the private settings file the CLI already
writes (`runtime/server-settings.json`), as `packs: { off: [], allow: [] }`:

| Key | Meaning |
|---|---|
| `off` | ids this server does not load at all: absent from the index, never served, not counted in the content tag |
| `allow` | ids that load although they are outside their declared `app` range |

- **Only a type that changes the game can be turned off** (`PACK_TYPES[type].identity`: `assets`, `data`). A language
  pack is part of the client's own UI and the other languages fall back to English, so turning one off is refused rather
  than silently accepted.
- **An incompatible pack that changes the game is held back** (`compatible: false`, outside its `app` range) until the
  owner confirms it (an `allow` entry) — the pack is scanned, listed and reported, but not loaded and not served.
  An incompatible **language** pack still loads and is flagged, as it always was: it only changes text, and what it lacks
  falls back.
- **When a switch takes effect**: a live type (`assets`) at once — the index, the content tag and the served files follow
  in the same tick. A type that is not live (`data`: the tables were fixed when the process started) at the **next
  start**: switching it while the server runs is recorded and reported (`restartRequired`), but the pack stays in force so
  that the index, the content tag and `/data/<name>.json` can never disagree about what the server is running.
- **Where**: `/admin` → 内容包 (the one setting this fork lets the panel write — see `server/admin.js`; the CLI and the
  panel share one file, one validator and one atomic writer) or the file/CLI directly. Every change is logged.



### Per-room selection (what a match runs)

The owner decides what the server *may* load ("The owner's switches" above); the **host** of a room decides what a given
**match** uses, out of those. `room.create` takes `mods` (a list of pack ids, omitted = everything the owner enabled) and
`room.setMods` changes it later; both accept only packs that change the game, and the room tells every client with

```
room.mods { code, mods, fixed, tag }
```

sent right after `room.state` (and after every change to it). `mods` is what this match runs, `fixed` is what it cannot
drop, and `tag` is the **room's own** content tag — the tag of its subset, not the server's — so a player can tell whether
the page they loaded still matches the match they are in.

| Rule | Why |
|---|---|
| A pack of a type that is **not live** (`data`: its tables were fixed when the process started) cannot be dropped, and the server answers `ERR.MODS` with the reason | a room cannot re-patch the tables the simulation runs on; the answer says so instead of silently ignoring it |
| An id the owner disabled (or that is not a pack) is refused the same way | a room can only narrow what the server runs, never widen it |
| Host only, in the room's lobby (not during a match) | the same rule as difficulty and capacity |
| Changing the selection un-readies the other humans | a different rule set is as significant as a different difficulty |
| The frame is a post-v1 JSON-fallback type, not a `room.state` field | the v1 position tables are frozen and a frame with an extra value is rejected (`docs/WIRE_PROTOCOL.md` §9) |

What a selection **does** depends on the type, which is why the frame says what is fixed: an `assets` pack changes how the
match looks (a client-side replacement the client applies for the room's set), while a `data` pack is part of the tables the
server already simulates with — exactly why it cannot be switched per room.

**Where a host picks it**: the create-room panel (screens/lobby.js) lists the identity packs the server runs — a live one
as a checkbox, a non-live one shown but locked — and sends `mods` only when the selection is narrower than everything
enabled, so a server without packs sends exactly the request it always did. The room screen shows what the match runs and
whether this page still knows that content (the room's `tag` against the tag of its `mods` as this page's index describes
them; an id the page has never seen makes the two disagree, which is the "reload this page" signal). Entering such a room
makes the page apply only the room's `assets` packs — and only when that actually changes a replacement, since it refetches
the art manifest (ui/assetPacks.js `applyRoomMods`); leaving restores every pack the server loaded.

### Code and gameplay mods (the owner's decision, 2026-10-12)

The study below kept third-party code out of packs. The owner has since decided that this project ships as an open
source fan remake whose players may write code mods, so:

- **Running code is in scope, but never through a pack manifest**: a pack's manifest still runs nothing and a pack's files
  are served to browsers, while a code mod lives in `mods/` and runs inside the server process with its privileges. Treat a
  downloaded mod as you would a downloaded executable: read it, or only run ones you trust (`mods/README.md` says that in
  the author's terms).
- **A mod is a server-level switch**, not a per-player one: the owner enables or disables it for the server, and a room
  host chooses **per room** whether that match uses a *pack* (see "Per-room selection" above). A player never installs
  gameplay content of their own — the server decides what a room runs, and every client is told.
- **An incompatible pack is not loaded silently**: a pack outside its `app` range that changes the game is held back until
  the owner confirms it, and the `/admin` panels name the reason for everything they do not load (see "The owner's
  switches").

#### The mechanism

```
mods/<id>/mod.json     { id, name, version, app, authors, entry: "main.mjs" }
mods/<id>/main.mjs     export async function setup(ctx) { … }   ctx = { id, version, log, data, packs, root }
```

| Rule | Why |
|---|---|
| `mods/` is never served and never in `/packs/index.json`; a manifest with a pack's `type` field is refused | a pack is data a browser may fetch; a mod is code that runs here |
| **Nothing runs until the owner lists the id** in `runtime/server-settings.json` (`mods.enabled`) or flips it in `/admin` → 代码 mod | dropping a folder in must never execute code by itself |
| Loaded once at start, in id order, after the content packs and the data tables, and awaited | a mod may register content and see exactly what the server will simulate with |
| A mod that cannot be imported, or whose `setup` rejects, is reported (`/admin`, the start log) and skipped | one broken mod must not keep the server from booting |
| Enabling or disabling one needs a **restart** (the panel says `restartRequired`) | a module is imported once and cannot be unloaded from a running process |
| `GET /healthz` reports them as `mods.code` — **apart from** the pack `tag` — and the 问题反馈 diagnostics name them as server-side and not verifiable here | a code mod never reaches a browser, so a client can be told about it but cannot check it; the pack tag stays the part a page can recompute for itself |
| `entry` must be a `.mjs`/`.js` path inside the mod's own folder, and it is the only file the loader reads | a manifest must not reach outside its folder for what it runs |

The loader is `server/mods.js` (`scanMods`, `loadMods`, `modsReport`); the panel is `/admin` → 代码 mod
(`docs/ADMIN.md` §5). A gameplay mod changes the game through the server's own extension points
(`server/sim/content/…`, the kits/traits/effects registries) — that is what "runs with the server's privileges" means, and
it is why the switch is the owner's.

### Adding a pack type

1. **The type** — its entry in `PACK_TYPES` (`shared/packs.js`): `status`, `summary`, `live` (whether a running server
   may take changes without a restart) and `files` (the roles a folder pack names, with the extensions that may be
   served for each). Its own manifest fields get a normalizer beside `langFields` and a branch in `normalizeManifest`;
   its index fields a branch in `packIndexEntry`.
2. **The loader** — reads the registry by type: `createPackRegistry(…).list('assets')` on the server, or the index
   entries of the type in the browser (`readPackIndex(json, 'assets')`), the way `ui/lang.js` reads `lang`. A
   server-side type (`data`) loads once at start (`live: false`): the simulation's code and data are fixed for the life
   of the process, and a battle must run the same data on the server and in every browser.
3. **The checks** — what `tools/packs.mjs check` and the tests verify for the type (a data pack: the same validation
   the data builder applies; a resource pack: the files exist and are of the allowed kinds), and its documentation
   here.

Things later types must keep (the maintainers' study of mods, 2026-10-07; the two marked ⚠ were changed by the owner's
decision of 2026-10-12, see "Code and gameplay mods" above):

- **Server-side only for gameplay.** A data pack is installed on the server, so every player of a room uses the same
  content and the server can still check or recompute a battle. A player never installs gameplay content of their own.
- **A content tag in the handshake** — *partly done*: the tag exists (`shared/contentTag.js`), `GET /healthz` and the
  start log report it, the index carries the `size` a client needs to compute it, and 设置 → 问题反馈 shows and copies it
  ("The content tag" above). Still to come: the per-room mod set over the wire (a JSON-fallback type) when the
  create-room panel lands, and a "modded" mark where a server's identity is shown to others.
- ⚠ **No third-party code** — *replaced*: code mods are allowed through `mods/` (never through a pack manifest), the
  server owner installs and enables each one, and they are reported apart from the content tag because a client cannot
  verify them ("Code and gameplay mods" above).
- **The golden results stay on the original content**; a pack never changes them.
- ⚠ **A pack's app range never blocks silently** — *sharpened*: a pack outside its declared range is flagged
  `compatible: false`, and an owner-confirmed `allow` entry is what loads one that changes the game (a language pack
  still loads, flagged). Nothing is dropped without a reason and a switch ("The owner's switches" above).

## 5. Tools

```
node tools/packs.mjs list [--json]          the packs by type, what was skipped and why, the warnings
node tools/packs.mjs index [--out <file>]   write packs/index.json (the static index)
node tools/packs.mjs check [--strict]       list; --strict exits 1 when a pack is skipped or warned about
node tools/i18n.mjs template <code>         a new language pack (docs/I18N.md)
node tools/i18n.mjs check <code> | --all    a language pack's strings: coverage, placeholders
```

`--root <dir>` points `tools/packs.mjs` at another checkout or an unpacked release.

## 6. Shipping

`tools/package.mjs` ships the committed packs (`public/i18n/`, `data/i18n/`, `packs/` — tracked files only: a pack
installed on this machine and not committed stays out) and writes `packs/index.json` into the stage from the packs
that ship. `test/package.test.js` checks both layouts and that a local pack stays out.

## Tests

`test/i18n-packs.test.js` (discovery of both layouts, broken / planned / duplicate packs, a pack dropped in or removed
while the server runs, the file allowlist, the manifest and app ranges, the `machineTranslated` mark from the manifest
to the 设置 note, the fallback chain, placeholders, plurals,
the per-text game-text fallback, the client loader and menu, the tools, build-i18n `--lang` / `--dict`),
`test/package.test.js`, `test/ui/i18n.e2e.test.js`
(`SP_E2E=1`: a pack file and a pack folder dropped in while the server runs show in the menu and switch; the shipped
packs with their UI strings and the 设置 note of a machine-translated one).
