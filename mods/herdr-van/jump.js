// Jump: the prefix's go-to popup. Every space and its tabs in document order,
// then the workspaces saved from closed spaces, in one list you filter by
// typing. A space row goes to the space's active tab, a tab row to that tab, a
// saved row restores that workspace.
//
// Read with props() so the layout router can hand it { part: "jump" }.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { closeOverlay, panes, props, run, spaces, theme } from "herdr";
import { avatar, spaceFill } from "./lib.js";
import { list, openWorkspace } from "./workspace.js";

const ROW_H = 28;
const LIST_MAX = 560;

export default class Jump extends View {
  init(_props, cx) {
    this.filter = "";
    this.at = null;
    this.rows = [];
    this.input = InputState.new({ placeholder: "Go to a space, a tab or a saved workspace…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      // The list narrowed under the selection: start again from the top.
      this.at = 0;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.go(this.selected(), cx));
    this.input.focus();
    // A popup lays out after its view is built, which can take the keyboard
    // back from the input; ask for it again once the list is on screen.
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  // A mod pane has no overlay to close.
  close() {
    if (props().overlay) closeOverlay(props().overlay);
  }

  // Every space and its tabs, then the workspaces no live space answers for.
  // The filter reads the names you gave things, never what a tab happens to
  // run: naming a space brings all of its tabs, naming a tab brings that row
  // alone, with its space in front.
  items() {
    const f = this.filter.trim().toLowerCase();
    const has = (text) => !f || text.toLowerCase().includes(f);
    const sp = spaces();
    const ps = panes();
    const rows = [];
    for (const s of sp) {
      const own = has(s.name);
      const tabs = s.tabs.map((tab) => ({
        kind: "tab",
        s,
        tab,
        who: [...new Set(ps.filter((p) => p.tab === tab.id).map((p) => p.mod ?? p.program?.name ?? "shell"))].join(" · "),
      }));
      const shown = own ? tabs : tabs.filter((r) => has(r.tab.name)).map((r) => ({ ...r, ctx: s.name }));
      if (!own && !shown.length) continue;
      if (own) rows.push({ kind: "space", s });
      rows.push(...shown);
    }
    const live = new Set(sp.map((s) => s.id));
    const saved = list().records.filter((r) => (!r.live || !live.has(r.live)) && has(r.name));
    if (saved.length) rows.push({ kind: "head" }, ...saved.map((rec) => ({ kind: "saved", rec })));
    return rows;
  }

  pickable() {
    return this.rows.filter((r) => r.kind !== "head");
  }

  selected() {
    return this.pickable()[this.at ?? 0];
  }

  key(e, cx) {
    if (e.key === "escape") {
      cx.stop_propagation();
      this.close();
      return;
    }
    const step = e.key === "down" ? 1 : e.key === "up" ? -1 : 0;
    const count = this.pickable().length;
    if (!step || !count) return;
    this.at = (((this.at ?? 0) + step) % count + count) % count;
    cx.stop_propagation();
    cx.notify();
  }

  go(row, cx) {
    if (!row) return;
    this.close();
    if (row.kind === "tab") run("tab.select", { id: row.tab.id });
    else if (row.kind === "space") {
      run("space.select", { id: row.s.id });
      const active = row.s.tabs.find((t) => t.active);
      if (active) run("tab.select", { id: active.id });
    } else if (row.kind === "saved") openWorkspace(row.rec, cx);
  }

  render() {
    const t = theme();
    const rows = (this.rows = this.items());
    const pickable = rows.filter((r) => r.kind !== "head");
    // Opens on the tab you are already in.
    if (this.at === null) this.at = Math.max(0, pickable.findIndex((r) => r.kind === "tab" && r.s.active && r.tab.active));
    this.at = Math.min(this.at, Math.max(0, pickable.length - 1));
    const sel = pickable[this.at];
    const height = Math.min(LIST_MAX, rows.length * ROW_H);

    const rowId = (r) =>
      r.kind === "head" ? "head" : `${r.kind}-${r.kind === "space" ? r.s.id : r.kind === "tab" ? r.tab.id : r.rec.id}`;
    // Only a row with a status gets a dot.
    const dot = (status) => div().w(12).flex_none().text_color(t[status] ?? t.dim).child(status ? "●" : "·");

    const row = (r) => {
      if (r.kind === "head") {
        return h_flex().h(ROW_H).flex_none().px(10).items_center()
          .text_size(10).font_semibold().text_color(t.dim).child("SAVED WORKSPACES");
      }
      const shell = h_flex().id(`jump-${rowId(r)}`).h(ROW_H).flex_none().px(10).gap(9).items_center().rounded(7).cursor_pointer()
        .when(r === sel, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.go(r, cx));
      if (r.kind === "space") {
        return shell
          .child(avatar(spaceFill(t, r.s), r.s.name, "#ffffff"))
          .child(div().flex_none().max_w(220).truncate().font_semibold().child(r.s.name))
          .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(r.s.folder ?? ""))
          .child(dot(r.s.status));
      }
      if (r.kind === "tab") {
        const here = r.s.active && r.tab.active;
        return shell
          .child(div().w(18).flex_none())
          .child(dot(r.tab.status))
          .when(!!r.ctx, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`${r.ctx} ·`)))
          .child(div().flex_none().max_w(200).truncate().text_color(here ? t.foreground : t.muted)
            .when(here, (d) => d.font_semibold()).child(r.tab.name))
          .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(r.who || "empty"));
      }
      return shell.opacity(0.55).hover((s) => s.opacity(1).bg(t.hover))
        .child(avatar(t.dim, r.rec.name, t.chrome))
        .child(div().flex_none().max_w(220).truncate().text_color(t.muted).child(r.rec.name))
        .child(div().flex_1().truncate().text_size(11).text_color(t.dim)
          .child(`${r.rec.tabs.length} tab${r.rec.tabs.length === 1 ? "" : "s"} · closed`))
        .child(div().text_size(11).text_color(t.accent).child("open"));
    };

    return v_flex().id("jump").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13).text_color(t.foreground)
      .rounded(14).overflow_hidden().border_1().border_color(t.border)
      .child(h_flex().items_center().gap(10)
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Jump to…"))
        .child(div().pr(10).text_size(11).text_color(t.dim).child("Esc")))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .when(rows.length > 0, (el) => el.child(
        div().id("jump-list").h(height).flex_none().min_h(0).overflow_y_scrollbar().children(rows.map((r) => row(r)))))
      .when(rows.length === 0, (el) => el.child(div().py(20).text_size(12).text_color(t.dim).child("Nothing matches")))
      .child(h_flex().gap(14).items_center().text_size(11).text_color(t.dim)
        .child(div().child("↑↓ move · Enter go · Esc close"))
        .child(div().text_color(t.muted).child(`${pickable.length} rows`)));
  }
}
