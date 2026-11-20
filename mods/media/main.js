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
import { checking, layout, props, theme } from "herdr";
import { readText, writeFile } from "./state.js";
import { backoffMs, startHelper, stopHelper } from "./helper.js";
import { row } from "./ui.js";

const COMPACT_PX = 160; // below this the row is cover-only: no text, no bars
const READ_MS = 1000;
const LEVELS_MS = 120;
const BEAT_MS = 10000;
const TICK_STALE_S = 15; // the helper ticks every second
const OFFLINE_AFTER = 2; // failed launches before the row says why it is empty
const PROTOCOL_V = 1; // the state.json shape this mod reads; mirrors store.py's PROTOCOL_V

// What launch.ps1 answers when it cannot start the helper. Anything else is a real error to quote.
const REASON = { "no-python": "python is not installed", "no-deps": "module deps missing" };
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
    this.levelsBody = null;
    this.levels = [];
    this.width = 268;
    this.pid = null;
    this.expected = { beat: null, cmd: null }; // last body written for each file the mod owns
    this.launchedAt = 0;
    this.launchFailures = 0;
    this.why = null; // the launcher's answer when it could not start the helper
    this.parked = false;
    if (checking()) return;
    this.parked = this.hidden();
    if (!this.parked) this.spawnHelper(cx);
    cx.timer.every(READ_MS, (cx) => this.read(cx));
    cx.timer.every(5000, (cx) => this.alive(cx));
    cx.timer.every(LEVELS_MS, (cx) => this.readLevels(cx));
    cx.timer.every(BEAT_MS, (cx) => this.beat(cx));
    // A silent passage stops the bars, and with them the redraws the clock rides on.
    cx.timer.every(READ_MS, (cx) => {
      if (this.state?.playing && this.state?.dur > 0) cx.notify();
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
      }
    }
  }

  // The two files the mod owns: a heartbeat, and the transport clicks. writeTextFile needs the body
  // it expects to find, so each file is adopted first and dropped when a write loses that race.
  writeOwned(name, body, cx) {
    cx.spawn(async () => {
      if (this.expected[name] === null) this.expected[name] = await readText(name);
      try {
        await writeFile(name, body, this.expected[name]);
        this.expected[name] = body;
      } catch {
        this.expected[name] = null;
      }
    });
  }

  beat(cx) {
    if (this.parked) return;
    this.writeOwned("beat", String(Math.floor(Date.now() / 1000)), cx);
  }

  // A click goes to the helper, the only process that can talk to the player: it applies the click
  // and republishes state, so the row shows the player's answer rather than an assumption.
  send(action, cx) {
    if (this.parked) return;
    this.writeOwned("cmd", JSON.stringify({ n: Date.now(), do: action }), cx);
  }

  spawnHelper(cx) {
    if (Date.now() - this.launchedAt < backoffMs(this.launchFailures)) return;
    this.launchedAt = Date.now();
    this.beat(cx); // freshen the beat first: a stale one makes the helper exit at once
    cx.spawn(async (cx) => {
      const { pid, why } = await startHelper();
      this.why = pid === null ? why : null; // kept for the row: "no-python", "no-deps", or an error
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
      const body = await readText("state.json");
      if (body === this.body) return;
      this.body = body;
      try {
        this.state = JSON.parse(body);
      } catch {
        this.state = null;
      }
      this.posAt = Date.now();
      cx.notify();
    });
  }

  // The tick only has to prove the helper is alive inside TICK_STALE_S, so it gets a timer of its
  // own instead of riding along with every state read.
  alive(cx) {
    if (this.parked) return;
    cx.spawn(async (cx) => {
      const tick = await readText("tick");
      // The one thing a timer must act on: a helper that is gone.
      if (Math.floor(Date.now() / 1000) - Number(tick) > TICK_STALE_S) this.spawnHelper(cx);
    });
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
      cx.notify();
    });
  }

  render(_cx) {
    const t = theme();
    const session = Boolean(this.state?.session);
    const playing = Boolean(this.state?.playing);
    const offline = this.launchFailures >= OFFLINE_AFTER;
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

    // Buttons the helper would ignore are worse than none: an outdated payload has its own
    // sentence in the row instead.
    const transport = session && !offline && !stale;

    return row({
      t,
      compact: this.width < COMPACT_PX,
      offline,
      playing,
      session,
      title,
      subtitle,
      hint,
      cover: this.state?.cover,
      levels: this.levels,
      pos: elapsedPos(Number(this.state?.pos) || 0, playing ? Date.now() - this.posAt : 0),
      dur: Number(this.state?.dur) || 0,
      transport,
      onPrev: (cx) => this.send("prev", cx),
      onToggle: (cx) => this.send("toggle", cx),
      onNext: (cx) => this.send("next", cx),
      onWidth: (size, cx) => {
        if (Math.round(size.width) === Math.round(this.width)) return;
        this.width = size.width;
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
