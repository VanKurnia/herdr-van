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
  winrt-Windows.Foundation winrt-Windows.Storage soundcard numpy
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

Each file has one writer, because Herdr's `writeTextFile` is a read-modify-write
that needs the content it expects to find. The mod's `beat` is a heartbeat: when
it goes 90 s stale the helper exits, which cleans up after a window that closed
without running `close()`. In the other direction the helper's `tick` going stale
is what makes the panel restart it; that check runs on a 5 s timer of its own, so
the state read does not carry it.

### The clock and the transport

The title line ends with `elapsed / total`, and the artist line ends with
previous, play/pause and next. Both come from data the helper already publishes:
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
- Each bar takes the theme colour of the band it stands for, read off the same log
  scale as the bands (40 Hz–16 kHz): sub-bass below 60 Hz, bass to 250, vocal to
  2 kHz, treble above. `BAND_STOPS` in `ui.js` holds the four stops and their
  theme colour names.
- Cover art is stored under a content-addressed name so a new track never shows a
  stale decoded image, and the previous cover is pruned.
- The bars refresh about 8 times a second while a track plays, and not at all
  while it is paused or the sidebar is folded below 160 px (there the row is
  cover-only). GPUI eases each bar's height between those updates, so the motion
  is smoother than the data rate: `LEVELS_MS` in `main.js` is the mod's read
  interval and `LEVELS_EVERY_S` in `store.py` is the helper's publish interval,
  ~10 times a second.
