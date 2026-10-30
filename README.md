# herdr-van

The `herdr-van` layout for the [Herdr app](https://herdr.dev): Tokyo Night
over a WezTerm-style paper-grid backdrop, transparent sidebar and terminal,
custom tab bar, Pi logo program icon. The layout names the `tokyo-night`
theme, which ships in `themes/`, so the two names differ on purpose:
`herdr-van` is the layout, `tokyo-night` is its theme.

![herdr-van](preview.png)

## Install

Copy `layouts/`, `mods/`, `themes/`, `backgrounds/`, `custom-icons/` and
`programs.json` into your Herdr home (`~/.config/herdr-app`), then switch to
the `herdr-van` layout. Needs `JetBrainsMono NFM` for the UI font. See
[RECIPE.md](RECIPE.md) for the full build brief.

## Herdr TUI prefix

The `herdr-tui-prefix` mod brings the [Herdr TUI](https://herdr.dev/tui)'s own
default prefix and bindings into the app: `ctrl+b`, then a key. It needs three
`keys.json` entries:

```json
{
  "global": { "ctrl-b": "mod.open:herdr-tui-prefix" },
  "terminal": { "ctrl-b": "mod.open:herdr-tui-prefix" },
  "mod:herdr-tui-prefix": { "ctrl-b": "herdr-tui-prefix.send-prefix" }
}
```

Ctrl+B shows a nine-row card; `?` swaps it for the full table of herdr-tui's
defaults and back. See [mods/herdr-tui-prefix/RECIPE.md](mods/herdr-tui-prefix/RECIPE.md).

## Editing this layout

The Herdr home is the source of truth: edit the files there, then commit here.
`tools/sync-from-live.ps1` copies them in (`pwsh -File tools/sync-from-live.ps1`),
and an optional `.git/hooks/pre-commit` hook runs it automatically so a commit
always captures what you just changed.

Use real copies, not symlinks: Herdr's asset loader does not follow symlinked
paths — linked mod folders still run their JavaScript, but their SVGs and the
background image silently fail to load.
