# Now playing

The bottom row of the sidebar: cover art, title and artist of whatever plays on
this machine, over a small live spectrum. It reads the Windows media session, so
it works with any player that reports to it — Spotify, browsers, the packaged
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
`Media helper offline` instead of failing silently.

Then the panel recovers by itself: it retries, backing off to once every five
minutes, so it picks the dependencies up within a minute or two. Saving any file
in this folder or reopening the window makes it immediate.

## Turning it off

The music-note button in the sidebar footer toggles the row — middle of the three,
between the quota gauge and the settings gear. Off hides the block and gives its
96 px back to the lists; the setting is part of the layout, so it survives a
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

`main.js` is the panel. It never does the work itself: it starts `helper.py` once
as a hidden background process and then reads the files that process publishes in
`<appHome>/data/media/`.

```
helper -> state.json, levels.json, tick, cover-*.png
mod    -> beat
```

Each file has one writer, because Herdr's `writeTextFile` is a read-modify-write
that needs the content it expects to find. The mod's `beat` is a heartbeat: when
it goes 90 s stale the helper exits, which cleans up after a window that closed
without running `close()`. In the other direction the helper's `tick` going stale
is what makes the panel restart it.

`launch.ps1` starts the helper hidden, reuses one that is already running (a
window may have closed without stopping it), and reports `no-python` or
`no-deps` so the panel can say why it is not showing anything.

## Notes

- The spectrum shows what the machine actually plays, via WASAPI loopback on the
  default output device. It is not a per-player signal, so muted system audio
  reads as silence.
- Cover art is stored under a content-addressed name so a new track never shows a
  stale decoded image, and the previous cover is pruned.
- The bars refresh ~17 times a second while a track plays and not at all while it
  is paused. Raise `LEVELS_MS` in `main.js` to make that cheaper.
