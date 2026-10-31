// Shared by every part of the herdr-van mod: the sidebar block, the rail test and
// the toggle. One copy, so the 160px threshold and the width to return to cannot
// drift between the tab bar, the lists and the brand.

import { layout, run, shared, setShared, window } from "herdr";

// This layout's first block, so no tree walk is needed.
export const sidebar = () => layout()?.children?.find((n) => n.id === "sidebar");

// The rail goes by width, not a flag: dragging the sidebar's edge narrows it too.
export const narrow = () => (sidebar()?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
export function toggleSidebar() {
  const rail = narrow();
  if (!rail) setShared("sidebar.width", sidebar()?.size?.px);
  setShared("sidebar.collapsed", !rail);
  run("layout.resize", { id: "sidebar", px: rail ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}
