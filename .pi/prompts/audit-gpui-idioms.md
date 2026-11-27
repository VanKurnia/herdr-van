---
description: Audit mods against gpui-kit.d.ts and rewrite what we hand-rolled in an API the kit already has
argument-hint: "<scope: mod folder, glob, or all>"
---

# Audit ${1:-all of our mods} against `gpui-kit.d.ts`

Read @gpui-kit.d.ts and @herdr.d.ts in full before touching code: they are the
truth and our memory of their API is not. Never edit them; shipped mods are
read-only, clone one first. The house rules these APIs serve are in @AGENTS.md
(UI, A mod, Rules, Animate natively, Check before you finish).

## Where the kit already wins

- px arithmetic, wrapper divs or manual separators → `h_flex` / `v_flex`,
  `.gap()`, `.p()`, `.flex_1()`, `.size_full()`, `.when()`, `.children()`
- animation through `cx.timer` + `cx.notify()` → `.frames()`,
  `.svg(x).spin()`, `.loop()`, `.transition()`
- a timer re-reading `spaces()`, `agents()`, `terminals()`, `focused()`,
  `theme()` or `shared()` → nothing; render already re-runs. Timers are for
  data, as often as it changes, gated on `window()?.visible`
- polling a folder we own → `watchFolder()` with `.cancel()`
- hand-walked scroll, or a long list drawn eagerly → `ScrollHandle`, `list`,
  `uniform_list`, `v_virtual_list`
- input plumbing behind `on_mouse_down` flags → `.on_click`, `.on_hover`,
  `.on_drop`, `.drag_paths`, `.on_window_mouse_move`, a focus handle with
  `on_key_down`
- dialog, popup, floating panel or toast built from divs → `openOverlay({kind})`,
  `closeOverlay`, `placement()`, `notify()`
- bespoke controls, Markdown by hand, an editor by hand → `gpui-base` controls,
  `TextView.markdown`, `EditorState` + `Editor`
- hex where a `theme()` name holds in both appearances → the name
- a stored `cx`, module-scope mutable state, work outliving `close(cx)` →
  the `cx` each callback gets, per-copy state, cleanup in `close`

## How to change it

Prefer deleting our version over wrapping it. Reuse the existing mods before
adding a mechanism, and put shared behavior in one place.

Where the kit has no answer, leave the code and say so: no invented API, no shim
hiding the gap.

Keep each change behavior-preserving. Ask before one that alters what a person
sees or how a pane behaves.

## Finish

```powershell
herdr-app check <each mod you touched>
herdr-app status
```

Report, per file: what changed, what you left alone and why, what `check` and
`status` printed, and what only the running window can confirm. A change without
a passing check is not finished.
