# Herdr TUI prefix

Ctrl+B, then a key: the Herdr TUI's default prefix, inside the Herdr app, over
the bindings worth typing. Nothing opens over your terminal — a `⌥ Prefix` badge
appears in the footer while the next key is expected, and `?` opens the guide.
This is a piece you add to your current layout, not a window or a terminal
multiplexer.

![Herdr TUI prefix](preview.png)

This file is the brief: enough to build Herdr TUI prefix from an empty folder.
The files next to it are one build of it. If they don't work on your Herdr, or
you want it different, build it again from here.

## What you see

Two things, and no modal.

**The badge**, and it exists only while the prefix waits. It appears at the
right end of the layout's footer row, on the line of the settings gear: an 18px
chip, 7px side padding, 3px gap, 10.5px semibold, rounded 5px, holding Lucide's
`option` glyph at 11px and the word **Prefix**. It is the theme's accent
(`#7aa2f7` on Tokyo Night) with `accent_foreground` text (`#1a1b26`), and it goes
when the key is taken, Escape is pressed or the wait runs out — an idle footer
says nothing about the prefix. On a collapsed sidebar (a rail under 160px) there
is no room for a chip: the gear turns accent instead.

**The guide**, on `?` only: a 520px card 64px from the top on the popup
background, 14px padding, 8px gaps, 12px text. Heading "Ctrl+B · all bindings"
with "Esc or ? close · ^B send prefix" on the right, then a 440px scrolling list
in three captioned sections — PANES, TABS, SESSION — captions 10px semibold in
the dim color. Rows are 20px: key on the left in a 66px column in the theme's
accent, action on the right in the foreground, a short reason on the right where
one is needed. Rows with no Herdr-app command keep their herdr-tui place,
dimmed: `r` resize mode, `[` copy mode, `tab` cycle pane, `e` edit scrollback,
`o` notification target. A footer reads "herdr-tui defaults, herdr
--default-config".

## How it behaves

Ctrl+B draws nothing and waits 4 seconds for one key. The badge is the whole
signal. The next key acts:

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
| `b` | Collapse the sidebar to its rail, or back to the width it had — the brand row's button, not Herdr's hide |
| `g` | Go to an agent or terminal (the shipped `picker`) |
| `s` | Settings |
| `?` | Open the guide; in the guide, `?` closes it again. Nothing runs |
| `q` | Minimize the window; there is no detach, panes keep running |
| Escape | Cancel |
| Ctrl+B | Send a literal Ctrl+B to the focused terminal |

**No shift+key rows.** Every `shift+` binding was left out on purpose: shift
right after a prefix is easy to mistype, and the app already has keys for those
actions — `f2` renames a tab, `ctrl-shift-w` closes it, `ctrl-shift-n` makes a
space, `shift-f2` renames a space, and the space menu and `+` menu cover new
space and new worktree. (`H J K L` are written as capitals and still need shift
physically; they are the only ones left that do.)

A dimmed row runs nothing: it disarms and posts a warning toast that names the
action and says what to do instead (for example "Resize mode: drag a split's
border.").

One key, then the prefix is over: a bound key runs its action, an unbound one
only disarms, Escape cancels, and four seconds of silence disarm it too. There
is no repeat window, so a key you type right after the action reaches the
terminal immediately, and a key typed after the wait reaches it as typed.
Nothing is typed into the terminal while waiting: the keys go to a 1×1 popup
that holds the keyboard and draws nothing.

## Built from

- **One mod**, `mods/herdr-tui-prefix/`, `main.js` and `mod.json`. The manifest is
  `{"place": "none", "title": "Herdr TUI prefix", "overlay": {"kind": "popup", "at": "top", "offset": 0, "width": 1, "height": 1, "frame": "none"}}`:
  `mod.open` reads it, so Ctrl+B opens a 1×1 popup that draws nothing and takes
  the keyboard. No `layouts/` folder and no layout edit.
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
- **One shared value**, `prefix.armed`: `true` when the popup opens, `false` on
  every way out — a key, Escape, the wait, or `close()` when the app closes the
  copy. That value is the contract with the badge.
- **The badge is the footer's job.** This mod never draws it; it publishes the
  state. In this repo `herdr-van`'s `footer` part renders, from
  `shared("prefix.armed") === true`,
  `div().px(7).h(18).rounded(5).gap(3).bg(t.accent).text_color(t.accent_foreground)`
  with `svg("…/option.svg").size(11)` and `"Prefix"` in it, and nothing at all
  when the value is false. Its `init` clears a stale armed flag, because a crash
  mid-prefix leaves the value behind in `shared.json`.
- **The guide** is the same mod in another copy: `guide()` closes the waiting one
  and calls
  `openOverlay({mod: "herdr-tui-prefix", kind: "popup", at: "top", offset: 64, width: 520, height: 560, props: {guide: true}})`;
  `props().guide` picks the table over the empty waiting view.
- **Data:** `SECTIONS`, a list of `[caption, rows]` where each row is
  `[key, label, command, args, note]`. `command` is a command name, a function
  (the picker popup, the sidebar toggle), or `null` (no equivalent, `note` is the
  reason). An `INDEX` map built from `SECTIONS` once at load is what a pressed key
  is looked up in, so the guide and the key matching share one table.
- **A focusable view** on `gpui-kit` + `gpui-base`: `cx.focus_handle()` focused in
  `init`, `.track_focus(handle)`, `.on_key_down`, colors from `theme()`. It closes
  with `closeOverlay(props().overlay)`, and the wait is `cx.timer.after(4000, …)`.
  The waiting view is a 1×1 element that still tracks the handle and listens: it
  draws nothing, but `track_focus` is what puts the keyboard on it.
- **Commands:** `pane.split`, `pane.go`, `pane.swap`, `pane.zoom`, `pane.close`,
  `tab.new`, `tab.next`, `tab.prev`, `tab.select`, `layout.resize`,
  `window.minimize`, `app.settings`.
- **`b` is a function row, not `layout.toggle`:** it reads the `sidebar` block's
  width, narrows to the rail (44px, 76px on macOS for the traffic lights) and
  returns to `shared("sidebar.width")`. The 160px rail test, the memory key and
  the rail widths are the chrome mods' convention; a mod cannot import another
  mod's files, so `herdr-van/lib.js` and the shipped `workspace-chrome` implement
  the same rule, and the key is what keeps all three toggles in agreement.
- **Overlays:** `openOverlay({mod: "picker", kind: "popup", at: "top", offset: 40, width: 640, height: 0.8})`
  for `g`.
- **Literal keys:** `focused()?.terminal` plus `hc(["keys", terminal, "ctrl+b"])`,
  which reaches terminals on other machines too. This mod runs `hc` — that is the
  only program it starts.
- **Key matching:** the produced character (`e.key_char`) for `v - [ H J K L`,
  `e.key` for `tab`, digits as typed. Modifiers other than shift never match a
  prefix binding; shift is only read for `tab`. `?` opens the guide (or closes
  it, in the guide copy) before the table is consulted.

## Watch out

- **The badge needs a footer.** Nothing appears on screen without a part that
  reads `shared("prefix.armed")`; the prefix still works, invisibly, and
  `herdr-app status` lists the open overlay. `herdr-van`'s footer is one build of
  it; any footer row can be.
- **The waiting view must track the focus handle.** It draws nothing, so an
  empty `div()` looks right and quietly breaks the prefix: the badge lights and
  no key ever arrives, because a key event travels the focus path and only the
  element with `.track_focus(handle)` is on it. Keep `.track_focus` and
  `.on_key_down` on whatever is rendered while waiting.
- **The waiting popup holds the keyboard** for those four seconds, so a key
  pressed without noticing goes to the prefix, not the shell. Shorten `WAIT` for
  a twitchier prefix; the badge follows it.
- Ctrl+B is taken from terminal programs, including tmux, as it is in herdr-tui.
  Ctrl+B Ctrl+B reaches them.
- The guide scrolls with the mouse or its scrollbar; there are no keys for
  scrolling it, because `j`/`k` are the pane bindings.
- `?` is the mod's own key, so Herdr's key list (`app.help`) is not on the
  prefix: bind it in `keys.json` if you want it there.
- `q` is not detach: it minimizes the window. Panes keep running either way.
- `b` collapses the sidebar, it does not hide it. Herdr's own `ctrl-shift-b` is
  `layout.toggle:sidebar` and still hides it; the prefix leaves that key as it is.
- `r`, `[`, `tab`, `e` and `o` have no Herdr-app command (there is no pane
  resize, copy mode, pane cycling, scrollback editor or notification-target
  command). They are listed for muscle memory and explain themselves instead of
  acting.
- `g` opens the shipped `picker`, which covers tab, space and agent navigation.
- Nothing on the prefix renames or closes a space or tab: Herdr's own dialogs and
  keys do (`f2`, `ctrl-shift-w`, the space menu).
- Machine names count as one key each, and the guide's body is a fixed 440px so
  the popup stays put while it scrolls. Follow the installed `herdr.d.ts` and
  `gpui-kit.d.ts`, never modify shipped mods.

## Done when

- `herdr-app check mods/herdr-tui-prefix` passes with the matching Herdr binary
  and home.
- Ctrl+B with a terminal focused shows the `⌥ Prefix` badge in the footer and
  draws nothing else: no card, no dimming, the terminal keeps its content. With
  no prefix waiting, the footer shows only the gear.
- The next key runs its action and the badge disappears at once — `v` splits
  right, `x` closes the pane, `1`–`9` switch tabs, `b` narrows the sidebar to its
  rail and a second `b` returns it to the width it had. If a key does nothing, the
  waiting view is not tracking its focus handle.
- No key pressed: the badge goes after four seconds, and the next keystroke
  reaches the shell as typed.
- Escape removes the badge without typing into the terminal.
- `?` opens the guide (PANES, TABS, SESSION) and `?` or Escape closes it; `v`
  inside the guide still splits right.
- Ctrl+B Ctrl+B types a literal prefix into the shell.
- A dimmed row (`r`, `[`, `e`) disarms and posts a toast naming the action.
- Removing the three key bindings removes the badge with them.
