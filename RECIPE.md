# Tokyo Night for Herdr

A full-window Tokyo Night Night theme for the Herdr app: terminal, sidebar,
tab bar and panels all in `#1a1b26` indigo with `#7aa2f7` blue accents, over a
WezTerm-style paper-grid backdrop that shows through the terminal and the
sidebar alike.

![Tokyo Night for Herdr](preview.png)

## What you see

Left to right: a transparent sidebar (268px) over the grid backdrop — a
Lucide terminal glyph in Tokyo Night blue next to the word **Lucavien**
(flips to **Herdr** on hover), the spaces list with per-space color chips and
git branch tails, the agents/pinned lists with status dots (green working,
amber done), and a 40px footer holding a single settings gear. No Files or
Changes panel, no buttons for them in the tab bar, no bottom status bar.

Top to bottom on the right: a tab bar of rounded pills with no close X and a
`+` button tucked directly after the last tab (only a window-close X at the
far right); below it one borderless terminal card with square corners, zero
gap and zero outer padding, its text set in JetBrains Mono over the faint
paper grid, which dissolves into solid indigo toward the bottom edge.

## How it behaves

- Agent status colors: working green `#9ece6a`-ish glow, done/attention amber,
  blocked red `#f7768e`, idle dim gray — in list dots, tab pills and the
  terminal's own status UI.
- Hovering the sidebar brand swaps **Lucavien** back to **Herdr**; moving away
  restores it. Hovering any sidebar row or the settings gear shows the usual
  raised highlight, scoped to the control.
- `+` opens the standard new-tab menu (terminal or any installed agent).
  Tabs close with `ctrl-shift-w` or right-click (there is no pill X).
- The Files/Changes panel and the bottom status bar are gone from this layout;
  nothing polls for them and no copies of those mods start.
- The Pi agent wherever it appears wears the official three-color pi.dev logo
  instead of the shipped monochrome glyph.

## Built from

- Layout file `layouts/tokyo-night.json`: a clone of shipped `main`. Root
  look only: `"theme": "tokyo-night"`, `"font": "JetBrains Mono"`,
  `"font_size": 13`, `"ui_font": "JetBrainsMono NFM"`,
  `"terminal_opacity": 0`, `"terminal_padding": [5, 2]`,
  `"background": { "image": "backgrounds/tokyo-grid.png", "fit": "cover" }`.
  Pane frames: `gap 0`, `radius 0`, `background "#1a1b2600"` (fully
  transparent, so the terminal blends straight onto the image), 1px border,
  work-body `padding 0`. The `panel` (files/changes) and `status` nodes were
  deleted outright; the tab block points at `custom-tabs`.
- `themes/tokyo-night.json`: exact Tokyo Night Night palette from
  `tokyonight.nvim`'s `extras/wezterm/tokyonight_night.toml` (bg `#1a1b26`,
  fg `#c0caf5`, selection `#283457`), `ansi` = stock ansi + brights in order,
  plus a `colors` block mapping panel roles (chrome/surface `#16161e`,
  accent `#7aa2f7`, working `#e0af68`, blocked `#f7768e`, done `#9ece6a`).
- `mods/custom-tabs/`: shipped `tabs` minus the pill close X, with the `+`
  button moved inside the tab scroll row and the minimize/maximize window
  buttons removed (close kept). The Files/Changes toggle buttons render only
  when `shared("workspace.panels")` lists them — set it to `[]` (as below).
- `mods/custom-spaces/`, `mods/custom-agents/`, `mods/custom-chrome/`:
  shipped mods with only their root `.bg(t.chrome)` removed (hover, selected
  and border styling untouched); the sidebar node background is `#16161e00`.
- `mods/custom-chrome/` also carries the brand and footer rework: Lucide
  `terminal.svg` (from `lucide-static`) in accent blue instead of the Herdr
  PNG, `Lucavien`/`Herdr` hover swap via `on_hover`, footer reduced to one
  28px settings icon (no label, no Add machine row), footer block 40px.
  The brand name is a live JSON config: `herdr-van-config.json` at the
  Herdr home root (`{"brand": {"name": ""}}` = this computer's
  username, else `Herdr`; any string pins it). It is intentionally NOT
  symlinked into this repo — your copy is yours, the repo ships only the
  empty default as a template. Edits apply without restart
  via `watchFolder` loops on both the home and the resolved repo folder,
  so edits from either side reload — important because hot-reload misses
  file saves made through symlinked mod folders (a layout switch away and
  back restarts mods fresh).
- `backgrounds/tokyo-grid.png` (2560×1440, pre-composed): vertical gradient
  `#000000` → `#1a1b26`, the WezTerm `grid-tile.png` lattice tiled at 40px,
  and the top-third-transparent fade baked in — Herdr accepts a single
  background layer, so the three-layer WezTerm stack is flattened once, here.
- `custom-icons/pi.svg`: the official `pi.dev/logo-auto.svg` (800×800, same
  geometry as Herdr's icon convention), wired via `programs.json`
  (`pi` entry → `custom-icons/pi.svg`, `tint: false` for full-color render).
- Install: copy `layouts/`, `mods/`, `themes/`, `backgrounds/`,
  `custom-icons/` and `programs.json` into the Herdr home, then in Herdr run
  `layout.switch` to `tokyo-night`. Requires JetBrainsMono NFM installed for
  the UI font (falls back to JetBrains Mono without it). Set shared
  `workspace.panels` to `[]` to keep the Files/Changes buttons off.
- No programs are run and no network is touched by any included mod; the only
  build-time fetch was the palette TOML and the Lucide SVG, both vendored in.

## Watch out

- The backdrop is a snapshot, not live: if you restyle WezTerm's grid,
  re-compose `backgrounds/tokyo-grid.png` (the recipe is a `System.Drawing`
  script: gradient fill, tile with `TextureBrush` at 40px, four-stop
  transparent→canvas fade) and it hot-reloads.
- `terminal_opacity: 0` means terminal text sits directly on the image; on a
  bright grid variant, raise it toward 0.7–0.85 for contrast.
- The brand says whatever `herdr-van-config.json` holds (shipped empty →
  your username) — change one JSON string to rename it, no code edit.
- `programs.json` here contains only the `pi` icon override; merge (don't
  overwrite) if you already have one — entries apply field by field.
- Version skew: clones record `cloned_from` 0.1.9. On newer Herdr versions,
  re-clone the four mods and re-apply the one-line diffs if behavior drifts.
- Sizes assume a ~1080p+ window: the 2560×1440 PNG is `cover`-fit, so it
  holds up on HiDPI; the grid pitch stays 40px at any size by construction.

## Done when

- [ ] `layout.switch` to `tokyo-night` shows the indigo window with the grid
  visible inside the terminal and behind the sidebar, `>Lucavien` brand top-left
- [ ] `herdr-app status` exits 0 with no `*.error` lines (each mod also passes
  `herdr-app check <mod folder>`)
- [ ] Tab pills have no X, `+` follows the last tab, no Files/Changes buttons,
  no bottom status bar
- [ ] A running Pi agent shows the three-color logo in the sidebar and tab
- [ ] Hovering the brand reads Herdr; hovering the gear highlights only the icon
