# Now playing

The bottom row of the sidebar: cover art, title and artist of whatever plays on
this machine, with the clock on the title line and previous / play-pause / next on
the artist line, over a small live spectrum. It reads the Windows media session,
so it works with any player that reports to it — Spotify, browsers, the packaged
music apps — and shows `Nothing playing` when none does.

## Setup

Two dependencies, installed **into this folder** (not system-wide). `vendor/` is
deliberately not committed: it is ~55 MB, of which ~52 MB is numpy and its
OpenBLAS DLL.

```powershell
python -m pip install --target "$env:USERPROFILE\.config\herdr-app\mods\media\vendor" `
  winrt-runtime winrt-Windows.Media.Control winrt-Windows.Storage.Streams `
  winrt-Windows.Foundation winrt-Windows.Storage soundcard numpy Pillow
```

Pillow re-encodes the artwork at the size the row draws it: the mod publishes
`data/media/art.json` (`{"px": 272}` from the sidebar's width, height and zoom) and the
helper keeps the bytes the player handed over, re-encoding only when that number changes.
Without Pillow the art is still served, just at its full size.
```

- `winrt-*` (1.6 MB) reads the media session and the cover art.
- `soundcard` + `numpy` (53 MB) capture the default output device's loopback for
  the spectrum.

Either group alone is fine. Without `winrt-*` the panel has nothing to show;
without `soundcard`/`numpy` the cover, title and artist still work and the
spectrum stays a flat line. Missing dependencies make the panel say
`Media helper offline`, with the cause on the second line: `python is not
installed`, `module deps missing` (hover the row for the pip line above), or
`helper could not start` for anything else.

Then the panel recovers by itself: it retries, backing off to once every five
minutes, so it picks the dependencies up within a minute or two. Saving any file
in this folder or reopening the window makes it immediate.

## Turning it off

The music-note button in the sidebar footer toggles the row — the left of the two,
beside the settings gear. Off hides the block and gives its
80 px back to the lists; the setting is part of the layout, so it survives a
restart.

Hiding a block does not stop its mod: Herdr keeps the copy, and its timers, alive.
So the mod parks the helper itself — it looks up its own block (the layout passes
its id in `props.block`) and, once that block is hidden, kills the process and
stops reading. Showing the row again starts a fresh helper within a second or two.

Stopping does not depend on remembering the pid: a reload forgets it, so a helper
the mod does not know is found by what it runs. And a helper stuck inside a media
call stops itself once the beat is stale, because the heartbeat is checked by its
own thread — a call that never returns cannot keep it alive.

## How it runs

`main.js` is the view: it never does the work itself. It starts `helper.py` once
as a hidden background process, then reads the files that process publishes in
`<appHome>/data/media/` — `state.json`, `levels.json`, `tick` and the covers.
`state.js` is that file protocol, `helper.js` is the process (start, reuse, stop),
and `ui.js` draws the row from the values it is handed.

On the Python side `helper.py` holds the media session, the audio loop and the
lifecycle; `levels.py` is the spectrum maths (stdlib only, so it can be tested on
a machine without the vendored packages); `store.py` is the file protocol — the
writer, and the constants `PROTOCOL_V`, `LEVELS_EVERY_S` and `BEAT_STALE_S`.

```
helper -> state.json ("v": 1), levels.json, tick, cover-*.png
mod    -> beat, cmd
```

`state.json` carries its protocol version as `"v"`, stamped after the record's
own fields so a record cannot override it. A payload without this mod's version
means the helper on disk is older than the running one: the row says
`helper outdated — restart it` rather than drawing a shape it does not know.
Renaming or removing a field means bumping `PROTOCOL_V` in both places —
`store.py`, which stamps it, and `main.js`, which reads it. Adding an optional
field does not.

`"audio"` is such an addition: the last failure of the audio thread, as text, or
`null` while it is healthy. The thread that reads WASAPI cannot write `state.json`
itself — a second writer would blank `title`, `artist` and `playing` every time it
fired — so it records its verdict on the `Writer` and `publish()` carries it in the
body it already writes. A start-up failure (the vendored modules, the FFT window) is
published too, because `pythonw` has no console for a traceback: without it a dead
audio thread leaves a row that is flat for no stated reason, which looks exactly
like a paused track. A successful block clears the note, so it cannot outlive the
condition that set it.

The audio loop drains the loopback recorder only while a track plays *and* somebody is drawing the
bars. Holding an open recorder costs nothing; calling `record()` on it costs ~6 % of a core, so a
paused helper sleeps in 50 ms slices and publishes silence — which the file protocol dedupes to no
writes — instead of draining audio nobody hears. The first block after a resume is dropped: a
paused loopback buffer still holds pre-pause audio.

"Somebody is drawing" is the beat's second field: the mod writes `<epoch> 0` once its row is too
narrow for the bars (below 160 px) or parked, and `<epoch> 1` when they are back, and the helper
answers `Writer.wanted()`. A folded sidebar used to cost the same ~11 % of a core as a visible one
for a spectrum nothing could show; with the flag it costs ~1.3 % (measured: 11.5 % expanded, 1.3 %
folded, 12.7 % after restoring). A beat with no second field, from an older mod, means yes.

The levels move in real time, not per block: `envelope()` in `levels.py` turns a monotonic clock's
delta into both the rise and the fall (45 ms attack, 0.25 s release). A rise is smoothed rather than
instant, so a transient is drawn as an attack instead of snapped to full height; the fall is the
slower half, so the bars still drop away rather than hanging. Both are clocked for the same reason: a
per-block decay tied the fall to the device's block rate, so a track fell faster on a 48 kHz device
than on a 44.1 kHz one, and a dropped block doubled the step.

**What a band is.** Each band is the summed energy of its FFT bins, not its loudest bin. A maximum
over a band is one bin's noise and depends on how many bins the band has, so the top of the spectrum
read taller than its content and a bar could flicker on a single bin; a sum is what the band holds
and does not flicker. The transform is zero-padded from the 2048-sample block to 4096, which halves
the bin to 10.8 Hz, so the low bands land on the frequencies they claim instead of wherever rounding
put them. One `numpy.add.reduceat` reduces all 28 bands at once.

**No band may be narrower than the transform can resolve** (`MIN_BAND_BINS = 4`, ~43 Hz here). A Hann
window's main lobe is four bins wide, so a 1/3-octave band at 60 Hz is not a measurement: a 60 Hz
tone spanned six bands and the scaling below drew every one of them at full height. The bottom bands
are now wider than pure log spacing would make them — coarser sub-bass bars, but honest ones.

**One gain for the whole spectrum, at `gain()`.** Per-band scaling was built, measured and thrown out:
by giving each band a scale of its own it made the mix into a wall of equal bars — spectral contrast
0.41 -> 0.11, and each band's movement over time 0.10 -> 0.06 — because a band normalised to its own
peak can no longer be louder than itself. What per-band scaling was meant to fix, the energy sum and
the width floor already fix. Flatness here is a *calibration* property, measured on pink noise; music
is supposed to be shaped. The single gain keeps a quiet master filling the row and leaves the bands'
ratios untouched (a test holds that), and it normalises with `HEADROOM` so the loudest band sits just
under the top instead of clipping flat every time a kick lands.

**The renderer draws the level, not a curve of it.** `sky.js` raised every column with `level ** 0.7`
and gave each column a floor of one dot, which is what made a correct spectrum still read as a row of
equal bars: the gamma pulled quiet columns up toward the middle, and the floor made sure nothing was
ever empty. The mapping is linear now, and a column with nothing in it is a gap. The row's height also
fixes the resolution — 268 px fits eight rows of dots, so the picture is quantised to eight steps,
which is a property of the row rather than of the maths.

Measured on one 8 s capture through both pipelines (`bench/visualizer/analyze.py`): pink noise, which
must draw flat, sloped 0.27 and now 0.24 at this floor; music keeps its shape (contrast 0.42) where
per-band scaling had flattened it to 0.11. One tone still lands in the band that holds its frequency,
and a 60 Hz tone leaks 0.09 three bands away instead of 0.72. The analysis costs 32.6 ms of CPU per
7.94 s of audio (0.41 % of a core, against 0.37 % for the old maths): the helper's 13-16 % is nearly
all capture, not arithmetic.

Each file has one writer, because Herdr's `writeTextFile` is a read-modify-write
that needs the content it expects to find. The mod's `beat` is a heartbeat: when
it goes 90 s stale the helper exits, which cleans up after a window that closed
without running `close()`. In the other direction the helper's `tick` going stale
is what makes the panel restart it; that check runs on a 5 s timer of its own, so
the state read does not carry it. `tick` is written by the helper's beat-watching
thread, not beside the media sample: a player call that never returns used to stop
the tick while the process stayed up, so the panel relaunched a helper that was
still running, forever, over a frozen track. `STALE_RETRIES` launches without the
tick coming back mean the process is up but wedged on a player call, which the
row says once as `helper not responding`; the panel then kills it, because a
wedged helper still holds the home's lock and a replacement cannot start until it
is gone. Launches keep going at the backoff's pace after that, because missing
dependencies can arrive after the panel did. A rename that loses a race with the
mod reading the same file is retried rather than raised: an exception there would
kill the thread that keeps the file fresh, and nothing would rewrite it. `state.json` and
new cover art wake the mod
through a folder watch (~150 ms), so a pause or a track change shows promptly.
`levels.json` stays on its 80 ms timer (`LEVELS_MS`) — the watch coalesces at
~155 ms, slower than the bars read. The watch compares basenames only, so `tick`, `beat`, `cmd`
and `helper.lock` arriving in the same batch never trigger a re-read.

### The clock and the transport

The title line ends with `elapsed / total`, and the artist line ends with
previous, play/pause and next. The buttons are faded out until the pointer is on
the row: they keep their place, so nothing shifts when they appear, and the fade
is the row's own `on_hover` with a 120 ms native transition. Both come from data
the helper already publishes:
`pos` and `dur` (seconds) are read from the session's timeline on every poll. No
duration means the player has no timeline, so the clock is left out rather than
shown frozen; a duration with no position shows the length alone. A position that
lags is counted from the moment its sample was read, and re-anchors on every new
body. A silent passage stops the bars, and with them the redraws that would
advance the clock, so it also ticks on a 1 s timer.

A click is written to `cmd` as `{"n": <epoch ms>, "do": "prev"|"toggle"|"next"}`
and the helper polls that file every 150 ms, applies the click to the current
session and republishes `state.json`. The timestamp is the click's identity: the
helper applies only a number above the one it last saw, and adopts whatever is in
the file when it starts, so a restart cannot replay the last click. Buttons are
drawn only for a live session on a current payload — an outdated helper would
ignore them.

`launch.ps1` starts the helper hidden, reuses one that is already running (a
window may have closed without stopping it), and answers `no-python` or
`no-deps`; anything else comes back as an error to quote. Those answers are what
the row turns into `python is not installed`, `module deps missing` (hover it for
the pip line) or `helper could not start`.

The reuse scan is scoped to the app home that is launching. One helper per app
home is enforced by `data/media/helper.lock`, opened with `O_TEMPORARY` and held
for the helper's whole life: a second helper for the same home prints
`already running` and exits, and the supervisor reports the pid the lock names.
The OS deletes the file when the handle closes — a crash included — so a lock
cannot be left behind and a competitor cannot take it in the gap between closing
and unlinking. A lock older than 15 s with no living owner is still taken over.

## What the drawing API allows

The row is drawn with Herdr's gpui-kit, and `gpui-kit.d.ts` in the app home is the
authority on what that surface offers: the app rewrites it on every start from the
bindings it carries. These are the places where the drawing runs into it.

- `bg()` takes a colour and nothing else (`gpui-kit.d.ts:1368`), so an element has
  no gradient background; every gradient in the row is a `window.paint_path(...)`
  element instead — the scrims over the cover, the skyline's columns.
- `paint_path` is the only native painting primitive (`gpui-kit.d.ts:20530`), so
  everything shaped or shaded is a path: the fades, the spectrum curve, the
  skyline.
- `.opacity()` on a `paint_path` element does not change the rendered pixels
  (measured, not declared; measured earlier and not re-verified since), so the
  alpha lives in the gradient's colours. Several `paint_path` chains in `sky.js`
  still call `.opacity()`, and whether those calls are dead is unproven.
- `Background.opacity(factor)` does render and multiplies both gradient stops
  (`gpui-kit.d.ts:20442`): measured, solid white reads 255.00 and white at
  `opacity(0.5)` reads 136.09 against a 16.95 backdrop, where the prediction is
  135.98. The scrims and the skyline's columns rely on it.
- `BackgroundStop` is an empty interface (`gpui-kit.d.ts:20440`) and stop
  percentages do not render: `linear_gradient` (`gpui-kit.d.ts:20448`) takes two
  colours and nothing between them, so a fade that wants a mid-stop is stacked
  gradients with the alpha in their colours.
- The background surface is `solid`, `linear_gradient`, `pattern_slash` and
  `checkerboard` (`gpui-kit.d.ts:20445-20451`) — no radial gradient, no mask, no
  object-fit, no `bg_image`. The corner scrims are stacked linear fades, and the
  cover's fit is arithmetic in `ui.js`.
- `line_height` takes a bare number as a multiplier and a string as a length
  (`gpui-kit.d.ts:1409-1410`); nothing in the row sets it.
- `PathBuilder` builds geometry with `move_to`, `add_polygon`, `curve_to` and
  `dash_array`, and closes with `fill()` or `stroke(w)` (`gpui-kit.d.ts:20425-20438`);
  a coordinate is a number of pixels or a percentage string
  (`gpui-kit.d.ts:22135`). `fullRect` and the skyline are built from these.
- `linear_gradient`'s angle runs `0` left→right and `180` top→bottom (measured,
  not declared); `90` and `270` are vertical too and paint nothing useful across a
  wide box. Every scrim uses `180`.
- Motion runs natively — `transition`, `spring`, `loop`, `frames`, `spin`
  (`gpui-kit.d.ts:1247-1266`) — never a timer per frame; the transport's fade is a
  native `transition`.

A feature found in upstream GPUI may not be reachable here: a mod sees a JavaScript
bridge over a pinned snapshot of it, and the declarations in `gpui-kit.d.ts` are
what that bridge exposes.

## Tests

The spectrum maths and the file protocol are plain Python, so they are tested
with the standard library — no dependencies, no Windows APIs:

```powershell
cd "$env:USERPROFILE\.config\herdr-app\mods\media"
python -m unittest discover -s tests -t .
```

`tests/` needs its `__init__.py`; without it `discover` fails with "Start
directory is not importable". These tests cover `levels.py` and `store.py` only:
the media session and the audio capture need Windows and are checked by running
the panel.

## Notes

- The spectrum shows what the machine actually plays, via WASAPI loopback on the
  default output device. It is not a per-player signal, so muted system audio
  reads as silence.
- The spectrum is one painted curve, not a row of bars: a Catmull-Rom line through the 28 levels,
  with the same curve closed along the baseline underneath and filled by a gradient of the band's
  colour. Colour is sampled per segment and eased across the seams between the four zones, so the
  hue runs violet→red→green→cyan instead of switching at a boundary (`FADE` in `ui.js` sets how many
  bands either side of a seam the two colours blend across). A segment carries its own stroke and
  its own fill: 54 painted pieces per render.
- The seam blend is in polar OKLCH (`blend()` in `ui.js`), not in channels. Blending channels
  passes through grey: red→green lands on tan (chroma 0.070) where interpolating the hue as an
  angle lands on amber (0.149), and green→cyan lands on a washed mint (0.076) instead of teal
  (0.122). Measured both ways; the polar blend costs ~31 µs per render, i.e. nothing.
- Painting one element per colour region instead was tried and rejected: 16 zone paths with
  horizontal gradients (plus 27 per-band washes) looked the same or worse — one tint per piece puts
  a colour edge at every piece boundary, and a single neutral overlay for the fade reads as frosted
  glass because it cannot match the backdrop the layout paints — and it measured no cheaper. In this
  build the cost tracks gradient brushes and draw calls, not element count: fewer, larger
  gradient-filled paths lost to more, smaller solid-coloured ones.
- The fill's box starts at the loudest band, so the gradient is at full strength at the curve and
  gone at the baseline. `Background.stop` percentages are not honoured in this build — they render
  flat — which is why this is a plain from→to gradient inside a box that begins at the peak.
- Each band keeps the theme colour of the frequency range it stands for, read off the same log
  scale as the bands (40 Hz–16 kHz): sub-bass below 60 Hz, bass to 250, vocal to 2 kHz, treble
  above. `BAND_STOPS` in `ui.js` holds the four stops and their theme colour names. A hairline sits
  under each band so a sample's place stays readable while the curve moves.
- Cover art is stored under a content-addressed name so a new track never shows a
  stale decoded image, and the previous cover is pruned.
- The curve refreshes about 8 times a second while a track plays, and not at all while it is
  paused or the sidebar is folded below 160 px (there the row is cover-only). Motion is
  data-driven: a painted path cannot be eased between values, so the update rate is the frame
  rate. `LEVELS_MS` in `main.js` is the mod's read interval and `LEVELS_EVERY_S` in `store.py` is
  the helper's publish interval, but the real ceiling is the capture block in `levels.py`
  (`BLOCK / RATE` = 2048/44100 = 46 ms, so 21.5 Hz); the 8.6 Hz you see is `LEVELS_EVERY_S = 0.08`
  dropping every second block. Identical bodies are not rewritten. Dots were laid out with a
  gamma (`value` in `ui.js`) so the levels music reaches spend the band's whole height.
