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
| `data` | planned | the server: data patches applied at start | — |

A pack of a planned type is parsed and listed as not supported ("type "data" is planned …, not loaded by this
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

### Code and gameplay mods (the owner's decision, 2026-10-12)

The study below kept third-party code out of packs. The owner has since decided that this project ships as an open
source fan remake whose players may write code mods, so:

- **Running code is in scope**, but not through the manifest: a code mod is a folder the *server owner* installs and
  enables, and it runs with the server's own privileges. Treat a downloaded mod as you would a downloaded executable:
  read it, or only run ones you trust. The release notes and the mod list in `/admin` name what is enabled.
- **A mod is a server-level switch**, not a per-player one: the owner enables or disables it for the server, and a room
  host chooses **per room** whether that match uses it (a panel on the create-room screen). A player never installs
  gameplay content of their own — the server decides what a room runs, and every client is told (the content hash below).
- **An incompatible pack is not loaded silently**: it is listed as `compatible: false`, and the owner confirms whether to
  load it (the mod list; until that lands, the server logs it and loads it like a language pack does).

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
- **A content hash in the handshake** before data packs ship (`welcome`, `/healthz`, the BattleSpec), so a client and
  a server can tell they run the same content, and a "modded" mark in the UI and in bug reports. With code mods in
  scope this is what keeps a room's players on one rule set: the hash has to cover the enabled mods, per room.
- ⚠ **No third-party code** — *replaced*: code mods are allowed, installed and enabled by the server owner (a pack
  manifest still never runs anything), and a room host chooses per room whether a match uses a mod.
- **The golden results stay on the original content**; a pack never changes them.
- ⚠ **A pack's app range never blocks silently** — *sharpened*: an incompatible pack is flagged `compatible: false` and
  the owner decides whether to load it, rather than the loader deciding for them.

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
