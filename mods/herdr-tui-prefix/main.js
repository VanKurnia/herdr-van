// Herdr TUI prefix: herdr-tui's default prefix (Ctrl+B) over a trimmed subset
// of its default bindings. The prefix shows no card of its own: the sidebar
// footer's badge turns accent while the next key is expected, and `?` opens the
// guide. Ctrl+B then a key, no repeat window holding the keyboard (herdr-tui has
// none either).
//
// Deliberately left out: every shift+key row (shift+t/x/n/w/d/g/p/r/tab). Shift
// after a prefix is easy to mistype, and the app's own keys cover those actions.
// A row with a null command is a herdr-tui action the app has no command for: it
// stays listed, dimmed with the reason, and pressing it says so instead of doing
// nothing.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, focused, hc, layout, nextCommand, notify, openOverlay, props, run, setShared, shared, theme, window } from "herdr";

// How long the prefix waits for its key. An armed prefix that never lets go
// swallows the next keystroke whenever it comes, so it times out and the badge
// goes quiet; a key after that reaches the terminal as typed.
const WAIT = 4000;

// The badge the footer shows is this mod's only state: true while a key is expected.
const ARM = "prefix.armed";

// Every picker row opens the same shipped popup.
const openPicker = () => openOverlay({ mod: "picker", kind: "popup", at: "top", offset: 40, width: 640, height: 0.8 });

// The sidebar button in the brand row, not Herdr's hide: narrow to the rail and
// back to the width it had. A mod cannot import another mod's files, so this
// repeats the chrome mods' rule — the 160px rail test and the `sidebar.width`
// memory, so either toggle undoes the other.
const toggleSidebar = () => {
  const bar = layout()?.children?.find((n) => n.id === "sidebar");
  const rail = (bar?.size?.px ?? Infinity) < 160;
  if (!rail) setShared("sidebar.width", bar?.size?.px);
  setShared("sidebar.collapsed", !rail);
  run("layout.resize", { id: "sidebar", px: rail ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
};

// [key, label, command, args, note]. `command` is an app command name, a
// function (actions that take more than a command), or null (no equivalent —
// `note` says what to do instead).
const SECTIONS = [
  ["Panes", [
    ["v", "Split right", "pane.split", { direction: "right" }],
    ["-", "Split down", "pane.split", { direction: "down" }],
    ["h", "Focus left", "pane.go", { direction: "left" }],
    ["j", "Focus down", "pane.go", { direction: "down" }],
    ["k", "Focus up", "pane.go", { direction: "up" }],
    ["l", "Focus right", "pane.go", { direction: "right" }],
    ["H", "Swap left", "pane.swap", { direction: "left" }],
    ["J", "Swap down", "pane.swap", { direction: "down" }],
    ["K", "Swap up", "pane.swap", { direction: "up" }],
    ["L", "Swap right", "pane.swap", { direction: "right" }],
    ["z", "Zoom pane", "pane.zoom"],
    ["x", "Close pane", "pane.close"],
    ["r", "Resize mode", null, {}, "drag a split's border"],
    ["[", "Copy mode", null, {}, "mouse-select, then ^⇧C"],
    ["tab", "Cycle pane", null, {}, "use h j k l"],
    ["e", "Edit scrollback", null, {}, "no scrollback editor"],
  ]],
  ["Tabs", [
    ["c", "New tab", "tab.new"],
    ["n", "Next tab", "tab.next"],
    ["p", "Previous tab", "tab.prev"],
    ...Array.from({ length: 9 }, (_, i) => [String(i + 1), `Tab ${i + 1}`, "tab.select", { index: i + 1 }]),
  ]],
  ["Session", [
    ["g", "Go to an agent or terminal", openPicker],
    ["b", "Toggle sidebar", toggleSidebar, null, "to the rail; ctrl-shift-b hides it"],
    ["s", "Settings", "app.settings"],
    ["q", "Minimize window", "window.minimize", {}, "no detach: panes keep running"],
    ["o", "Notification target", null, {}, "toasts go there when clicked"],
  ]],
];

const INDEX = new Map();
for (const [, rows] of SECTIONS) for (const row of rows) INDEX.set(row[0], row);

export default class HerdrTuiPrefix extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    // The guide has nothing to wait for.
    if (props()?.guide) return;
    setShared(ARM, true);
    cx.timer.after(WAIT, () => this.cancel());
    // The mod-specific binding beats the global/terminal opener while we wait.
    cx.spawn(async (cx) => {
      for (;;) {
        await nextCommand();
        this.sendPrefix(cx);
      }
    });
  }

  // Esc, a click beside it, a layout switch or the app quitting closes this copy
  // without going through cancel().
  close() {
    setShared(ARM, false);
  }

  // Clears the flag here as well: close() only runs on teardown, and the badge
  // should flip the moment the key is taken.
  cancel() {
    setShared(ARM, false);
    closeOverlay(props().overlay);
  }

  // A literal Ctrl+B to the focused terminal, through the core. Closing the
  // copy cancels this view's tasks, so the bytes go out before the dismiss.
  sendPrefix(cx) {
    const terminal = focused()?.terminal;
    if (!terminal) return this.cancel();
    const pending = hc(["keys", terminal, "ctrl+b"]);
    cx.spawn(async () => {
      const result = await pending;
      if (result.code !== 0) console.log(`herdr-tui-prefix: ${result.stderr}`);
    });
    this.cancel();
  }

  // The guide: the full table over its own popup, replacing the waiting copy —
  // that one is a 1×1 manifest, so it cannot grow into a card.
  guide() {
    this.cancel();
    openOverlay({ mod: "herdr-tui-prefix", kind: "popup", at: "top", offset: 64, width: 520, height: 560, props: { guide: true } });
  }

  key(e, cx) {
    cx.stop_propagation();
    const m = e.modifiers;
    if (m.control && e.key === "b") return this.sendPrefix(cx);
    const plain = !m.control && !m.alt && !m.platform;
    let key = e.key;
    if (plain) {
      // `tab` first: some hosts report a control character as its key_char.
      if (e.key === "tab") key = m.shift ? "shift+tab" : "tab";
      else if (e.key_char && e.key_char.codePointAt(0) >= 32) key = e.key_char;
      else if (m.shift && e.key.length === 1) key = e.key.toUpperCase();
    }
    if (plain && key === "?") return props()?.guide ? this.cancel() : this.guide();
    const row = plain ? INDEX.get(key) : null;
    if (!row) return this.cancel();
    const [shown, label, command, args = {}, note] = row;
    this.cancel();
    if (command === null) {
      notify({ title: `Herdr TUI prefix · ${shown}`, body: `${label}: ${note}.`, level: "warning", timeout: 5000 });
      return;
    }
    if (typeof command === "function") command();
    else run(command, args);
  }

  render() {
    // Waiting draws nothing, but it is where the keyboard goes: a key event
    // travels the focus path, so only the element that tracks the handle sees
    // keys. Drop `track_focus` here and the prefix arm goes deaf.
    if (!props()?.guide) return div().id("prefix-wait").w(1).h(1).track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx));
    const t = theme();
    const row = (key, label, active = true) => h_flex().h(20).flex_none().items_center().gap(10)
      .child(div().w(66).flex_none().text_size(11.5).text_color(active ? t.accent : t.dim).child(key))
      .child(div().flex_1().truncate().text_color(active ? t.foreground : t.dim).child(label));
    return v_flex().id("herdr-tui-prefix").track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .w(492).p(14).gap(8).bg(t.popover).text_color(t.foreground).text_size(12)
      .child(h_flex().flex_none().justify_between()
        .child(div().font_semibold().child("Ctrl+B · all bindings"))
        .child(div().text_color(t.muted).child("Esc or ? close · ^B send prefix")))
      .child(v_flex().h(440).min_h(0).overflow_y_scrollbar().children(
        SECTIONS.flatMap(([section, list]) => [
          h_flex().h(24).flex_none().items_center()
            .child(div().text_size(10).font_semibold().text_color(t.dim).child(section.toUpperCase())),
          ...list.map(([key, label, command, , note]) => row(key, label, command !== null)
            .child(div().flex_none().text_size(11).text_color(t.dim).child(note ?? ""))),
        ])))
      .child(div().flex_none().text_color(t.muted).child("herdr-tui defaults, herdr --default-config"));
  }
}
