// Agents as cards: a space-coloured spine, then the program's mark, the agent's name and
// its state. Sections fold; a parent takes its most urgent sub-agent's place.
// A viewed done agent stays in Done until left. A row can also be given a name here,
// which wins over what the agent calls itself.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, InputState, Input } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props } from "herdr";
import { claimSidebarHover, narrow, icon, menuCard, spaceColors, spaceFill, sectionTitle, treeLines } from "./lib.js";

// Drops the status glyph, spinner and separator an agent puts before its title, and Codex's
// `[ ! ]` mark; stops at an opening bracket so a bracketed title keeps it.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// The pane whose title speaks for a tab: its agent, else the focused one, else the first.
function lead(mine) {
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  // `clean` would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== (l?.terminal ?? l?.address) && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return tab.name === prog && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as blocked, never
// done - it reports to its parent, and the parent's done is the news. One with a pane is in
// agents() too and keeps its own status.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address);
  if (s) return s;
  return k.status === "error" ? "blocked" : k.status === "done" ? "idle" : k.status;
};
// A helper's done is its own row's news: it doesn't pull a working parent out of Working.
const kidRank = (k, listed) => {
  const s = kidStatus(k, listed);
  return RANK[s === "done" ? "idle" : s] ?? 0;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];

// Names given to agents here, by address: what an agent calls itself changes as it works, a name
// does not. Shared, so the list, its menus and the dialog read the same ones.
const names = () => shared("agents.names") ?? {};
const setName = (address, name) => {
  const next = { ...names() };
  if (name) next[address] = name;
  else delete next[address];
  setShared("agents.names", next);
};
// What an agent calls itself: its terminal's title, else what its tab or terminal carries.
const ownTitle = (address) => {
  const a = agents().find((k) => k.address === address);
  const term = terminals().find((k) => k.address === address);
  return a?.title || a?.tab_name || term?.name || term?.template || address;
};
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// A space's spine: the bar that says which space a row belongs to, on every row of it.
const spineBar = (color, strength) =>
  div().w(3).h_full().flex_none().opacity(strength).bg(color);

export default class Agents {
  init(_props, cx) {
    // Every menu, and the name dialog, open as their own copy: keys need a focus handle.
    const menu = props()?.menu;
    if (menu) {
      this.handle = cx.focus_handle();
      if (menu === "name") {
        this.input = InputState.new({ placeholder: "its own title", value: props().name ?? "" });
        this.input.on("submit", () => this.commit());
        // A popup lays out after its view is built, which can take the keyboard back.
        cx.timer.after(600, () => this.input.focus());
        return;
      }
      this.menuAt = 0;
      this.handle.focus();
      return;
    }
    this.folded = new Set();
    this.scroll = ScrollHandle.new();
    this.scrolled = null; // the row last revealed
    this.headHover = false; // the pointer on the section's own header
    // Each agent's last state and when it changed (ms), kept across restarts. A damaged value is
    // dropped rather than thrown: losing the ages is cheap, losing the list is not.
    try { this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}"); } catch { this.changed = {}; }
    if (!this.changed || typeof this.changed !== "object" || Array.isArray(this.changed)) this.changed = {};
    // Pins used to live here; `adoptPins` hands them to the terminals that still exist.
    try { this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]"); } catch { this.pendingPins = []; }
    if (!Array.isArray(this.pendingPins)) this.pendingPins = [];
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // One-time: the pin list used to be this mod's own. Each pin becomes the terminal's
  // (`terminal.pin`), so every Herdr client sees it and it ends with the terminal. A pin
  // whose terminal isn't listed yet stays in the key and is retried on the next render.
  adoptPins(all) {
    if (!this.pendingPins.length) return;
    const live = new Set(all.filter((k) => k.state === "live").map((k) => k.address));
    for (const address of this.pendingPins) if (live.has(address)) run("terminal.pin", { terminal: address, pinned: true });
    this.pendingPins = this.pendingPins.filter((address) => !live.has(address));
    if (this.pendingPins.length) localStorage.setItem("pins", JSON.stringify(this.pendingPins));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  // A menu popup: a title, rows, ↑/↓ then Enter, Esc to close. The sort menu and
  // a row's menu are the same shape; the shipped `menu` mod knows panes, tabs and
  // spaces only, so the agents list draws its own.
  popup(t, title, rows, onPick) {
    return menuCard(t, { handle: this.handle, title, rows, at: this.menuAt, onMove: (n) => (this.menuAt = n), onPick });
  }

  sortMenu(t) {
    const rows = SORTS.map((s) => ({ label: s.label, icon: s.icon, checked: s.id === sortOf().id }));
    return this.popup(t, "Sort agents", rows, (i) => {
      setShared("agents.sort", SORTS[i].id);
      closeOverlay(props().overlay);
    });
  }

  // Right-click on an agent or sub-agent row: the same popup either way.
  menu(address) {
    openOverlay({ mod: "herdr-van", kind: "popup", width: 220, props: { menu: "row", address } });
  }

  // One row's options, shaped like the tab bar's menu. A name beats what the agent calls itself.
  agentMenu(t) {
    const addr = props()?.address;
    const name = names()[addr];
    const a = agents().find((k) => k.address === addr);
    const rows = [];
    if (a) rows.push({ label: "Focus", icon: "terminal", command: "pane.focus", args: { pane: a.pane } });
    rows.push({ label: "Peek", icon: "monitor", command: "terminal.peek", args: { terminal: addr } });
    rows.push({ label: "Rename agent…", icon: "square-pen", rename: true });
    if (a) rows.push({ label: "Rename tab…", icon: "square-pen", command: "tab.rename", args: { id: a.tab } });
    if (a) rows.push({ label: "Rename space…", icon: "square-pen", command: "space.rename", args: { id: a.space } });
    rows.push(a
      ? { label: "Close pane", icon: "x", rule: true, command: "pane.close", args: { pane: a.pane } }
      : { label: "Kill terminal", icon: "x", rule: true, command: "terminal.kill", args: { terminal: addr } });
    return this.popup(t, name || ownTitle(addr), rows, (i) => {
      closeOverlay(props().overlay);
      if (rows[i].rename) openOverlay({ mod: "herdr-van", kind: "popup", width: 280, props: { menu: "name", address: addr, name: name ?? "" } });
      else run(rows[i].command, rows[i].args);
    });
  }

  // The name to show for one agent in place of what it calls itself. An empty name hands the row
  // back to the agent's own title; Esc leaves the name as it was.
  agentRename(t) {
    const p = props();
    return v_flex().id("agent-rename").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        cx.stop_propagation();
        closeOverlay(p.overlay);
      })
      .p(16).gap(10).bg(t.popover).rounded(14).border_1().border_color(t.border).text_size(13).text_color(t.foreground)
      .child(div().text_size(15).font_semibold().child("Rename agent"))
      .child(div().text_size(11.5).text_color(t.dim).truncate().child(ownTitle(p.address)))
      .child(h_flex().h(34).flex_none().px(9).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .child(div().text_size(11).text_color(t.dim).child("Enter save · Esc close · empty: its own title"));
  }

  commit() {
    setName(props().address, this.input.value().trim());
    closeOverlay(props().overlay);
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  // `kidsOf` is built once per render (see `render`): parent address -> live children.
  tree(kidsOf, addr, lead = []) {
    const kids = kidsOf.get(addr) ?? [];
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(kidsOf, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  // A sub-agent that is also an agent (it was given a pane) is focused where it runs; one that
  // only reports to its parent is peeked at.
  open(address) {
    const agent = agents().find((a) => a.address === address);
    if (agent) run("pane.focus", { pane: agent.pane });
    else run("terminal.peek", { terminal: address });
  }

  subRow(t, s, shown, compact, spine) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .rounded_r(9)
      .h(26)
      .flex_none()
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.open(k.address))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(k.address); })
      // Quieter than the row it hangs under, and on the same edge, so the colour runs straight
      // down a space's agents.
      .child(spineBar(spine, 0.4))
      // The tree hangs from the centre of the parent's mark: 3 for the spine, then that row's
      // 9px inset and half of its 16px mark, less this row's own spine.
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .h_full()
          .pl(16)
          .pr(8)
          .gap(0)
          .items_center()
          .text_size(12.5)
          .child(treeLines(t, s.lines, 26).mr(5))
          .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
          .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(names()[k.address] || k.name || k.template || k.program?.name || k.address))
          .child(this.status(t, { status: st }, compact)),
      );
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/herdr-van/icons/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    const menu = props()?.menu;
    if (menu === "sort") return this.sortMenu(t);
    if (menu === "row") return this.agentMenu(t);
    if (menu === "name") return this.agentRename(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    // A name belongs to a terminal, so it goes when that terminal does; an empty list is a start,
    // not an end. Written only when something is stale.
    const named = names();
    const live = new Set(all.filter((k) => k.state === "live").map((k) => k.address));
    if (live.size && Object.keys(named).some((address) => !live.has(address))) {
      setShared("agents.names", Object.fromEntries(Object.entries(named).filter(([address]) => live.has(address))));
    }
    const ps = panes();
    // A card's edge is its space's own colour, the one its avatar is drawn in, so the
    // sidebar says one thing about a space. Read (and settle) the map once per render.
    spaceColors();
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    // One pass per array: the sub-agent tree, the tabs and the panes are read per agent
    // below, and walking `all` once per row is the expensive part of a render.
    const kidsOf = new Map();
    for (const k of all) {
      if (!k.parent || k.state !== "live") continue;
      const kids = kidsOf.get(k.parent);
      if (kids) kids.push(k);
      else kidsOf.set(k.parent, [k]);
    }

    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows it, it gets no
    // row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(kidsOf, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const panesByTab = new Map();
    for (const p of ps) {
      if (!p.terminal || !p.tab) continue;
      const mine = panesByTab.get(p.tab);
      if (mine) mine.push(p);
      else panesByTab.set(p.tab, [p]);
    }
    const tabsById = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(kidsOf, a.address).map((s) => kidRank(s.t, this.listed)))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    this.adoptPins(all);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(16)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/herdr-van/icons/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // Line two is the agent: a name someone gave it, else the tab's own title, else what it
    // calls itself. A tab's title speaks for its row only while the tab holds one agent.
    const label = (a) => {
      if (named[a.address]) return named[a.address];
      const tab = tabsById.get(a.tab);
      if (!tab) return a.title || a.program?.name || "";
      const many = (tabCounts.get(a.tab) ?? 0) > 1;
      return title(many ? { ...tab, named: false } : tab, many ? a : lead(panesByTab.get(a.tab) ?? []));
    };
    const labels = new Map(list.map((a) => [a.address, label(a)]));

    const row = (a, i, subs, spine) => {
      // The rail has room for a number and a mark, nothing else.
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(a.address); })
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const pic = icon(a.program, 16, t.foreground);
      // A space header above already says where the card lives; only a card that has none
      // (priority, pinned) names its space.
      const showSpace = (byPriority || a.pinned) && Boolean(a.space_name);
      // A tab nobody named is called by its number: as a name it says nothing, so the
      // program's stands in.
      const shown = labels.get(a.address) || a.space_name;
      const name = /^\d+$/.test(shown) ? a.program?.name || shown : shown;
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const hot = this.hovered === a.address;
      const tool = (key, glyph, tip, action) => div()
        .id(`${key}-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(tip)
        .on_click((_e, cx) => {
          cx.stop_propagation();
          action();
          // Pinning or settling moves the row out from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/herdr-van/icons/${glyph}.svg`).size(12));
      const pin = tool(
        "pin",
        isPinned ? "pin-off" : "pin",
        isPinned ? "Unpin" : "Pin to the top",
        () => run("terminal.pin", { terminal: a.address, pinned: !a.pinned }),
      );
      // The card on one line: the space's spine, the program's mark, the name, and at the
      // right whatever the row can say about it. Square on the left so the spine meets the
      // fill edge to edge; rounded on the right.
      return h_flex()
        .id(`ag-${a.address}`)
        .flex_none()
        .h(30)
        .rounded_r(9)
        .overflow_hidden()
        .cursor_pointer()
        .when(a.focused, (el) => el.bg(t.selected))
        .when(!a.focused, (el) => el.hover((s) => s.bg(t.hover)))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(a.address); })
        .child(spineBar(spine, 1))
        .child(
          h_flex()
            .flex_1()
            .min_w(0)
            .px(9)
            .gap(6)
            .items_center()
            // The program's mark folds a parent's sub-agents; without sub-agents it is a mark.
            .when(pic, (el) =>
              el.child(
                div()
                  .id(`agent-fold-${a.address}`)
                  .when(subs.length > 0, (inner) =>
                    inner.on_click((_e, cx) => {
                      cx.stop_propagation();
                      this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
                      cx.notify();
                    }),
                  )
                  .child(pic),
              ),
            )
            .child(
              div()
                .min_w(0)
                .flex_shrink(1)
                .truncate()
                .text_size(13)
                .font_semibold()
                .text_color(idle ? t.muted : t.foreground)
                .child(name),
            )
            // A section without a space header names the space here instead.
            .when(showSpace, (el) =>
              el.child(
                div()
                  .min_w(0)
                  .flex_shrink(1)
                  .truncate()
                  .text_size(11)
                  .text_color(t.dim)
                  .child(`\u00b7 ${a.space_name}`),
              ),
            )
            .when(Boolean(machine), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(machine)))
            .child(div().flex_1())
            .when(subs.length > 0, (el) => el.child(fold(a, subs)))
            .when(hot, (el) => el.child(pin))
            .when(hot, (el) =>
              el.child(
                tool("settle", "layers", "Settle: put its tab away", () => run("tab.settle", { id: a.tab })),
              ),
            )
            .when(!hot && Boolean(when), (el) =>
              el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(duration(now - when))),
            )
            .child(this.status(t, a, byPriority && !isPinned)),
        );
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, space: byPriority ? null : a.space, members: [a] });
    }

    // A group's header: its name in small caps and that group's colour, a hairline rule
    // taking the rest of the width, then its count. Folded, it carries the most urgent
    // state of what it hides instead of the list itself.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      const tone = g.space ? spaceFill(t, { id: g.space }) : t[g.status] ?? t.dim;
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(10)
        .pb(4)
        .flex_none()
        .items_center()
        .cursor_pointer()
        .text_color(tone)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(sectionTitle(t, {
          label: g.label || "",
          tone,
          right: h_flex().gap(6).items_center()
            .child(div().text_color(t.dim).child(String(g.members.length)))
            .when(!open, (el) => el
              .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
              .child(svg("mods/herdr-van/icons/chevron-right.svg").size(11).flex_none().text_color(t.dim))),
        }));
    };
    const rows = [];
    let at = -1; // the row the focused agent itself stands on — a sub-agent has one of its own
    const add = (a, i) => {
      const subs = collapsed ? [] : this.tree(kidsOf, a.address);
      // The space's own colour, on the row and, dimmer, on the sub-agents under it.
      const spine = spaceFill(t, { id: a.space });
      if (at < 0 && a.address === shown) at = rows.length;
      rows.push(row(a, i, subs, spine));
      if (this.folded.has(a.address)) return;
      for (const s of subs) {
        if (at < 0 && s.t.address === shown) at = rows.length;
        rows.push(this.subRow(t, s, shown, byPriority, spine));
      }
    };
    if (collapsed) list.forEach(add);
    else for (const g of groups) {
      rows.push(header(g));
      if (!this.folded.has(g.id)) g.members.forEach(add);
    }
    if (at >= 0 && at !== this.scrolled) {
      this.scrolled = at;
      this.scroll.scroll_to_item(at);
    }

    return v_flex()
      .id("sidebar-agents")
      .size_full()
      .min_h(0)
      // The line above belongs to the header: it shows while the pointer is on that header, so
      // the two sections read as one until the person reaches for the agents one.
      .border_t(1)
      .border_color(this.headHover ? t.border : "#00000000")
      .text_size(13)
      .on_hover(claimSidebarHover("agents"))
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(10)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .text_color(t.accent)
            .on_hover((on, cx) => {
              this.headHover = on;
              cx.notify();
            })
            .child(sectionTitle(t, {
              label: "Agents",
              tone: t.accent,
              icon: "mods/herdr-van/icons/robot.svg",
              right: div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "herdr-van", kind: "popup", width: 200, height: 140, props: { menu: "sort" } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/herdr-van/icons/${sort.icon}.svg`).size(14)),
            })),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").track_scroll(this.scroll).children(rows))
      // A strip under the list: the rail's prefix indicator, the option glyph in accent
      // while a prefix waits and nothing otherwise. The brand row at the top carries
      // the sidebar's toggle, so this strip is the indicator alone.
      .child(
        h_flex()
          .id("rail-prefix")
          .h(28)
          .items_center()
          .justify_center()
          .when(collapsed && Boolean(shared("prefix.armed")), (el) =>
            el.child(svg("mods/herdr-van/icons/option.svg").size(14).text_color(t.accent)),
          ),
      );
  }
}
