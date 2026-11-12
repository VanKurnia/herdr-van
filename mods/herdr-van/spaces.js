// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, notify } from "herdr";
import { avatar, claimSidebarHover, narrow, onSidebar, place, spaceColors, spaceFill, icon } from "./lib.js";
import { readDoc, snapshotDoc, saveSpace, saveAuto, signature, list, writeList, liveRecords, MODE, dropRecord, openWorkspace } from "./workspace.js";
import { procsOf, liveByAddress, syncProcs, stopProc, forgetProc, rerunProc } from "./runner.js";
import { listIcons, pickerHeight } from "./iconPicker.js";

const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// A row's hover action: an 18×18 square that swallows the press, so the row keeps
// its own click and drag. `on` gets the press's cx so the caller can clear the
// row's hover once it fired.
const rowButton = (t, id, glyph, tip, on, color = t.dim) => h_flex().id(id).size(18).flex_none().rounded(4).items_center().justify_center().text_color(color)
  .hover(s => s.bg(t.raised).text_color(t.foreground))
  .tooltip(tip)
  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
  .on_click((_e, cx) => { cx.stop_propagation(); on(cx); })
  .child(svg(`mods/herdr-van/icons/${glyph}.svg`).size(12));
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
// A watcher's burst of writes under .git (a commit, a checkout) becomes one look at git,
// a moment after the last write rather than once per wave.
const SETTLE = 1500;

export default class Spaces {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    this.dirty = {}; // repo -> when a watcher last saw a write
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.snap = {}; // spaceId -> snapshot, live ones only
    this.docSig = null; // signature the snapshots were built from
    this.docReading = false; // single-flight
    this.closedByUs = new Set(); // spaces we closed on purpose
    this.pressed = null;
    this.over = null;
    this.hoverRow = null;
    this.machines = [];
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // Whatever `due` waits for needs no faster tick than this; the rest is event-driven.
    cx.timer.every(1000, (cx) => this.checkNew(cx));
    // Brings the process records up to date with the core; it writes shared state
    // only when something changed, and that write is what redraws the rows.
    cx.timer.every(2000, (cx) => cx.spawn(() => syncProcs()));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    const ps = panes();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    this.capture(cx, sp, ps);
    const due = this.due(now, sp, ps);
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Structure changed (a space, tab or pane appeared, moved or was renamed):
  // re-read the core document once, single-flight, and remember every live
  // space's shape. The last known shape is how a space that closes is saved.
  // `sp`/`ps` are the arrays checkNew already read this tick — pass them in,
  // never re-read them here.
  capture(cx, sp, ps) {
    const gone = Object.entries(this.snap).filter(([id]) => !sp.some(s => s.id === id));
    if (gone.length) this.captureGone(gone);
    const sig = signature(sp, ps);
    if (sig === this.docSig || this.docReading) return;
    this.docReading = true;
    cx.spawn(async () => {
      const doc = await readDoc();
      this.docReading = false;
      // A failed read must not be remembered as "already seen", or capture
      // freezes until the structure changes again.
      if (!doc) { this.docSig = null; return; }
      this.docSig = sig;
      this.snap = snapshotDoc(doc);
      // No cx.notify(): nothing renders this.snap, and the setShared
      // writes in captureGone re-render every part by themselves.
    });
  }

  // A space left the list (closed here or on another client). Three cases, in
  // order: we closed it as an unload (forget it); it was a workspace we had
  // opened (clear its `live`, keep its shape); anything else (keep it as an
  // automatic workspace).
  captureGone(gone) {
    const records = list().records;
    const reopen = [];
    const auto = [];
    for (const [id, snap] of gone) {
      delete this.snap[id];
      if (this.closedByUs.delete(id)) continue;
      const rec = records.find(r => r.live === id);
      if (rec) reopen.push({ ...rec, live: null, tabs: snap.tabs, saved_at: Date.now() });
      else auto.push(snap);
    }
    if (reopen.length) {
      writeList({ v: 1, records: records.map(r => reopen.find(k => k.id === r.id) ?? r) });
    }
    if (auto.length) saveAuto(auto);
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, repos a watcher saw settle, and repos in view whose
  // fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    // A repo whose watcher saw writes: look once the burst has settled.
    for (const [repo, seen] of Object.entries(this.dirty)) {
      if (now - seen < SETTLE) continue;
      delete this.dirty[repo];
      const mine = JSON.stringify([null, repo]);
      for (const k of keys) if (this.git[k]?.repo === mine) due.add(k);
    }
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        await Promise.all(keys.map((key) => this.check(key, cx)));
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo. Refs only: nothing here may walk the
  // worktree, and no command may write under .git (the index watch would wake on it).
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // All four in one round: none of them needs another's answer. A folder name may itself
      // contain a newline, so strip the trailing one rather than trimming.
      const [top, common, head, counts] = await Promise.all([
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      ]);
      if (top.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(top.code !== 0 ? top.stderr : common.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      const root = top.stdout.replace(/\n$/, "");
      // The repo's own .git folder names it; a worktree's top differs from it.
      const repo = common.stdout.replace(/\n$/, "");
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      // No branch means a detached HEAD; `gitTail` draws "detached" for null.
      const branch = head.code === 0 ? head.stdout.trim().replace(/^refs\/heads\//, "") : null;
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      this.git[key] = {
        name,
        branch,
        ahead,
        behind,
        repo: JSON.stringify([on, repo]),
        linked: repo !== `${root}/.git`,
      };
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async () => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          // Noted, not acted on: `due` looks once the burst settles (SETTLE).
          if (this.watching.has(repo)) this.dirty[repo] = Date.now();
        }
      } catch {
        this.watching.delete(repo);
        delete this.dirty[repo];
      }
    });
  }

  menu(w) {
    openOverlay({ mod: "herdr-van", props: { part: "spaceMenu", space: w.id }, kind: "popup", width: 224, frame: "none" });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    return out;
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? [this.compact(r, t)] : [this.row(r, t), ...this.procRows(r.w, t)]);
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.flatMap(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/herdr-van/icons/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", m ? { machine: m } : {}); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/herdr-van/icons/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", m ? { machine: m } : {}))
        .child(svg("mods/herdr-van/icons/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      return [head, ...(folded ? [] : mine.length ? mine.flatMap(draw) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree }, t) {
    const on = w.active;
    const fill = spaceFill(t, w);
    const rec = this.records.get(w.id);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(tree ? 28 : 30)
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, (line) => line.bottom(0))
          .when(this.pressed > i, (line) => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_move((_e, cx) => {
        if (this.pressed === null) return;
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.over !== over) { this.over = over; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed, over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        else if (from === i) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .on_hover((on, cx) => this.setHover(`space-${w.id}`, on, cx))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/herdr-van/icons/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(avatar(fill, w.name, "#ffffff", rec?.icon)))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
          .when(this.hoverRow === `space-${w.id}`, el => el.child(
            h_flex().gap(2).items_center()
              .child(rowButton(t, `space-icon-${w.id}`, "square-pen", "Icon", (cx) =>
                this.pickIcon({ space: w.id, record: rec?.id, name: w.name, icon: rec?.icon, fill }, cx)))
              .child(rowButton(t, `space-save-${w.id}`, "layers", "Save as workspace", (cx) => { this.saveLive(w.id); this.clearHover(cx); }))
              .when((shared(MODE) ?? "active") === "all", row => row.child(
                rowButton(t, `space-unload-${w.id}`, "close", "Unload (keeps it in Saved)", (cx) => { this.unload(w); this.clearHover(cx); }))))),
      );
  }

  // The rail draws what a row draws, with the name gone: same tile, same height,
  // so a folded sidebar reads as one column of icons. The number still finds its
  // way into the tooltip, since it is how a person picks a space by key, and the
  // status sits on the tile so it cannot shift it off the column.
  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(30)
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .tooltip(`${i + 1} · ${w.name}`)
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().relative().size(24).flex_none()
        .child(avatar(spaceFill(t, w), w.name, "#ffffff", this.records.get(w.id)?.icon))
        // A space speaks up only when something in it needs you.
        .child(div().absolute().top(0).right(-3).text_size(9).text_color(t[w.status] ?? t.unknown)
          .child(w.status === "blocked" || w.status === "done" ? "●" : "·")));
  }

  // One row per process of this space, in the sub-agent row's geometry: the
  // state word is the whole story, since a process reports no status of its own.
  procRows(w, t) {
    return procsOf(w.id).map((rec) => {
      const term = this.live?.get(rec.address);
      const pic = icon(term?.program, 14, t.foreground);
      // The outcome is a mark, not a word: a run in flight, one that finished, one
      // the person stopped, and a failure. The exit code rides in the tooltip.
      const [glyph, color] = term ? ["play", t.ansi2]
        : rec.ended?.reason === "killed" ? ["square", t.ansi3]
        : rec.ended?.code ? ["x", t.ansi1]
        : rec.ended || rec.address ? ["check", t.dim]
        : ["clock", t.dim];
      return h_flex().id(`runner-${rec.id}`).pl(15).pr(8).h(26).flex_none().gap(0).items_center().rounded(8).text_size(12.5)
        .hover((s) => s.bg(t.hover))
        .tooltip(rec.ended?.code ? `${rec.cmd} · exited ${rec.ended.code}` : rec.cmd)
        .on_click(() => (term ? run("terminal.peek", { terminal: term.address }) : rerunProc(rec)))
        .on_hover((on, cx) => this.setHover(`runner-${rec.id}`, on, cx))
        .child(div().self_start().mt(-4).w(9).h(17).mr(4).flex_none().border_l(1.5).border_color(t.input).border_b(1.5).rounded_bl(6))
        .when(Boolean(pic), (el) => el.child(div().mr(8).child(pic)))
        .child(div().flex_1().truncate().text_color(t.muted).child(rec.name))
        .child(svg(`mods/herdr-van/icons/${glyph}.svg`).size(13).flex_none().text_color(color))
        .when(this.hoverRow === `runner-${rec.id}`, (el) => el.child(h_flex().gap(2).items_center()
          .child(rowButton(t, `runner-rename-${rec.id}`, "square-pen", "Rename", (cx) => {
            openOverlay({ mod: "herdr-van", props: { part: "runner", space: w.id, id: rec.id }, kind: "dialog", width: 380, frame: "none" });
            this.clearHover(cx);
          }))
          .when(!term, (row) => row.child(rowButton(t, `runner-rerun-${rec.id}`, "refresh", "Run it again", (cx) => { rerunProc(rec); this.clearHover(cx); }, t.ansi11)))
          .child(rowButton(t, `runner-${term ? "stop" : "forget"}-${rec.id}`, "x", term ? "Stop" : "Forget", (cx) => { (term ? stopProc(rec) : forgetProc(rec)); this.clearHover(cx); }, t.ansi1))));
    });
  }

  // Saved workspaces with no live space behind them: muted, below the live
  // rows, never draggable.
  savedRows(t, collapsed) {
    const mode = shared(MODE) ?? "active";
    if (mode !== "all") return [];
    const live = new Set(spaces().map(s => s.id));
    const recs = list().records.filter(r => !r.live || !live.has(r.live));
    if (!recs.length) return [];
    const head = h_flex().id("workspace-head").h(24).flex_none().px(8).items_center().text_size(10.5).text_color(t.dim)
      .child(collapsed ? "" : "Saved");
    const row = (r) => h_flex()
      .id(`workspace-${r.id}`)
      .h(30).flex_none().px(collapsed ? 0 : 8).gap(9).items_center().rounded(8)
      .when(collapsed, (el) => el.justify_center())
      .opacity(0.55)
      .hover(s => s.bg(t.hover))
      .on_click((_e, cx) => openWorkspace(r, cx))
      .child(avatar(t.dim, r.name, t.chrome, r.icon))
      .when(!collapsed, (el) => el.child(div().flex_shrink(0).max_w(150).truncate().text_color(t.muted).child(r.name)).child(div().flex_1()))
      .when(!collapsed && this.hoverRow === `workspace-${r.id}`, el => el.child(
        h_flex().gap(2).items_center()
          .child(rowButton(t, `workspace-icon-${r.id}`, "square-pen", "Icon", (cx) =>
            this.pickIcon({ record: r.id, name: r.name, icon: r.icon, fill: t.dim }, cx)))
          .child(h_flex().id(`workspace-forget-${r.id}`).size(18).flex_none().rounded(4).items_center().justify_center().text_color(t.dim)
            .hover(s => s.bg(t.raised).text_color(t.foreground))
            .tooltip("Forget this workspace")
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); dropRecord(r.id); this.clearHover(cx); })
            .child(svg("mods/herdr-van/icons/x.svg").size(11)))))
      .on_hover((on, cx) => this.setHover(`workspace-${r.id}`, on, cx));
    return [head, ...recs.map(row)];
  }

  // Hover ownership, same rule the agents part already uses: set on enter,
  // clear only if the pointer left the row that currently owns the hover.
  setHover(id, on, cx) {
    if (on) { if (this.hoverRow === id) return; this.hoverRow = id; }
    else { if (this.hoverRow !== id) return; this.hoverRow = null; }
    cx.notify();
  }

  // After an action the row can move away from under the pointer and no
  // hover-out arrives (the same trap the agents pin documents), so clear the
  // hover explicitly and drop the drag state the row's mouse-down set.
  clearHover(cx) {
    this.hoverRow = null;
    this.pressed = null;
    this.over = null;
    cx.notify();
  }

  // The row hands the picker what it shows; its list is read before it opens, so
  // nothing re-measures under the pointer.
  pickIcon({ space, record, name, icon, fill }, cx) {
    cx.spawn(async () => {
      try {
        const names = await listIcons();
        openOverlay({ mod: "herdr-van", props: { part: "icon", space, record, name, icon, fill, names }, kind: "dialog", width: 300, height: pickerHeight(names), frame: "none" });
      } catch (e) {
        notify({ title: "Could not read custom-icons", body: String(e?.message ?? e), level: "error" });
      }
    });
    this.clearHover(cx);
  }

  saveLive(spaceId) {
    const w = spaces().find(s => s.id === spaceId);
    saveSpace(spaceId).then((r) => {
      if (r?.error) notify({ title: "Could not save workspace", body: r.error, level: "error" });
      else notify({ title: "Saved workspace", body: w?.name ?? "", level: "success" });
    }).catch((e) => notify({ title: "Could not save workspace", body: String(e), level: "error" }));
  }

  // Unload: keep the workspace, end its terminals. The record is refreshed from
  // the last captured shape before the close, and `closedByUs` stops capture
  // from also saving it as an automatic workspace.
  unload(w) {
    this.closedByUs.add(w.id);
    const close = () => {
      const records = list().records;
      const rec = records.find(r => r.live === w.id);
      if (rec) {
        const tabs = this.snap[w.id]?.tabs ?? rec.tabs;
        writeList({ v: 1, records: records.map(r => r.id === rec.id ? { ...r, live: null, tabs, saved_at: Date.now() } : r) });
      }
      run("space.close", { id: w.id, confirmed: true });
    };
    // No captured shape yet (the space just appeared): save it, then unload.
    if (this.snap[w.id]) close(); else saveSpace(w.id).then(close);
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const sp = spaces();
    // One scan for the live terminals, before grouped.
    this.live = liveByAddress();
    // One pass per render: the record behind each live space, for its icon.
    this.records = liveRecords();
    // Keeps shared "space.colors" in step; the rows read it through spaceFill.
    spaceColors();
    // Both header buttons are 22×22: a box sized from its label plus padding is
    // never square, so the size comes from .size(), never from the glyph.
    const mode = shared(MODE) ?? "active";
    const add = h_flex().id("space-new").size(22).flex_none().rounded(5).items_center().justify_center()
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip("New space")
      .on_click(() => run("space.new"))
      .child("+");
    const modeBtn = h_flex().id("space-mode").size(22).flex_none().rounded(5).items_center().justify_center()
      .text_color(mode === "all" ? t.foreground : t.dim)
      .when(mode === "all", el => el.bg(t.selected))
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(mode === "all" ? "Showing saved workspaces" : "Showing open spaces")
      .on_click(() => setShared(MODE, mode === "all" ? "active" : "all"))
      .child(svg("mods/herdr-van/icons/layers.svg").size(13));
    return v_flex().id("sidebar-spaces").size_full().min_h(0).text_size(13)
      .on_hover(claimSidebarHover("spaces"))
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, el => el.child("Spaces"))
        .when(!collapsed && onSidebar(), el => el.child(h_flex().gap(4).items_center().child(modeBtn).child(add))))
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.over = null; cx.notify(); })
        .children([...this.grouped(t, collapsed), ...this.savedRows(t, collapsed)]));
  }
}
