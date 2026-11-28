# herdr-media-pywal

The window follows the artwork. Whatever the media mod is playing, its cover becomes the window's
colours: a wallpaper for the background and a theme for everything drawn on top.

![pywal](preview.png)

## What it does

- Watches `data/media/state.json` — the media mod's own contract, cover included. A track change is
  answered at once (folder watch) with a 5 s poll behind it, because a watch can be reclaimed and the
  colours must not stay stuck on the last song. A watch batch carrying only the helper's per-frame
  files (`beat`, `tick`, `levels.json`) is dropped, and both paths pause while `window()?.visible` is
  false. The watch is cancelled in `close()`.
- Runs `pywal.py` on the cover: clusters the art in OKLab, takes each role's **hue** from it, and
  writes `themes/pywal.json` plus `backgrounds/pywal-<hash>.png`.
- Applies both: the theme through `app.theme`, the wallpaper as the one `backgrounds/…` field of the
  shown layout (a text edit of that field, so sizes, colours and mods in that file are untouched).
- Renders nothing. Its floating slot stays out of the way.

Generation takes about **1.2 s** (a 96×96 thumbnail for the palette, a cached fit of the base
wallpaper, and the wallpaper's colour applied to its ~4 000 ramp stops rather than its 3.7 M pixels).

## What it will not do

- **Fight you.** A theme you pick by hand stays picked until the next cover arrives.
- **Change a window it never changed.** If it has not applied anything, it has nothing to revert.
- **Act on a picture it cannot read.** A failed generation leaves the current colours alone.
- **Touch the base.** `themes/tokyo-night.json` and `backgrounds/tokyo-grid.png` are only ever read.

## Coming back

The theme and wallpaper are restored — as paths, not regenerated colours — when:

- **nothing is playing**: no `state.json`, a stopped session, or no cover in it;
- **the media mod is off**: its block is hidden or gone from the shown layout;
- **you turn this mod off**: the palette entry `Colours follow the artwork: on or off` (the flag is
  sticky in `localStorage`, so it survives a restart).

Restored means `tokyo-night` and `backgrounds/tokyo-grid.png`.

## How a theme is chosen from a cover

The palette is sampled, the proportions are not. A cover's pixels are mostly mid-tones, and a theme
made straight from them is unreadable, so what comes from the art is each role's **hue** and which
cluster becomes the accent; lightness and chroma come from `tokyo-night`, then each role is lifted
until it clears the contrast `tokyo-night` already reaches. An adaptive theme can therefore never be
harder to read than the one it replaces.

Statuses keep their meaning rather than following whatever the picture does — `blocked` red,
`working` amber, `done` green — taken from the art when its palette has those hues, nudged apart
(≥ 28°) when it does not, and borrowed when the art has none (a cover with no green still needs a
green). Two roles landing on one hue is the failure mode this guards against: it paints two statuses
the same colour.

## Files

```
main.js      the watcher, the apply and the revert; draws nothing
pywal.py     cover -> themes/pywal.json + backgrounds/pywal-<hash>.png; prints one JSON line
mod.json     place none, plus the two palette entries
```

`main.js` uses only what `herdr.d.ts` exports: `readTextFile` (null for an absent file, rejection for
an unreadable one — the two are handled differently), `writeTextFile(path, text, expected)`, `exec`,
`run`, `notify`, `shared("layout")`, `watchFolder` with `.cancel()`, `cx.sleep`, and the bare
`localStorage` global. It renders `""` because the kit has no empty-element API and a floating block
sizes to its content.

`pywal.py` needs numpy and Pillow from `mods/media/vendor` (the media mod's own vendor folder); it
puts that on `sys.path` itself, so it runs under a plain `python`.

## Watch out

- **A new mod folder docks itself into the shown layout.** Creating `mods/<name>/` (even with
  `"place": "none"` in its `mod.json`) makes the app add a block for it to the layout you are looking
  at — a 320 px column, in this layout's case, which reads as "empty space on the right" until the
  folder is deleted and the block removed. Make throwaway probes as *files* inside an existing folder,
  not as new mod folders.
- **`fs.appendFile` does not exist** in the sandbox's `fs/promises`; it is `undefined`, so an append
  inside a `catch {}` fails silently. `writeFile` works. The log here keeps its lines in memory and
  rewrites the file.
- **`cx.timer.every` dies with its callback.** One throw inside a timer callback and that timer never
  fires again — the mod then looks alive (no error, `check` passes) while doing nothing. The polling
  here is a `cx.spawn` loop with every pass caught, so one bad generation cannot stop the colours.
- **`window` is shadowed by a global.** The shell installs `window` (the gpui `Window` object, for
  `window.localStorage`), and the global wins over `import { window } from "herdr"`: the call throws
  `not a function`. Import it aliased — `window as appWindow`. `gpui-kit`'s `Window` has no `visible`,
  only `is_window_active()` (focus), so herdr's function is the only presentation signal there is —
  and this mod no longer asks, because a window nobody can see is no reason to stop following music.
- The wallpaper is written under a **new name** every time and the older ones are deleted: the app's
  image cache is keyed by path, so reusing a name would serve a stale picture. Never run `pywal.py` by
  hand while the mod is live: it prunes the wallpaper the layout currently points at.
- The tone match is what makes the pair coherent: this layout draws terminals and sidebar transparent
  (`terminal_opacity: 0`), so the wallpaper *is* the window's background. Its flat band is moved to
  the theme's background lightness (measured: `#161c28` on both).
- Mounting is one floating entry in the layout root. Remove that entry to unmount the mod; the
  colours then stay as they were last applied.
