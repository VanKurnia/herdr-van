// A space's right-click menu: what this mod adds, then the shipped menu for
// everything else, so the app's own space items keep one implementation.

import { View } from "gpui-kit";
import { closeOverlay, openOverlay, props, spaces, theme } from "herdr";
import { menuCard } from "./lib.js";
import { liveByAddress, procsOf, stopProc } from "./runner.js";

export default class SpaceMenu extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.at = 0;
    this.handle.focus();
  }

  render() {
    const t = theme();
    const space = props().space;
    const live = liveByAddress();
    const running = procsOf(space).filter((r) => live.has(r.address));
    const rows = [
      { icon: "terminal", label: "Run a process…", pick: () => openOverlay({ mod: "herdr-van", props: { part: "runner", space }, kind: "dialog", width: 460, frame: "none" }) },
      ...(running.length ? [{
        icon: "x",
        rule: true,
        label: `Stop ${running.length} process${running.length > 1 ? "es" : ""}`,
        pick: () => running.forEach(stopProc),
      }] : []),
      { icon: "layers", rule: true, label: "Space…", pick: () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: space } } }) },
    ];
    return menuCard(t, {
      handle: this.handle,
      title: spaces().find((s) => s.id === space)?.name ?? "",
      rows,
      at: this.at,
      onMove: (n) => (this.at = n),
      onPick: (i) => {
        closeOverlay(props().overlay);
        rows[i].pick();
      },
    });
  }
}
