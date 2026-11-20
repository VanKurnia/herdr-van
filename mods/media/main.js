// Now playing, for the bottom of the sidebar: cover art, title and artist, over
// a small live spectrum.
//
// The WinRT and loopback-audio work lives in helper.py, started once as a hidden
// background process; this mod only reads what it publishes. Each file has one
// writer, because herdr's writeTextFile is a read-modify-write that needs the
// content it expects to find:
//   helper -> state.json, levels.json, tick, cover-*.png
//   mod    -> beat, whose staleness tells the helper the window is gone
// close() kills the helper; a window that died without closing is caught by the
// beat going stale.

import { View, div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, checking, exec, layout, props, readTextFile, writeTextFile, theme } from "herdr";

const mediaFile = (name) => `${appHome()}/data/media/${name}`;
const modDir = () => `${appHome()}/mods/media`;

// herdr's layout() is an untyped tree: find this copy's own block, by the id the
// layout passes in props, so it can tell when it has been hidden.
function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

const COVER_PX = 46;
const BARS_H = 16;
const COMPACT_PX = 160; // below this the row is cover-only: no text, no bars
const READ_MS = 1000;
const LEVELS_MS = 120;
const BEAT_MS = 10000;
const TICK_STALE_S = 15; // the helper ticks every second
const RETRY_MS = 20000; // wait after a failed launch, doubling
const RETRY_MAX_MS = 300000; // then keep trying slowly: dependencies can arrive later
const OFFLINE_AFTER = 2; // failed launches before the row says why it is empty

export default class Media extends View {
  init(_props, cx) {
    this.body = null; // last state.json body, to skip identical reads
    this.state = null;
    this.levelsBody = null;
    this.levels = [];
    this.width = 268;
    this.pid = null;
    this.beatBody = null; // null: the file has not been adopted yet
    this.launchedAt = 0;
    this.launchFailures = 0;
    this.parked = false;
    if (checking()) return;
    this.parked = this.hidden();
    if (!this.parked) this.spawnHelper(cx);
    cx.timer.every(READ_MS, (cx) => this.read(cx));
    cx.timer.every(5000, (cx) => this.alive(cx));
    cx.timer.every(LEVELS_MS, (cx) => this.readLevels(cx));
    cx.timer.every(BEAT_MS, (cx) => this.beat(cx));
  }

  hidden() {
    const id = props()?.block;
    return Boolean(id && findNode(layout(), id)?.hidden);
  }

  // A hidden block keeps its copy, and its timers, alive, so being off is not
  // free: park the helper while the row is hidden and start it again after.
  syncParked(cx) {
    const hidden = this.hidden();
    if (hidden !== this.parked) {
      this.parked = hidden;
      if (hidden) cx.spawn(() => this.stopHelper());
      else {
        this.launchedAt = 0; // this was a deliberate stop, not a failed launch
        this.spawnHelper(cx);
      }
    }
  }

  beat(cx) {
    if (this.parked) return;
    cx.spawn(async () => {
      if (this.beatBody === null) {
        this.beatBody = await readTextFile(mediaFile("beat")).catch(() => undefined);
      }
      const body = String(Math.floor(Date.now() / 1000));
      try {
        await writeTextFile(mediaFile("beat"), body, this.beatBody);
        this.beatBody = body;
      } catch {
        this.beatBody = null; // changed under us: adopt it again on the next beat
      }
    });
  }

  spawnHelper(cx) {
    if (Date.now() - this.launchedAt < Math.min(RETRY_MS * 2 ** this.launchFailures, RETRY_MAX_MS)) return;
    this.launchedAt = Date.now();
    this.beat(cx); // freshen the beat first: a stale one makes the helper exit at once
    cx.spawn(async (cx) => {
      const args = [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", `${modDir()}/launch.ps1`,
        "-AppHome", appHome(),
        "-ModDir", modDir(),
      ];
      let pid = null;
      let why = null;
      try {
        const out = await exec("powershell", args, { timeout: 20000 });
        const text = (out.stdout ?? "").trim();
        if (/^\d+$/.test(text)) pid = Number(text);
        else why = text || "(no output)";
      } catch (err) {
        why = err?.message ?? String(err);
      }
      if (pid === null) {
        this.launchFailures += 1;
        console.log("media: helper did not start:", why);
      } else {
        this.pid = pid;
        this.launchFailures = 0; // a launch that worked clears the offline row and the backoff
      }
      cx.notify(); // the row says why it is empty, so it follows either outcome
    });
  }

  read(cx) {
    this.syncParked(cx);
    if (this.parked) return;
    cx.spawn(async (cx) => {
      const body = await readTextFile(mediaFile("state.json")).catch(() => "");
      if (body === this.body) return;
      this.body = body;
      try {
        this.state = JSON.parse(body);
      } catch {
        this.state = null;
      }
      cx.notify();
    });
  }

  // The tick only has to prove the helper is alive inside TICK_STALE_S, so it gets a timer of its
  // own instead of riding along with every state read.
  alive(cx) {
    if (this.parked) return;
    cx.spawn(async (cx) => {
      const tick = await readTextFile(mediaFile("tick")).catch(() => "");
      // The one thing a timer must act on: a helper that is gone.
      if (Math.floor(Date.now() / 1000) - Number(tick) > TICK_STALE_S) this.spawnHelper(cx);
    });
  }

  // Bars only move while a track plays, and only when the bars are on screen: a folded
  // sidebar (< 160 px) does not draw them at all.
  readLevels(cx) {
    if (this.parked || !this.state?.playing || this.width < COMPACT_PX) return;
    cx.spawn(async (cx) => {
      const body = await readTextFile(mediaFile("levels.json")).catch(() => "");
      if (body === this.levelsBody) return;
      this.levelsBody = body;
      try {
        this.levels = JSON.parse(body).l ?? [];
      } catch {
        this.levels = [];
      }
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const session = Boolean(this.state?.session);
    const playing = Boolean(this.state?.playing);
    const offline = this.launchFailures >= OFFLINE_AFTER;
    const title = offline
      ? "Media helper offline"
      : session
        ? this.state.title || "Untitled"
        : "Nothing playing";
    const subtitle = offline ? "see mods/media/README.md" : session ? this.state.artist || "" : "";
    const compact = this.width < COMPACT_PX;

    const art = this.state?.cover
      ? image(this.state.cover).w(COVER_PX).h(COVER_PX).rounded(6).flex_none()
      : div().w(COVER_PX).h(COVER_PX).rounded(6).flex_none().bg(t.raised);

    const text = v_flex()
      .flex_1()
      .min_w(0)
      .gap(2)
      .child(
        div()
          .min_w(0)
          .overflow_x_hidden()
          .truncate()
          .text_size(12)
          .text_color(offline || !session ? t.dim : playing ? t.foreground : t.muted)
          .child(title),
      )
      .when(Boolean(subtitle), (el) =>
        el.child(
          div().min_w(0).overflow_x_hidden().truncate().text_size(10).text_color(t.muted).child(subtitle),
        ),
      );

    // Bars scale with the sidebar: each one is flex_1 of what the row has left.
    const bars = this.levels.length
      ? h_flex()
          .w_full()
          .h(BARS_H)
          .items_end()
          .gap(2)
          .children(
            this.levels.map((raw, i) => {
              const level = playing && !offline ? Math.min(1, Math.max(0, raw)) : 0;
              return div()
                .id(`band-${i}`)
                // GPUI eases the height between frames, so the data rate no longer sets how
                // smooth the bars look — and no redraw is needed to animate them.
                .transition("height", 80)
                .flex_1()
                .h(Math.max(1, Math.round(level * BARS_H)))
                .rounded(1)
                .bg(level > 0.06 ? t.accent : t.border);
            }),
          )
      : div().w_full().h(1).bg(t.border);

    return v_flex()
      .id("media")
      .size_full()
      .justify_center()
      .gap(6)
      .px(12)
      .on_size_change((size, cx) => {
        if (Math.round(size.width) === Math.round(this.width)) return;
        this.width = size.width;
        cx.notify();
      })
      .when(!compact, (el) => el.child(bars))
      .child(
        h_flex()
          .w_full()
          .items_center()
          .gap(10)
          .child(art)
          .when(!compact, (el) => el.child(text)),
      );
  }

  async stopHelper() {
    const pid = this.pid;
    this.pid = null;
    try {
      if (pid) await exec("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5000 });
      // A reload drops the pid. There is one helper per app home, so find it by what it runs.
      else {
        const find = [
          "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe' OR Name='python.exe'\"",
          `| Where-Object { $_.CommandLine -like '*helper.py*' -and $_.CommandLine -like '*${appHome()}*' }`,
          "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
        ].join(" ");
        await exec("powershell", ["-NoProfile", "-Command", find], { timeout: 15000 });
      }
    } catch {
      // Already gone, or it cannot be reached: a stale beat stops it within BEAT_STALE_S.
    }
  }

  async close(_cx) {
    await this.stopHelper();
  }
}
