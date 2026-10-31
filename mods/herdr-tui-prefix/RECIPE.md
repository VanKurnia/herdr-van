# Herdr TUI prefix

Ctrl+B, then a key: the Herdr TUI's default prefix, inside the Herdr app, over
the bindings worth typing. A hint stays open while you decide. This is a piece
you add to your current layout, not a window or a terminal multiplexer.

![Herdr TUI prefix](preview.png)

This file is the brief: enough to build Herdr TUI prefix from an empty folder.
The files next to it are one build of it. If they don't work on your Herdr, or
you want it different, build it again from here.

## What you see

Two states of one popup near the top of the window, 520px wide and offset 64px
from the top. Nothing is added to the layout.

The card Ctrl+B opens first: a heading, "Ctrl+B · waiting for a key", with
"Esc cancel · ^B send prefix" on the right, then nine 20px rows — key on the
left in a 66px column in the theme's accent, action on the right in the
foreground. The keys worth knowing by heart: new tab, next/previous tab, select
tab, split right/down, focus pane, zoom/close pane, toggle sidebar, minimize
window, all bindings. A footer reads "? all bindings". The popup is only as tall
as that card (about 265px).

The full list after `?`: the heading becomes "Ctrl+B · all bindings" with
"? short list · Esc cancel" on the right, and the card gives way to a 440px
scrolling list in three captioned sections — PANES, TABS, SESSION — captions
10px semibold in the dim color. Rows are the same 20px shape, with a short
reason on the right where one is needed. Rows with no Herdr-app command stay in
their herdr-tui place, dimmed: `r` resize mode, `[` copy mode, `tab` cycle pane,
`e` edit scrollback, `o` notification target. A footer reads "herdr-tui
defaults, herdr --default-config".

Both states use the popup background, 12px text, 14px padding and 8px gaps, and
the popup shrinks to whichever state is showing.

## How it behaves

Ctrl+B opens the card and waits without a timeout. The next key acts:

| Key | Action |
| --- | --- |
| `v` / `-` | Split right / down |
| `h j k l` | Focus left / down / up / right |
| `H J K L` | Swap the focused pane left / down / up / right |
| `z` | Toggle pane zoom |
| `x` | Close the focused pane and end its terminal |
| `c` | New tab |
| `n` / `p` | Next / previous tab |
| `1`–`9` | Select tab 1–9 |
| `b` | Toggle the sidebar |
| `g` | Go to an agent or terminal (the shipped `picker`) |
| `s` | Settings |
| `?` | Swap the card for the full list, and back; nothing else runs and the popup stays open |
| `q` | Minimize the window; there is no detach, panes keep running |
| Escape | Cancel |
| Ctrl+B | Send a literal Ctrl+B to the focused terminal |

**No shift+key rows.** Every `shift+` binding was left out on purpose: shift
right after a prefix is easy to mistype, and the app already has keys for those
actions — `f2` renames a tab, `ctrl-shift-w` closes it, `ctrl-shift-n` makes a
space, `shift-f2` renames a space, and the space menu and `+` menu cover new
space and new worktree. (`H J K L` are written as capitals and still need shift
physically; they are the only ones left that do.)

A dimmed row runs nothing: it closes the hint and posts a warning toast that
names the action and says what to do instead (for example "Resize mode: drag a
split's border.").

One key, then the hint closes: a bound key runs its action, an unbound one only
dismisses, and Escape cancels. `?` is the exception — it toggles the full list
and keeps the popup open. There is no repeat window, so a key you type right
after the action reaches the terminal immediately. Typing outside the hint is
untouched.

## Built from

- **One mod**, `mods/herdr-tui-prefix/`, `main.js` and `mod.json`. The manifest is
  `{"place": "none", "title": "Herdr TUI prefix", "overlay": {"kind": "popup", "at": "top", "offset": 64, "width": 520, "height": 560}}`,
  so no `layouts/` folder and no layout edit.
- **A `keys.json` snippet**, merged into the person's keys rather than replacing
  them:

  ```json
  {
    "global": { "ctrl-b": "mod.open:herdr-tui-prefix" },
    "terminal": { "ctrl-b": "mod.open:herdr-tui-prefix" },
    "mod:herdr-tui-prefix": { "ctrl-b": "herdr-tui-prefix.send-prefix" }
  }
  ```

  The terminal section is what makes Ctrl+B work while a terminal has focus; the
  mod section wins while the popup is open, delivering
  `herdr-tui-prefix.send-prefix` through `nextCommand()`.
- **Data:** `SECTIONS`, a list of `[caption, rows]` where each row is
  `[key, label, command, args, note]`. `command` is a command name, a function
  (for the picker popup), or `null` (no equivalent, `note` is the reason).
  `SHORT` is the card's nine `[keys, label]` pairs. An `INDEX` map built from
  `SECTIONS` once at load is what a pressed key is looked up in, so both states
  share one table and one renderer row.
- **A focusable view** on `gpui-kit` + `gpui-base`: `cx.focus_handle()` focused in
  `init`, `.track_focus(handle)`, `.on_key_down`, colors from `theme()`. It closes
  with `closeOverlay(props().overlay)`.
- **Commands:** `pane.split`, `pane.go`, `pane.swap`, `pane.zoom`, `pane.close`,
  `tab.new`, `tab.next`, `tab.prev`, `tab.select`, `layout.toggle`,
  `window.minimize`, `app.settings`.
- **Overlays:** `openOverlay({mod: "picker", kind: "popup", at: "top", offset: 40, width: 640, height: 0.8})`
  for `g`.
- **Literal keys:** `focused()?.terminal` plus `hc(["keys", terminal, "ctrl+b"])`,
  which reaches terminals on other machines too. This mod runs `hc` — that is the
  only program it starts.
- **Key matching:** the produced character (`e.key_char`) for `v - [ H J K L`,
  `e.key` for `tab`, digits as typed. Modifiers other than shift never match a
  prefix binding; shift is only read for `tab`. `?` toggles the two states
  before the table is consulted.

## Watch out

- Ctrl+B is taken from terminal programs, including tmux, as it is in herdr-tui.
  Ctrl+B Ctrl+B reaches them.
- The full list scrolls with the mouse or its scrollbar; there are no keys for
  scrolling it, because `j`/`k` are the pane bindings.
- `?` is the mod's own toggle, so Herdr's key list (`app.help`) is not on the
  prefix: bind it in `keys.json` if you want it there.
- `q` is not detach: it minimizes the window. Panes keep running either way.
- `r`, `[`, `tab`, `e` and `o` have no Herdr-app command (there is no pane
  resize, copy mode, pane cycling, scrollback editor or notification-target
  command). They are listed for muscle memory and explain themselves instead of
  acting.
- `g` opens the shipped `picker`, which covers tab, space and agent navigation.
- Nothing on the prefix renames or closes a space or tab any more: Herdr's own
  dialogs and keys do (`f2`, `ctrl-shift-w`, the space menu).
- The full list has a fixed 440px body and the card grows to its nine rows; the
  popup follows whichever state is showing. Special characters count as one key.
  Follow the installed `herdr.d.ts` and `gpui-kit.d.ts`, never modify shipped
  mods.
- `preview.png` predates the trim: it still shows the old card with a
  "Space picker / sidebar" row. Re-shoot it if the picture matters.

## Done when

- `herdr-app check mods/herdr-tui-prefix` passes with the matching Herdr binary
  and home.
- Ctrl+B opens the hint with a terminal focused, and a long pause does not close
  it.
- `v`, `-`, `x`, `z`, `c`, `1`–`9`, `b`, `s`, `g` and `q` do what their labels
  say.
- `?` swaps the card for the full list (PANES, TABS, SESSION) and back with the
  popup still open and the keyboard still on it; `v` after that still splits
  right.
- The card lists nine rows; the full list shows the dimmed rows with their
  reasons.
- The hint closes as soon as a key lands, and `h` immediately followed by Ctrl+C
  sends the interrupt to the shell (no repeat window holding the keyboard).
- `q` minimizes the window and the panes keep running; Ctrl+B Ctrl+B types a
  literal prefix into the shell.
- A dimmed row (`r`, `[`, `e`) closes the hint and posts a toast naming the
  action.
- Esc cancels without typing into the terminal, and typing outside the hint is
  unchanged.
