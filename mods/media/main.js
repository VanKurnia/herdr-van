// Now playing, for the bottom of the sidebar: cover art, title and artist, over
// a small live spectrum.
//
// The WinRT and loopback-audio work lives in helper.py, started once as a hidden
// background process; this mod only reads what it publishes. Each file has one
// writer, because herdr's file write is a read-modify-write that needs the
// content it expects to find:
//   helper -> state.json, levels.json, tick, cover-*.png
//   mod    -> beat, whose staleness tells the helper the window is gone; cmd, a transport click
// close() kills the helper; a window that died without closing is caught by the
// beat going stale.
//
// This file is the view: the file protocol is state.js, the process lifecycle is
// helper.js, the row's pixels are ui.js.

import { View } from "gpui-kit";
import { appHome, checking, layout, props, theme, watchFolder } from "herdr";
import { readText, writeFile } from "./state.js";
import { backoffMs, startHelper, stopHelper } from "./helper.js";
import { row, bandOf } from "./ui.js";
import { Sky } from "./sky.js";

const COMPACT_PX = 160; // below this the row is cover-only: no text, no bars
const LEVELS_MS = 80;
const FRAME_MS = 33; // the sparks' own clock, while they are flying
const BEAT_MS = 10000;
const TICK_STALE_S = 15; // the helper ticks every second
const LAUNCH_GRACE_MS = 10000; // a fresh helper needs a few seconds to import winrt and tick
const STALE_RETRIES = 2; // relaunches before a helper that is up but wedged is reported
const OFFLINE_AFTER = 2; // failed launches before the row says why it is empty
const PROTOCOL_V = 1; // the state.json shape this mod reads; mirrors store.py's PROTOCOL_V
// state.json and a new cover are the only payloads worth re-reading: the watch
// batches everything in the folder, including tick, beat, cmd and helper.lock.
const STATE_FILES = /^(state\.json|cover-[0-9a-f]+\.png)$/;

// What launch.ps1 answers when it cannot start the helper. Anything else is a real error to quote.
const REASON = {
  "no-python": "python is not installed",
  "no-deps": "module deps missing",
  "helper not responding": "helper not responding",
};
const PIP =
  'python -m pip install --target "%USERPROFILE%\\.config\\herdr-app\\mods\\media\\vendor" winrt-runtime winrt-Windows.Media.Control winrt-Windows.Storage.Streams winrt-Windows.Foundation winrt-Windows.Storage soundcard numpy';

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

// The row's clock: the sample the player gave, plus what has passed since it was read, because a
// player's own position can lag or freeze. Zero means the player reports no position at all.
const elapsedPos = (base, sinceMs) => (base > 0 ? base + Math.max(0, sinceMs) / 1000 : 0);

export default class Media extends View {
  init(_props, cx) {
    this.body = null; // last state.json body, to skip identical reads
    this.state = null;
    // When the body just read was sampled: the player's own position can lag or freeze, so the row
    // counts from here between two bodies.
    this.posAt = 0;
    // The clock a track with no reported timeline falls back on.
    this.clockKey = null;
    this.clockAt = 0;
    this.levelsBody = null;
    this.levels = [];
    this.width = 268; // logical px, until the row reports its own size
    this.height = 268;
    this.pid = null;
    this.expected = { beat: null, cmd: null }; // last body written for each file the mod owns
    this.writing = {}; // one write in flight per file: two clicks must not race on one expectation
    this.staleRetries = 0; // launches since the helper last proved it was alive
    this.staleReported = false; // the current stale episode has been explained
    this.launchedAt = 0;
    this.launchFailures = 0;
    this.why = null; // why the helper is not answering: a launcher reason, or no answer at all
    this.parked = false;
    // What moves above the columns — sparks, peak caps, landings — has to outlive a render, so it
    // lives here rather than in ui.js.
    this.sky = new Sky();
    if (checking()) return;
    this.parked = this.hidden();
    if (!this.parked) this.spawnHelper(cx);
    this.read(cx); // a reload starts on an empty payload; a settled track writes nothing
    cx.timer.every(5000, (cx) => this.alive(cx));
    cx.timer.every(LEVELS_MS, (cx) => this.readLevels(cx));
    // Sparks and caps move at ~30 fps, but only while something is in flight: a still skyline costs
    // nothing. Nothing is handed to `.transition()` any more — this build does not tween it.
    cx.timer.every(FRAME_MS, (cx) => {
      if (this.sky.frame()) cx.notify();
    });
    cx.timer.every(BEAT_MS, (cx) => this.beat(cx));
    // Parking follows the layout, and a hidden copy keeps its timers: this tick is what
    // starts the helper again once the row is shown. A playing track also needs a redraw a
    // second for the clock, which no file event provides.
    cx.timer.every(1000, (cx) => {
      this.syncParked(cx);
      // A playing track needs a redraw a second for its clock, whether the player reports a length
      // or the row is counting one itself.
      if (this.state?.playing) cx.notify();
    });
    // state.json and a new cover are the only reasons to re-read the payload: levels.json,
    // tick, beat, cmd and helper.lock arrive in the same batches. Watch paths are absolute
    // with a `\\?\` prefix, so compare basenames only.
    cx.spawn(async (cx) => {
      const dir = `${appHome()}/data/media`;
      const base = (p) => p.split(/[\\/]/).pop();
      for (;;) {
        const changed = await watchFolder(dir);
        if (this.parked) continue; // parked: the watch still runs, nothing is read
        if (changed.some((p) => STATE_FILES.test(base(p)))) this.read(cx);
      }
    });
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
      if (hidden) {
        const pid = this.pid;
        this.pid = null;
        cx.spawn(() => stopHelper(pid));
      } else {
        this.launchedAt = 0; // this was a deliberate stop, not a failed launch
        this.spawnHelper(cx);
        this.read(cx); // nothing changed on disk while parked, so no watch event will
      }
    }
  }

  // The two files the mod owns: a heartbeat, and the transport clicks. writeTextFile needs the body
  // it expects to find, so each file is adopted first and dropped when a write loses that race, and
  // writes to one file are serialised: two clicks inside one round-trip would otherwise both read
  // the same expectation, and the loser's click would vanish.
  writeOwned(name, body, cx) {
    const run = async () => {
      if (this.expected[name] === null) this.expected[name] = await readText(name);
      try {
        await writeFile(name, body, this.expected[name]);
        this.expected[name] = body;
      } catch {
        this.expected[name] = null;
      }
    };
    const queued = (this.writing[name] ?? Promise.resolve()).then(run);
    this.writing[name] = queued;
    cx.spawn(() => queued);
  }

  // The bars, and with them the capture, are only worth paying for while the row is wide enough to
  // draw them, so the beat carries that answer and the helper stops draining the loopback for a
  // panel nobody can see.
  wantsBars() {
    return !this.parked && this.width >= COMPACT_PX;
  }

  beat(cx) {
    if (this.parked) return;
    this.writeOwned("beat", `${Math.floor(Date.now() / 1000)} ${this.wantsBars() ? 1 : 0}`, cx);
  }

  // A click goes to the helper, the only process that can talk to the player: it applies the click
  // and republishes state, so the row shows the player's answer rather than an assumption.
  send(action, cx) {
    if (this.parked) return;
    this.writeOwned("cmd", JSON.stringify({ n: Date.now(), do: action }), cx);
  }

  spawnHelper(cx) {
    if (Date.now() - this.launchedAt < backoffMs(this.launchFailures)) return false;
    this.launchedAt = Date.now();
    this.beat(cx); // freshen the beat first: a stale one makes the helper exit at once
    cx.spawn(async (cx) => {
      const { pid, why } = await startHelper();
      if (pid === null) {
        this.why = why; // kept for the row: "no-python", "no-deps", or a launcher's error
        this.launchFailures += 1;
        console.log("media: helper did not start:", why);
      } else {
        this.pid = pid;
        this.launchFailures = 0; // a launch that worked clears the offline row and the backoff
        // A launcher's reason is history once it starts, but a wedged helper's verdict is not:
        // this launch may have found that same wedged process still running.
        if (this.why !== "helper not responding") this.why = null;
      }
      cx.notify(); // the row says why it is empty, so it follows either outcome
    });
    return true;
  }

  read(cx) {
    if (this.parked) return;
    cx.spawn(async (cx) => {
      const body = await readText("state.json");
      if (body === this.body) return;
      this.body = body;
      try {
        this.state = JSON.parse(body);
      } catch {
        this.state = null;
      }
      this.posAt = Date.now();
      // A player that reports no timeline (streams often do: pos 0, dur 0) still needs a clock, so
      // the row counts from the moment this track first appeared. A player that does report one
      // keeps its own position, corrected for the lag since this body was read.
      const key = `${this.state?.title ?? ""}\u0000${this.state?.artist ?? ""}`;
      if (key !== this.clockKey) {
        this.clockKey = key;
        this.clockAt = this.posAt;
      }
      cx.notify();
    });
  }

  // The tick only has to prove the helper is alive inside TICK_STALE_S, so it gets a timer of its
  // own instead of riding along with every state read. A helper that stays stale through
  // STALE_RETRIES launches is up but wedged on a player call: worth saying once, but the launches
  // continue at the backoff's pace, because missing dependencies can arrive after the panel did.
  alive(cx) {
    if (this.parked) return;
    cx.spawn(async (cx) => {
      const tick = await readText("tick");
      if (Math.floor(Date.now() / 1000) - Number(tick) <= TICK_STALE_S) {
        // It answered: the episode is over, and a verdict from it is history. A launcher's own
        // reason stays until the next launch replaces it.
        this.staleRetries = 0;
        this.staleReported = false;
        if (this.why === "helper not responding") this.why = null;
        return;
      }
      // A helper launched a moment ago is still importing winrt and has not ticked yet. Only
      // launches that actually happened count, so a suppressed launch cannot burn the retries.
      if (Date.now() - this.launchedAt < LAUNCH_GRACE_MS) return;
      if (this.staleRetries < STALE_RETRIES) {
        if (this.spawnHelper(cx)) this.staleRetries += 1;
        return;
      }
      // A process that stopped ticking while it lives is either wedged on a player call or
      // running with its heartbeat thread gone. Either way it still holds the home's lock, so a
      // replacement cannot start until it is killed: relaunching finds it and reports its pid.
      if (!this.staleReported) {
        this.staleReported = true;
        if (this.launchFailures === 0) this.why = "helper not responding";
        cx.notify();
        await stopHelper(this.pid);
        this.pid = null;
      }
      this.spawnHelper(cx);
    });
  }

  // The band the skyline draws in, in px: the same numbers ui.js lays its own box out from.
  geom() {
    return bandOf(this.width, this.height);
  }

  // Bars only move while a track plays, and only when the bars are on screen: a folded
  // sidebar (< 160 px) does not draw them at all.
  readLevels(cx) {
    if (this.parked || !this.state?.playing || this.width < COMPACT_PX) return;
    cx.spawn(async (cx) => {
      const body = await readText("levels.json");
      if (body === this.levelsBody) return;
      this.levelsBody = body;
      try {
        this.levels = JSON.parse(body).l ?? [];
      } catch {
        this.levels = [];
      }
      // Every new reading is also where a hit is heard and thrown.
      this.sky.read(this.levels, Boolean(this.state?.playing), { ...this.geom(), t: theme() });
      cx.notify();
    });
  }

  render(_cx) {
    const t = theme();
    const session = Boolean(this.state?.session);
    const playing = Boolean(this.state?.playing);
    const offline = this.launchFailures >= OFFLINE_AFTER || this.staleRetries >= STALE_RETRIES;
    // A helper that predates this field (or a future one) keeps running until it exits: it is a
    // separate process, so the on-disk code can be newer than the payload being served.
    const stale = Boolean(this.state) && this.state.v !== PROTOCOL_V;
    const title = offline
      ? "Media helper offline"
      : session
        ? this.state.title || "Untitled"
        : "Nothing playing";
    const subtitle = offline
      ? REASON[this.why] ?? "helper could not start"
      : stale
        ? "helper outdated — restart it"
        : session
          ? this.state.artist || ""
          : "";
    // Only the dependency case has an action worth carrying; the other two are already sentences.
    const hint = offline && this.why === "no-deps" ? PIP : "";

    // A player that reports a position gets the row's own clock correction; one that reports none
    // (streams often send 0 for both) gets the time since this track appeared.
    const reported = Number(this.state?.pos) || 0;
    const pos =
      reported > 0
        ? elapsedPos(reported, playing ? Date.now() - this.posAt : 0)
        : playing && this.clockAt
          ? (Date.now() - this.clockAt) / 1000
          : 0;

    // Buttons the helper would ignore are worse than none: an outdated payload has its own
    // sentence in the row instead.
    const transport = session && !offline && !stale;

    return row({
      t,
      offline,
      playing,
      session,
      title,
      subtitle,
      hint,
      cover: this.state?.cover,
      levels: this.levels,
      pos,
      dur: Number(this.state?.dur) || 0,
      transport,
      hovered: this.hovered,
      width: this.width,
      height: this.height,
      sky: this.sky,
      onPrev: (cx) => this.send("prev", cx),
      onToggle: (cx) => this.send("toggle", cx),
      onNext: (cx) => this.send("next", cx),
      onHover: (on, cx) => {
        if (on === this.hovered) return;
        this.hovered = on;
        cx.notify();
      },
      onSize: (size, cx) => {
        const w = Math.round(size.width);
        const h = Math.round(size.height);
        if (w === Math.round(this.width) && h === Math.round(this.height)) return;
        const before = this.wantsBars();
        this.width = w;
        this.height = h;
        // A width change is the only moment the answer can flip, so the beat goes out at once
        // rather than up to a beat late.
        if (this.wantsBars() !== before) this.beat(cx);
        cx.notify();
      },
    });
  }

  async close(_cx) {
    const pid = this.pid;
    this.pid = null;
    await stopHelper(pid);
  }
}
