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

The levels fall in real time, not per block: `release()` in `levels.py` turns a monotonic clock's
delta into the fall (0.25 s time constant); a rise lands at once, so a kick is not smeared. A
per-block decay tied the fall to the device's block rate, so a track fell faster on a 48 kHz device
than on a 44.1 kHz one, and a dropped block doubled the step.

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
