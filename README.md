# herdr-van

A [Herdr app](https://herdr.dev) layout: Tokyo Night colors, a faded paper grid
behind the terminal and the sidebar. Your terminals sit straight on that
backdrop — no boxes, no bottom bar, no clutter.

![herdr-van](preview.png)

## What you get

- **Indigo everywhere.** Tokyo Night Night (`#1a1b26`, blue accent `#7aa2f7`),
  taken from `tokyonight.nvim`'s WezTerm palette.
- **A grid behind your text.** The terminal and the sidebar sit on one faded
  paper grid (`backgrounds/tokyo-grid.png`). The tab bar keeps a solid strip so
  its pills stay readable.
- **A sidebar that tells you what's happening.** Spaces with colored avatars and
  git branch / ahead-behind tails; agents with a spinner while they work, a red
  badge when they need you, a green dot when they're done.
- **A tab bar with nothing extra.** Pills, a `+` right after the last tab, one
  window-close button. No pill ✕, no Files/Changes buttons, no status bar.
- **The Pi logo.** Pi agents wear their real three-color logo instead of the
  plain glyph.
- **Ctrl+B, like the TUI.** A small mod brings the [Herdr TUI](https://herdr.dev/tui)'s
  prefix into the app: Ctrl+B, then a key. `?` lists everything it keeps.

## Add it

Open Herdr, start a coding agent, and paste this:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this layout: https://github.com/VanKurnia/herdr-van
```

That's the whole install. The agent reads this repo, copies the files into
`~/.config/herdr-app`, merges the three key bindings, runs `herdr-app check` on
each mod, and switches to `herdr-van`. (It's the same "tell your agent" line
herdr.dev puts on its own layout pages.)

**Rather do it yourself?** Copy `layouts/`, `mods/`, `themes/`,
`backgrounds/`, `custom-icons/` and `programs.json` into `~/.config/herdr-app`,
add the [three keys](#keys), then run `layout.switch` to `herdr-van`.

Use real copies, **not symlinks** — Herdr's asset loader doesn't follow them, so
the icons and the background silently go missing.

## Needs

- The Herdr app (built against 0.1.10).
- `JetBrainsMono NFM` installed, for the UI font. Without it you get JetBrains
  Mono and things look slightly different.
- Roughly a 1080p window. The backdrop is 2560×1440 and cover-fits.

## Keys

The layout itself adds none. `herdr-tui-prefix` needs these three, merged into
your `keys.json`:

```json
{
  "global": { "ctrl-b": "mod.open:herdr-tui-prefix" },
  "terminal": { "ctrl-b": "mod.open:herdr-tui-prefix" },
  "mod:herdr-tui-prefix": { "ctrl-b": "herdr-tui-prefix.send-prefix" }
}
```

Heads up: this takes Ctrl+B away from terminal programs, tmux included — same as
the TUI. Ctrl+B Ctrl+B still sends a literal prefix. Don't want that? Drop the
mod and those three lines; the layout works fine without it.

## Make it yours

The sidebar name is one string in `~/.config/herdr-app/herdr-van-config.json`:

```json
{ "brand": { "name": "Lucavien" } }
```

Empty (`""`) shows your username instead. Hovering the name always shows
"Herdr". Edits apply live.

## What it touches

Nothing leaves your machine. For honesty's sake, here's every program these mods
run:

- `git status` / `rev-parse` for each space, so it can show branch and
  ahead-behind. Runs on the space's machine if the space lives on another one.
- `whoami` (once, for the default brand name) and one `powershell` call to see
  whether the config file is a symlink.
- `hc` — `machine ls`, and `keys ctrl+b` only when you press Ctrl+B twice.

No network, no `fetch`, nothing written outside `~/.config/herdr-app`.

## Built from

`layouts/herdr-van.json` is a clone of the shipped `main` layout. `mods/herdr-van/`
is the window's chrome in one folder — tab bar, spaces list, agents list, brand
row, footer — each a part of the same mod, built from the shipped `spaces`,
`agents`, `tabs` and `workspace-chrome`. `RECIPE.md` is the full build brief if
you want to know exactly what changed and why.

## License

MIT. Issues and PRs welcome — see [RECIPE.md](RECIPE.md) if you'd like to carry
a change upstream in a form that's easy to review.
