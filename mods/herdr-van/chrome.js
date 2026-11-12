import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, updates, exec, readTextFile, watchFolder, appHome, shared, setShared } from "herdr";
import { claimSidebarHover, findBlock, narrow, onSidebar, toggleSidebar } from "./lib.js";

// ── Brand config ─────────────────────────────────────────────
// The name lives in herdr-van-config.json at the Herdr home root
// ({"brand": {"name": "..."}}). Empty = this computer's username
// (else "Herdr"); any string pins it. Hovering the brand always
// reveals "Herdr". Edits apply live.

export default class Chrome {
  init(_props, cx) {
    // Nothing can be waiting for a prefix key at start: a crash mid-prefix
    // leaves the flag set, and the badge would stay lit forever.
    if (props()?.part === "footer") {
      if (shared("prefix.armed")) setShared("prefix.armed", false);
      return;
    }
    // The brand is the only part that shows the name, so `whoami`, the config watcher
    // and the symlink probe belong to that part alone.
    this.brandUser = null; // null = resolving (shows fallback), or unresolvable
    this.brandFixed = "";
    cx.spawn(async (cx) => {
      try {
        const r = await exec("whoami");
        const raw = (r.stdout || "").trim().split(/[\\/]/).pop();
        if (raw) this.brandUser = raw;
      } catch { /* keep fallback */ }
      cx.notify();
    });
    const home = appHome();
    const file = `${home}/herdr-van-config.json`;
    const load = async () => {
      try {
        const text = await readTextFile(file);
        const cfg = text ? JSON.parse(text) : null;
        this.brandFixed = typeof cfg?.brand?.name === "string" ? cfg.brand.name : "";
      } catch { this.brandFixed = ""; }
      cx.notify();
    };
    // The config may be a symlink into a repo: watch the real folder too,
    // so edits from either side reload. Both loops filter by filename.
    const watchLoop = async (dir) => {
      await load();
      try {
        for (;;) {
          const changed = await watchFolder(dir);
          if (changed.some((p) => p.endsWith("herdr-van-config.json"))) await load();
        }
      } catch { /* watcher ends with the copy */ }
    };
    cx.spawn(async (_cx) => { await watchLoop(home); });
    // A symlinked config points somewhere else, and an edit there changes that
    // folder, not this one. fs/promises can read files but cannot resolve a link
    // (no lstat/readlink), so only Windows — through powershell — can be asked,
    // and only when there is a config to ask about.
    cx.spawn(async (cx) => {
      const platform = window()?.platform;
      if (platform && platform !== "windows") return;
      try {
        try { await readTextFile(file); } catch { return; }
        const r = await exec("powershell", ["-NoProfile", "-Command", `(Get-Item ${JSON.stringify(file)}).Target`]);
        const target = (r.stdout || "").trim();
        if (target) {
          const dir = target.split(/[\\/]/).slice(0, -1).join("/");
          if (dir && dir !== home) await watchLoop(dir);
        }
      } catch { /* not a link, or no powershell: home loop covers it */ }
    });
  }
  brandName() {
    return this.brandFixed || this.brandUser || "Herdr";
  }
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.part === "footer") {
      // The prefix mod publishes its waiting state; the badge is that state and
      // nothing else, so an idle footer says nothing about the prefix.
      const armed = Boolean(shared("prefix.armed"));
      // The gear, the quota panel's toggle, and the prefix badge: an accent chip
      // reading `⌥ Prefix`, right end.
      // On the rail it would crowd the gear, so the agents list's strip carries the
      // glyph alone instead (agents.js) and this row stays one gear; the quota
      // toggle is left out there for the same reason.
      const quota = findBlock("quota-panel");
      const quotaOn = Boolean(quota) && !quota.hidden;
      const gauge = h_flex().id("quota-toggle").size(28).flex_none().flex().items_center().justify_center().rounded(8)
        .text_color(quotaOn ? t.accent : t.muted).cursor_pointer()
        .tooltip(quotaOn ? "Hide the Quota panel" : "Show the Quota panel")
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("layout.toggle", { id: "quota-panel" }))
        .child(svg("mods/quota/gauge.svg").size(14));
      const gear = h_flex().id("settings").size(28).flex_none().flex().items_center().justify_center().gap(4).rounded(8)
        .text_color(t.muted)
        .hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(() => run("app.settings")).child(svg(`mods/herdr-van/icons/settings.svg`).size(14))
        .when(Boolean(updates().app.ready), el => el.child(div().size(6).rounded_full().bg(t.accent)));
      const badge = div().px(7).h(18).gap(3).rounded(5)
        .flex_none().flex().items_center().justify_center()
        .text_size(10.5).font_semibold()
        .bg(t.accent).text_color(t.accent_foreground)
        .child(svg(`mods/herdr-van/icons/option.svg`).size(11).flex_none())
        .child("Prefix");
      return v_flex().id("sidebar-footer").size_full().border_t(1).border_color(t.border).px(8).justify_center()
        .on_hover(claimSidebarHover("footer"))
        .child(h_flex().w_full().items_center().gap(2)
          .when(!collapsed, el => el.child(gauge))
          .child(gear)
          .child(div().flex_1())
          .when(armed && !collapsed, el => el.child(badge)));
    }
    // The brand's buttons are drawn only while the pointer is on the sidebar.
    const side = onSidebar();
    const macos = window()?.platform === "macos";
    // The rail has room for one mark: the logo, which becomes the sidebar's toggle
    // while the pointer is on the sidebar. On macOS the traffic lights fill that row.
    const railLogo = collapsed && !macos && !side;
    return h_flex().id("sidebar-brand").size_full().pl(collapsed ? 0 : 14).pr(collapsed ? 0 : 10).gap(4).items_center().text_size(13.5)
      .on_hover(claimSidebarHover("brand"))
      .when(collapsed, el => el.justify_center())
      .when(macos && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center()
        .on_hover((h, cx) => { this.brandHover = h; cx.notify(); })
        .child(svg(`mods/herdr-van/icons/terminal.svg`).size(20).text_color(t.accent))
        .child(div().font_semibold().text_color(t.foreground).child(this.brandHover ? "Herdr" : this.brandName()))))
      .when(railLogo, el => el.child(svg(`mods/herdr-van/icons/terminal.svg`).size(20).text_color(t.accent)))
      .when(side && !collapsed, el => el.child(this.button("search", svg("mods/herdr-van/icons/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      // On the macOS rail the traffic lights fill the row, so the `b` key unfolds it there.
      .when(side && !(collapsed && macos), el => el.child(this.button("sidebar-toggle", svg("mods/herdr-van/icons/sidebar.svg").size(15), toggleSidebar)));
  }
}
