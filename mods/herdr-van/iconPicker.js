// A space's icon: one image from custom-icons/ (an `.svg`, or a `.png` for a
// logo that only exists as a picture), kept on the space's workspace record so a
// reopened workspace wears it again. The row that opens this hands it everything
// it shows, so the picker reads no live state of its own.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, closeOverlay, exec, notify, props, theme, window } from "herdr";
import { avatar } from "./lib.js";
import { setIcon } from "./workspace.js";

const ROW_H = 34;
const LIST_MAX = 340;

// A dialog is not sized by its content, so the rows decide its height before it
// opens: one row apiece — `Default` is one too — capped where the list starts
// scrolling, plus the card's own padding, title and footer.
export const pickerHeight = (names) => 84 + Math.min(LIST_MAX, (names.length + 1) * ROW_H);

// custom-icons/ sits in the app folder, which is outside a mod's own fs roots,
// so the listing goes through a program — the way the files mod lists a folder.
export async function listIcons() {
  const dir = `${appHome()}/custom-icons`;
  const r = window()?.platform === "windows"
    ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-ChildItem -LiteralPath . -File -Name"], { cwd: dir })
    : await exec("sh", ["-c", "ls -1"], { cwd: dir });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "cannot list custom-icons").trim().slice(0, 200));
  return r.stdout.split(/\r?\n/).map((n) => n.trim()).filter((n) => /\.(svg|png)$/i.test(n)).sort();
}

export default class IconPicker extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.at = 0;
    this.handle.focus();
  }

  // The write goes through the workspace store; a failure is a toast, and the
  // dialog still closes, because a half-open dialog says less than the toast.
  pick(row) {
    setIcon({ space: props().space, record: props().record }, row.path).then((failed) => {
      if (failed) notify({ title: "Could not set the icon", body: failed.error, level: "error" });
      closeOverlay(props().overlay);
    });
  }

  rows() {
    const p = props();
    const current = p.icon ?? null;
    const ink = p.space ? "#ffffff" : theme().chrome;
    const entries = [
      { label: "Default", path: null },
      ...(p.names ?? []).map((n) => ({ label: n.replace(/\.(svg|png)$/i, ""), path: `custom-icons/${n}` })),
    ];
    // Every row wears what a space would wear, so a pick is a preview: the tile
    // for `Default`, the icon alone for a file.
    return entries.map((r) => ({ ...r, checked: current === r.path, art: avatar(p.fill, p.name ?? "?", ink, r.path) }));
  }

  render() {
    const t = theme();
    const rows = this.rows();
    this.at = Math.min(this.at, rows.length - 1);
    return v_flex().id("icon-picker").w_full().track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          cx.stop_propagation();
          closeOverlay(props().overlay);
          return;
        }
        if (e.key === "enter") {
          this.pick(rows[this.at]);
          return;
        }
        if (e.key !== "down" && e.key !== "up") return;
        this.at = (this.at + (e.key === "down" ? 1 : rows.length - 1)) % rows.length;
        cx.notify();
      })
      .p(14).gap(8).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .rounded(14).border_1().border_color(t.border)
      .child(div().px(4).text_size(11).text_color(t.dim).truncate().child(props().name ?? "Icon"))
      .child(v_flex().max_h(LIST_MAX).overflow_y_scrollbar().children(rows.map((r, i) =>
        h_flex().id(`icon-row-${i}`).h(ROW_H).flex_none().px(8).gap(9).items_center().rounded(7)
          .when(i === this.at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.pick(r))
          .child(r.art)
          .child(div().flex_1().truncate().child(r.label))
          .when(r.checked, (el) => el.child(svg("mods/herdr-van/icons/check.svg").size(14).flex_none())))))
      .child(div().px(4).text_size(11).text_color(t.dim)
        .child(props().names?.length ? "↑↓ then Enter · Esc close" : "No icons in custom-icons/"));
  }
}
