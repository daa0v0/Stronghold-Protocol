# packs/ — content packs

Put a content pack here as its own folder: `packs/<id>/pack.json` (the manifest) next to the files it names. The
server lists every pack it finds at `/packs/index.json` and picks up a new or changed pack on the next page load — no
restart, no build step. `node tools/packs.mjs list` shows what was found, what was skipped and why; `check --strict`
exits non-zero on a problem.

Two types load in this version: **`lang`** (a language) and **`assets`** (art, models, audio, fonts).

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

Details, the rules and the planned `data` type: [docs/PACKS.md](../docs/PACKS.md).
