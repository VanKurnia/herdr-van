// The tab bar: flat tabs, drag to reorder, and the + and window buttons, which are
// drawn only while the pointer is on the bar. No per-tab X (close with ctrl-shift-w
// or the right-click menu) and no Files/Changes toggles: this layout has no side
// panel for them to toggle.

import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, layout, settings } from "herdr";
import { sidebar } from "./lib.js";

export default class Tabs {
  init() {
    this.pressed = null;
    this.onBar = false; // the pointer is on the tab bar, so its buttons are drawn
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const ps = panes();
    // Square hover blocks, full bar height, like the tabs beside them.
    const button = (id, label, action) => div().id(id).w(26).h_full().flex_none().flex().items_center().justify_center().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
    const item = (c, i) => {
      const program = ps.find(p => p.tab === c.id && p.program?.agent)?.program ?? ps.find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      // Every tab keeps its 1px frame, accent only on the active one, so switching
      // tabs never moves a label.
      return h_flex().id(`tab-${c.id}`).h_full().px(10).gap(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.accent : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }))
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/herdr-van/icons/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])));
    };
    const w = window(), bar = sidebar(), lights = layout()?.traffic_lights;
    // macOS draws its traffic lights over the bar, so the tabs leave them room.
    // Elsewhere the first tab starts at the sidebar's edge: no gap to the left.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && lights
      ? Math.max(10, (lights[0] + 64) / settings().zoom - (bar?.hidden ? 0 : bar?.size?.px ?? 0))
      : 0;
    // Windows draws its own style of X; everywhere else the flat one.
    const closeIcon = w?.platform === "windows"
      ? svg("mods/herdr-van/icons/win-close.svg").size(16)
      : svg("mods/herdr-van/icons/close.svg").size(13);
    // No bottom border and no right padding: the active tab's frame meets the pane's
    // focus hairline, and the window button's square meets the window's edge; a line
    // between either pair reads as a gap. The buttons are drawn only while the pointer
    // is on the bar, so the strip is just tabs the rest of the time. The id is what
    // makes the bar hoverable at all: pointer state is tracked per element id.
    return h_flex().id("tab-bar").size_full().min_w(0).pl(lightsPadding).items_center().bg(t.chrome)
      .on_hover((on, cx) => { if (on !== this.onBar) { this.onBar = on; cx.notify(); } })
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().overflow_x_scrollbar().children(shown.map(item))
        .when(this.onBar, el => el.child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))))
      .when(this.onBar && Boolean(w?.buttons), el => el.child(button("close-window", closeIcon, () => run("window.close"))));
  }
}
