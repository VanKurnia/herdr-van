// Runner processes: the long-running programs a space owns, each a headless core
// terminal shown as a row under its space. Records live in shared state, the
// terminal is found by the address the record keeps, and the outcome is written
// back into the record when it ends. This computer's core only: a process started
// elsewhere answers to that computer's core, which this mod cannot see.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { closeOverlay, hc, home, machines, notify, panes, props, setShared, shared, spaces, terminals, theme, window } from "herdr";
import { place } from "./lib.js";

// A record: { id, space, name, cmd, cwd, address, ended }. `ended` is null while
// the run may still be alive, and { code, reason } once the core reports it over.
const KEY = "runner.procs";

const procs = () => {
  const s = shared(KEY);
  return s && Array.isArray(s.procs) ? s.procs : [];
};
// A write re-renders every part, so only a real change is written.
const writeProcs = (next) => {
  const now = { v: 1, procs: next };
  if (JSON.stringify(shared(KEY)) === JSON.stringify(now)) return;
  setShared(KEY, now);
};
export const procsOf = (space) => procs().filter((p) => p.space === space);

const patchProc = (id, patch) => writeProcs(procs().map((p) => (p.id === id ? { ...p, ...patch } : p)));
const dropProc = (id) => writeProcs(procs().filter((p) => p.id !== id));

// A terminal's address, keyed, so one scan answers for every row.
export const liveByAddress = () => new Map(terminals().filter((t) => t.state === "live").map((t) => [t.address, t]));

// The shell a command runs in: the same rule the app uses for its own shells.
// A missing pwsh surfaces as a failed start, which the toast reports.
const shellArgv = () => (window()?.platform === "windows" ? ["pwsh", "-NoLogo", "-Command"] : ["sh", "-c"]);

async function startProc(rec) {
  const r = await hc(["run", "--bg", "--no-parent", "--outlive-parent", "--cwd", rec.cwd, "--json", "--", ...shellArgv(), rec.cmd])
    .catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  if (r.code !== 0) {
    notify({ title: `Could not start ${rec.name}`, body: (r.stderr || r.stdout || "").trim(), level: "error" });
    return;
  }
  patchProc(rec.id, { address: JSON.parse(r.stdout).address, ended: null });
}

// Ending it keeps the row: the record is what the person will rerun.
export async function stopProc(rec) {
  if (rec.address) await hc(["kill", rec.address]).catch(() => {});
}

// Forget a row: end it if it still runs, drop the core's record, drop ours.
export async function forgetProc(rec) {
  await stopProc(rec);
  if (rec.address) await hc(["rm", rec.address]).catch(() => {});
  dropProc(rec.id);
}

// Run it again: the old address is finished, so drop it before starting.
export function rerunProc(rec) {
  if (rec.address) hc(["rm", rec.address]).catch(() => {});
  return startProc({ ...rec, address: null });
}

// Bring the records up to date with the core, on a tick: forget the rows whose
// space is gone, then write in the outcome of every run that ended. Each write
// goes through writeProcs, so a tick re-renders the sidebar at most once.
export async function syncProcs() {
  const recs = procs();
  if (!recs.length) return;
  const ms = machines();
  const all = spaces();
  // A space list that is still loading, or a machine that is not ready, makes every
  // record look orphaned — and forgetting one ends its process.
  if (!ms.length || !all.length || ms.some((m) => m.layout !== "ready")) return;
  const ids = new Set(all.map((s) => s.id));
  for (const rec of recs.filter((r) => !ids.has(r.space))) await forgetProc(rec);
  // While every runner's terminal is live the tick has its answer already: one `terminals()`
  // read, no process. A record that is merely starting costs one `hc ls` and nothing else —
  // the write below leaves every terminal the core reports live untouched.
  const alive = liveByAddress();
  if (!recs.some((r) => ids.has(r.space) && r.address && !r.ended && !alive.has(r.address))) return;
  const ls = await hc(["ls", "--all", "--json"]).catch(() => null);
  if (ls?.code !== 0) return;
  let done;
  try { done = new Map((JSON.parse(ls.stdout).terminals ?? []).map((t) => [t.address, t])); } catch { return; }
  writeProcs(procs().map((p) => {
    const t = done.get(p.address);
    if (!p.address || p.ended || t?.state === "live") return p;
    // An address the core no longer knows is over too, just without an outcome.
    return { ...p, ended: { code: t?.exit_code ?? null, reason: t?.reason ?? null } };
  }));
}

export default class Runner extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.renaming = Boolean(props()?.id);
    this.note = "";
    this.name = this.renaming ? procs().find((p) => p.id === props().id)?.name ?? "" : "";
    this.cmd = "";
    this.nameInput = InputState.new({ placeholder: "web", value: this.name });
    this.cmdInput = InputState.new({ placeholder: "npm run dev" });
    this.nameInput.on("change", () => (this.name = this.nameInput.value()));
    this.cmdInput.on("change", () => (this.cmd = this.cmdInput.value()));
    this.nameInput.on("submit", (_e, cx) => this.submit(cx));
    this.cmdInput.on("submit", (_e, cx) => this.submit(cx));
    this.handle.focus();
    // A popup lays out after its view is built, which can take the keyboard back.
    cx.timer.after(600, () => this.nameInput.focus());
  }

  get space() {
    return spaces().find((s) => s.id === props().space);
  }

  submit(cx) {
    cx.spawn(async () => {
      if (this.renaming) {
        const name = this.name.trim();
        if (name) patchProc(props().id, { name });
        this.close();
        return;
      }
      const s = this.space;
      if (!s) {
        this.note = "that space is gone";
        cx.notify();
        return;
      }
      if (s.machine) {
        this.note = "this computer only";
        notify({ title: "Remote spaces cannot run processes yet", level: "warning" });
        cx.notify();
        return;
      }
      const cmd = this.cmd.trim();
      if (!cmd) {
        this.note = "a command is needed";
        cx.notify();
        return;
      }
      const cwd = place(s, panes()) || s.folder || home();
      const rec = {
        id: Math.random().toString(36).slice(2, 10),
        space: s.id,
        name: this.name.trim() || cmd.split(/\s+/)[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, ""),
        cmd,
        cwd,
        address: null,
        ended: null,
      };
      writeProcs([...procs(), rec]);
      // Started before closing: work begun after closeOverlay is not guaranteed to run.
      await startProc(rec);
      this.close();
    });
  }

  // A mod pane has no overlay to close.
  close() {
    if (props().overlay) closeOverlay(props().overlay);
  }

  render() {
    const t = theme();
    const s = this.space;
    const cwd = s ? place(s, panes()) || s.folder || home() : "";
    const field = (input) => h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9)
      .border_1().border_color(t.accent).bg(t.background)
      .child(Input.new(input).flex_1().h_full().text_size(12.8).text_color(t.foreground));
    return v_flex().id("runner-form").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        cx.stop_propagation();
        this.close();
      })
      .p(18).gap(10).bg(t.popover).text_size(13).text_color(t.foreground)
      .rounded(14).border_1().border_color(t.border)
      .child(div().text_size(15).font_semibold().child(this.renaming ? "Rename process" : "Run a process"))
      .when(Boolean(s), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(`${s.name} · ${cwd}`)))
      .child(field(this.nameInput))
      .when(!this.renaming, (el) => el.child(field(this.cmdInput)))
      .when(Boolean(this.note), (el) => el.child(div().text_size(12).text_color(t.idle).child(this.note)))
      .child(div().text_size(11).text_color(t.dim).child(this.renaming ? "Enter rename · Esc close" : "Enter run · Esc close"));
  }
}
