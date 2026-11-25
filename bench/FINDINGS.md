# Where the cost is

An audit of the mods in this repo and the `herdr-van` layout, using the benches
in this folder. Measured 2026-11-25 on herdr-app 0.1.18 / herdr-core 0.1.22,
Windows, layout `herdr-van` (5 copies of `herdr-van` + `media`), 12 spaces and
18 agents in the live workspace.

## The finding

**The cost of the chrome is not in the code the mods run. It is in how often the
window redraws.**

Measured, in the same window, minutes apart, same code:

| Window | CPU, idle | What differs |
|---|---|---|
| layout `herdr-van` | **12.2 %** of one core | 6 mod copies, panes as cards, sidebar |
| layout `terminals` | **4.9 %** | one mod copy, no sidebar |
| `herdr-van`, tab bar hidden | **7.9 %** | wave still ticks, but draws nothing |
| `herdr-van`, tab bar shown | **13.6 %** | wave drawn 5× a second |

So the chrome costs about seven points of a core while nothing is happening, and
the tab bar's wave is the largest single item in it: hiding that one block takes
four to six of those points away.

Meanwhile the JavaScript that builds the trees is nearly free. One full redraw of
every live `herdr-van` copy at the workspace's real size costs, from the render
bench at the `typical` scale:

| Copy | ms | elements |
|---|---|---|
| `spaces` | 0.087 | 122 |
| `agents` | 0.171 | 267 |
| `tabs` | 0.006 | 10 |
| `brand` | 0.004 | 4 |
| `footer` | 0.004 | 9 |
| **all five** | **0.29** | **412** |

At the wave's five redraws a second that is 1.5 ms of script per second — about
**0.15 % of a core**, against the 7 % the same redraws cost the app. The rest is
the app laying out and painting 412 elements, again, five times a second, because
one mod's `notify()` redraws the whole window.

## What that implies

1. **Redraw less, not cheaper.** Shrinking a render from 0.17 to 0.10 ms is worth
   0.01 % of a core. Removing one of five redraws a second is worth ~1.4 points.
   Any effort spent on element counts is effort spent on the wrong 2 %.
2. **The wave's cadence is the one lever that matters.** Its clock runs at 200 ms
   to animate a slide, but the band itself only *advances* one slot every
   `BUCKET_MS` (3.3 s). Four of every five redraws exist purely to move the
   picture between slices. The bench cannot choose the fix — moving to a native
   `.loop`, redrawing only on promotion, or a slower tick are all plausible — but
   it sizes the prize at four to six points of a core, permanently, for a
   decoration in the tab bar.
3. **The virtual-size growth is not the problem it looks like.** At 40 spaces and
   80 agents the sidebar renders 346 and 1011 elements (0.22 and 0.51 ms). That
   is a real 4× growth and worth knowing, but at 12/18 it is 0.29 ms per redraw,
   which is noise next to the redraw count.

## Second-order observations

- **Our forks draw more than upstream's.** At the `typical` scale `spaces` builds
  122 elements where the shipped mod builds 83, and `agents` 267 where it builds
  206 — the fork's features (worktree nesting, machine groups, proc rows) cost
  elements, and elements cost the app, not the script. Render *time* is the same
  (0.087 vs 0.069, 0.171 vs 0.177): the trees are bigger, not slower to build.
- **`jump` is the most expensive single render** at scale: 850 elements and
  0.58 ms at 40 spaces, because it lists every space with its tabs. It is a popup,
  so it only costs while open — but that is exactly when the person is waiting
  for it, and the cost is in the layout it forces.
- **`herdr-filechanges` renders a 275-element tree in 0.16 ms** for a 24-file
  snapshot, growing to 835 at 80 files. Its 5 s poll is correctly gated on the
  window being visible, so that tree is only rebuilt while someone is looking.
- **`herdr-tui-prefix` draws nothing** (1 element, 0.000 ms) because it is a key
  handler with no card of its own. Its cost is per keypress, which no bench here
  measures — the right answer is that it costs nothing to show.

## Timer budget

Per minute, from the static scan (`bench/benches/timers.mjs`):

| Mod | timers | shown/min | still waking while hidden | doing work while hidden |
|---|---|---|---|---|
| `herdr-van` | 10 | 396 | 360 | 60 |
| `media` | 4 | 828 | 828 | 0 |
| `herdr-filechanges` | 1 | 12 | 0 | 0 |
| `herdr-tui-prefix` | 1 | 0 | 0 | 0 |

Read the last two columns together, not the third: `herdr-van`'s 360 includes the
tab bar's 200 ms tick, which returns on its first line once hidden, and 60 real
ones from the sidebar's 1 s tick, which captures space and pane shape on every
beat (deliberately: a space that closes is saved from that shape). `media`'s 828
is an 80 ms audio-level poll that returns before reading anything unless a track
is playing in a wide, visible block; the audio levels are the one place where a
high-frequency timer is the design, not an oversight.

The three timers that survive as work while hidden — `spaces` at 1 s, and
`media`'s park check at 1 s — are the reason the 043/044 guards were worth
writing: before them this column was several times larger.

## What was not measured

- The Rust layout and paint per element, directly. It is inferred from the
  four-point gap between the bench's numbers and the app's.
- Any redraw the app performs on its own behalf (terminal output, focus, cursor
  blink). The live CPU figure contains all of it; only the delta between two
  layouts or two block states isolates ours.
- Behaviour under load: 40 spaces and 80 agents are rendered in the bench, but
  never in the running window.
- `win98` and the shipped/neo layouts, beyond the copy counts in the layout
  bench. They are not loaded by the live layout.
