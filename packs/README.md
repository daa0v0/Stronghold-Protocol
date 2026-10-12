# packs/ — content packs

Put a content pack here as its own folder: `packs/<id>/pack.json` (the manifest) next to the files it names. The
server lists every pack it finds at `/packs/index.json` and picks up a new or changed pack on the next page load — no
restart, no build step. `node tools/packs.mjs list` shows what was found, what was skipped and why; `check --strict`
exits non-zero on a problem.

Three types load in this version: **`lang`** (a language), **`assets`** (art, models, audio, fonts) and **`data`** (the
game's data tables). A real one ships with the repository — **`packs/stronghold-skins/`**, the 干员皮肤 content
([docs/SKINS.md](../docs/SKINS.md) §2) — so you can read a working pack instead of only a sketch.

## `lang` — a language

```json
{
  "type": "lang",
  "lang": "ja",
  "name": "日本語",
  "englishName": "Japanese",
  "version": "1.0.0",
  "app": ">=0.2.0",
  "authors": ["your name"],
  "fallback": ["en"],
  "files": { "ui": "ui.json", "data": "data.json" }
}
```

A language can also be one file, `public/i18n/<code>.json`, with the same fields in its `_meta` block — that is how
English ships. Writing one: [docs/I18N.md](../docs/I18N.md).

## `assets` — art, models, audio, fonts

An assets pack **replaces or adds** the resources the game draws and plays, without touching any code: it maps the
resource URLs of `data/assets.json` onto its own files. That covers operator avatars and portraits, skill / item / enemy
icons, every Spine skeleton, atlas and texture, the BGM tracks and the unit sounds — whatever the manifest points at.

```
packs/hd-art/pack.json
packs/hd-art/map.json          { "/assets/char/avatar/char_x.png": "/packs/hd-art/img/x.png" }
packs/hd-art/img/x.png
packs/hd-art/audio/lobby.mp3
```

```json
{
  "type": "assets",
  "name": "高清立绘",
  "version": "1.0.0",
  "app": ">=0.2.0",
  "authors": ["your name"],
  "files": { "map": "map.json", "media": ["img/x.png", "audio/lobby.mp3"] }
}
```

- `map` (required): **the resource URL on this server → a file of your pack**, written as `/packs/<your-id>/<path>`.
  Find the URLs in `data/assets.json` (they look like `/assets/char/avatar/char_x.png`); a URL nothing points at yet is
  allowed and simply does nothing until new data references it.
- `media` (required, a list): **every file the map may point at.** Only files you name here are ever served, and a map
  value that is not one of them is refused — that is what keeps a pack from reaching outside its own folder. Images,
  `.skel` / `.atlas`, audio and fonts are the allowed kinds; a pack is data, never a program.
- Two packs may rewrite the same URL: both load, the pack whose id sorts later wins, and the conflict is reported.

Reload the page after adding or changing a pack. The server log and `node tools/packs.mjs list` name a pack it skipped
and why. If everything is right and the art still does not change, check that the URL in your map is exactly the one in
`data/assets.json` (a trailing `_2` or `_1` art-phase suffix matters).

Details and the rules: [docs/PACKS.md](../docs/PACKS.md).

## `data` — the game's data tables

A data pack patches `data/*.json`: new operators, items, bonds, stages, a balance tweak, or the data half of new art. It
applies **at server start** (the simulation's data is fixed for the life of the process), and the server then **serves
the patched tables** at `/data/<name>.json`, so a browser reads exactly what the server simulates with.

The shipped example is the skins pack: its `patch.json` adds `chars[<charId>].skins` to `assets.json` and the catalogue to
`skins.json`, while the art itself stays in `public/assets/` — a pack carries **paths**, so content whose files are not in
git can still be a pack.

```
packs/my-content/pack.json
packs/my-content/patch.json
```

```json
// pack.json
{
  "type": "data",
  "name": "我的内容包",
  "version": "1.0.0",
  "app": ">=0.2.4",
  "authors": ["your name"],
  "files": { "patch": ["patch.json"] }
}
```

```json
// patch.json — one file may patch several tables
{
  "assets": { "chars": { "char_x": { "skins": { "char_x@my#1": { "name": "我的皮肤", "avatar": "/packs/my-art/img/a.png", "spine": { "front": { … } } } } } } },
  "config": { "someTuning": 12 }
}
```

- The keys must be the game's own table names: `config`, `chess`, `bonds`, `garrisons`, `items`, `bands`, `effects`,
  `choices`, `enemies`, `factions`, `waves`, `stages`, `bosses`, `tokens`, `assets`, `backups`.
- Each value is a **JSON Merge Patch** (RFC 7386): objects merge, scalars and arrays replace, `null` deletes a member.
  So a patch stays small and survives a game update, where a copy of the whole table would freeze it.
- A patch may not replace a table with a scalar, nor delete one: the pack is refused with the reason instead.
- Two packs patching the same table merge in pack order (the pack whose id sorts later wins a member); the conflict is
  reported by `node tools/packs.mjs check`.
- **Restart the server** after adding or changing a data pack (unlike a language or assets pack, which a page reload
  picks up). The start log names what was applied.
- Adding art goes together with this type: the art manifest is `data/assets.json`, so an art pack that adds an operator,
  a skin or an item ships a data pack for the manifest and an assets pack for the files (above).

Details: [docs/PACKS.md](../docs/PACKS.md) §4.

## Turning a pack off (the server owner)

A pack that changes the game (`assets`, `data`) can be switched off for the whole server, and a pack outside its `app`
range has to be confirmed once before it loads. Both are one click in the server's own console at `/admin` → 内容包
(that panel writes the same `runtime/server-settings.json` the CLI does), or a line in that file:

```json
{ "version": 1, "maxAiPerRoom": null, "requireAssetCache": false, "packs": { "off": ["hd-art"], "allow": ["old-pack"] } }
```

- `off` — not loaded, not served, not counted in the content tag.
- `allow` — load although it is outside its declared `app` range (only packs that change the game need this; a language
  pack outside its range still loads, flagged).
- A language pack cannot be turned off: it is part of the client's own UI, and the other languages fall back to English.
- An `assets` switch applies at once; a `data` switch (its tables are fixed when the server starts) applies at the next
  start, so the pack list, the content tag and `/data/*.json` never disagree.

Full semantics: [docs/PACKS.md](../docs/PACKS.md) §4 "The owner's switches". The console itself:
[docs/ADMIN.md](../docs/ADMIN.md) §5.
