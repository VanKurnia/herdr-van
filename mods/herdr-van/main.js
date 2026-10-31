// herdr-van: one mod, five parts. The layout puts a copy of it in each block
// and says which part it shows with props: { part: "tabs" | "spaces" |
// "agents" | "brand" | "footer" }. Only that part starts, so the spaces' git
// polling, the agents' timer and the brand's config watch never run twice.
//
// Props are read with props(), not the init argument: the agents list also
// opens itself as an overlay for its sort menu, which arrives as
// props { sortMenu: true } with no part.

import { View } from "gpui-kit";
import { props } from "herdr";
import Tabs from "./tabs.js";
import Spaces from "./spaces.js";
import Agents from "./agents.js";
import Chrome from "./chrome.js";

const PARTS = { tabs: Tabs, spaces: Spaces, agents: Agents, brand: Chrome, footer: Chrome };

const partName = (cfg) => (cfg?.sortMenu ? "agents" : cfg?.part ?? "brand");

export default class HerdrVan extends View {
  init(p, cx) {
    const cfg = props() ?? p ?? {};
    this.name = partName(cfg);
    this.part = new PARTS[this.name]();
    this.part.init(cfg, cx);
  }

  render(cx) {
    // Props can land after init on a fresh layout: rebuild once, never again.
    const name = partName(props());
    if (name !== this.name) {
      this.name = name;
      this.part = new PARTS[name]();
      this.part.init(props(), cx);
    }
    return this.part.render(cx);
  }
}
