// Shared by every part of the herdr-van mod: the sidebar block, the rail test, the
// hover claim and the toggle. One copy, so the 160px threshold and the width to
// return to cannot drift between the tab bar, the lists and the brand.

import { layout, run, shared, setShared, spaces, window } from "herdr";

// This layout's first block, so no tree walk is needed.
export const sidebar = () => layout()?.children?.find((n) => n.id === "sidebar");

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
