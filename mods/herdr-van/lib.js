// Shared by every part of the herdr-van mod: the sidebar block, the rail test, the
// hover claim and the toggle. One copy, so the 160px threshold and the width to
// return to cannot drift between the tab bar, the lists and the brand.

import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, layout, props, run, shared, setShared, spaces, window } from "herdr";

// This layout's first block, so no tree walk is needed.
export const sidebar = () => layout()?.children?.find((n) => n.id === "sidebar");

// Any node by id, wherever the layout nests it: the quota panel sits in the row
// beside the panes, not at the root the way the sidebar does.
const walk = (node, id) => {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = walk(child, id);
    if (hit) return hit;
  }
  return null;
};
export const findBlock = (id) => walk(layout(), id);

// The rail goes by width, not a flag: dragging the sidebar's edge narrows it too.
export const narrow = () => (sidebar()?.size?.px ?? Infinity) < 160;

// True while the pointer is on any part of the sidebar. Its parts are separate
// copies of this mod, so the answer has to travel through shared state; each part
// claims it by name and clears only its own claim, so moving from one part to the
// next never reads as having left the sidebar.
export const onSidebar = () => shared("sidebar.hover") != null;

// A write re-renders every part, so only a real change is written.
export const claimSidebarHover = (part) => (on) => {
  const now = shared("sidebar.hover");
  const next = on ? part : now === part ? null : now;
  if (next !== now) setShared("sidebar.hover", next);
};

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
export function toggleSidebar() {
  const rail = narrow();
  if (!rail) setShared("sidebar.width", sidebar()?.size?.px);
  setShared("sidebar.collapsed", !rail);
  run("layout.resize", { id: "sidebar", px: rail ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// Space avatars: one strong color per hue, the same wherever a space is drawn.
// The name is kept in shared "space.colors" by space id, either a palette entry
// or a picked #rrggbb. A space seen without one takes the least used color, once,
// so every part agrees and adding or renaming a space moves nothing.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const PALETTE = Object.keys(MARK);

export function spaceColors() {
  const before = shared("space.colors") ?? {};
  const ids = new Set(spaces().map((s) => s.id));
  const kept = Object.fromEntries(Object.entries(before).filter(([id]) => ids.has(id)));
  let changed = Object.keys(kept).length !== Object.keys(before).length;
  for (const s of spaces()) {
    if (kept[s.id] || s.name === "~") continue;
    const uses = (c) => Object.values(kept).filter((v) => v === c).length;
    kept[s.id] = PALETTE.reduce((best, c) => (uses(c) < uses(best) ? c : best));
    changed = true;
  }
  if (changed) setShared("space.colors", kept);
  return kept;
}

// What a stored color name looks like on an avatar. Read the map with
// spaceColors() once per render rather than calling it per row.
export function spaceFill(t, s) {
  const color = (shared("space.colors") ?? {})[s.id] ?? PALETTE[0];
  return color.startsWith("#") ? color : (MARK[color] ?? t[color]);
}

// The 24px tile a space is drawn with: its colour and initial, or its icon —
// an icon stands alone, so the colour only marks the spaces that carry a letter.
export const avatar = (fill, name, ink, icon) => h_flex().size(24).flex_none().rounded(6).items_center().justify_center()
  .when(Boolean(icon), (el) => el.child(image(icon).w(22).h(22).flex_none()))
  .when(!icon, (el) => el.bg(fill).child(div().text_size(13).font_bold().text_color(ink).child([...name][0]?.toUpperCase() ?? "?")));

// Where a space is now: the folder of the pane it shows, else any pane in its
// tabs, else where it was made. `ps` is panes(), read once by the caller.
export function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// The program's icon from the app's table: a one-color glyph, or a picture.
export function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// A menu popup: a title, rows (each may carry `rule` for a divider above it and
// `checked` for a tick), ↑/↓ then Enter, Esc to close. The cursor and the focus
// handle belong to the caller, so its own state stays its own.
export function menuCard(t, { handle, title, rows, at, onMove, onPick }) {
  return v_flex()
    .w_full()
    .p(5)
    .bg(t.popover)
    .text_size(12.8)
    .track_focus(handle)
    .on_key_down((e, cx) => {
      if (e.key === "enter") return onPick(at);
      if (e.key === "escape") return closeOverlay(props().overlay);
      const next = e.key === "down" ? (at + 1) % rows.length : e.key === "up" ? (at + rows.length - 1) % rows.length : null;
      if (next === null) return;
      onMove(next);
      cx.notify();
    })
    .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(title))
    .children(rows.map((r, i) => v_flex()
      .when(r.rule, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
      .child(h_flex()
        .id(`mrow-${i}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .when(i === at, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click(() => onPick(i))
        .child(svg(`mods/herdr-van/icons/${r.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(r.label))
        .when(r.checked, (el) => el.child(svg("mods/herdr-van/icons/check.svg").size(14).flex_none().text_color(t.foreground))))));
}
