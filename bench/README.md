# Bench

Performance measurement for the mods in this repo and the layouts that show
them. Three benches, one live sample, all read-only: nothing here changes a mod,
a layout, or the window's state.

```powershell
pwsh -File bench/bench.ps1                    # the three benches, writes bench/results/<stamp>.md
pwsh -File bench/live.ps1 -Seconds 60         # the running window's CPU, idle
pwsh -File bench/live.ps1 -Seconds 30 -Label "agent streaming"
```

Requires Node 22+ (for loader hooks) and, for `live.ps1`, a running Herdr.
`HERDR_HOME` overrides the mod home the benches load from; it defaults to
`~/.config/herdr-app`.

## The benches

| Bench | Measures | File |
|---|---|---|
| render | ms and elements for one render of each mod, at three workspace sizes | `benches/render.mjs` |
| timers | every timer a mod registers, its period, and whether it stops while hidden | `benches/timers.mjs` |
| layout | nodes, mod copies and hidden blocks per layout | `benches/layout.mjs` |
| live | the real window's CPU, memory and threads over N seconds | `live.ps1` |

The render bench loads each mod's **real code** from the mod home, with
`herdr`, `gpui-kit` and `gpui-base` resolved to stubs (`lib/stubs/`). The stubs
answer the app's API from a scene built by `lib/env.mjs`, count every element
constructed, and run a mod's own `cx.spawn` work so that a mod which fills its
state asynchronously renders the populated view rather than its empty state.

## What this does not measure

- **The Rust half of a render.** The app takes the element tree a mod returns
  and lays it out and paints it. None of that is timed here. Element count is
  reported because that half scales with it.
- **Redraws you cannot see.** A mod's render time says nothing about how often
  it is called. `timers.mjs` covers the schedules; nothing covers a `notify()`
  the app makes on its own.
- **Anything behind a real program.** `exec`, `hc`, `readTextFile` and
  `watchFolder` answer with synthetic data, so a mod that renders from git or
  from a terminal shows a plausible tree, not the real one.
- **Speed of the app's own work.** Terminal rendering, GPU compositing and the
  session loop are inside `live.ps1`'s number, not separable by it.

## Reading the numbers

Compare rows within one table from one run. Absolute milliseconds move several
percent between runs on the same machine, and the timer scan is static: it
resolves periods that are named constants in the same file, and finds a guard
within a few lines of the registration, so a guard inside a nested promise is
invisible to it. A wake-up that returns on its first line still counts as a
wake-up, which is why a mod can have a high per-minute figure and cost nothing.

Results live in `results/` and are committed as evidence. They are per-run: the
stamp in the file name is the run, not a version.
