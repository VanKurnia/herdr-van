import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, exec, readTextFile, watchFolder, appHome } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// ── Brand config ─────────────────────────────────────────────
// The name lives in herdr-van-config.json at the Herdr home root
// ({"brand": {"name": "..."}}). Empty = this computer's username
// (else "Herdr"); any string pins it. Hovering the brand always
// reveals "Herdr". Edits apply live.

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class WorkspaceChrome extends View {
  init(_props, cx) {
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
    cx.spawn(async (cx) => {
      try {
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
    if (props()?.footer) {
      return v_flex().size_full().border_t(1).border_color(t.border).px(8).pt(4).pb(8)
        .child(h_flex().id("settings").size(28).flex_none().flex().items_center().justify_center().gap(4).rounded(8)
          .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
          .on_click(() => run("app.settings")).child(svg(`mods/custom-chrome/settings.svg`).size(14))
          .when(Boolean(updates().app.ready), el => el.child(div().size(6).rounded_full().bg(t.accent))));
    }
    return h_flex().size_full().pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center()
        .on_hover((h, cx) => { this.brandHover = h; cx.notify(); })
        .child(svg(`mods/custom-chrome/terminal.svg`).size(20).text_color(t.accent))
        .child(div().font_semibold().text_color(t.foreground).child(this.brandHover ? "Herdr" : this.brandName()))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/custom-chrome/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/custom-chrome/sidebar.svg").size(15), toggleSidebar)));
  }
}
