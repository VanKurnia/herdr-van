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
import { appHome, checking, layout, nextCommand, props, setShared, settings, theme, watchFolder, window, writeTextFile } from "herdr";
import { readText, writeFile } from "./state.js";
import { backoffMs, startHelper, stopHelper } from "./helper.js";
import { row, bandOf, artShape, HEAD_PAD } from "./ui.js";
import { Sky } from "./sky.js";

const COMPACT_PX = 160; // below this the row is cover-only: no text, no bars
const REST_GAIN = 0.5; // the art's weight with no voice to follow: half way between floor and full
const LEVELS_MS = 40; // the row's clock: it advances the sky and draws it, and that used to be 80 ms.
// The bars arrive on the helper's writes, so 80 only set how often the *motion* between readings
// moved — the caps sinking, the sparks flying, the beat swell fading. At 12.5 Hz those read as a
// stutter, which is what a spectrum looks like when it is "not synced with the song": the notes were
// landing at 21 Hz while everything that moved was stepping at 12.5. Measured, 25 ms costs a few
// percent of the app's CPU only while something is actually moving, because frame() reports still and
// the notify is skipped.
const FRAME_MS = 66; // the sparks' clock; each frame repaints the whole window
const BEAT_MS = 10000;
const TICK_STALE_S = 15; // the helper ticks every second
const LAUNCH_GRACE_MS = 10000; // a fresh helper needs a few seconds to import winrt and tick
const STALE_RETRIES = 2; // relaunches before a helper that is up but wedged is reported
const OFFLINE_AFTER = 2; // failed launches before the row says why it is empty
const PROTOCOL_V = 1; // the state.json shape this mod reads; mirrors store.py's PROTOCOL_V
const AUDIO_WHY = "audio: "; // marks a reason the audio thread published, so a launcher's is never mistaken for one
// The helper writes levels.json at most every 25 ms: a watch event is the read trigger, so a tick
// that has nothing new reads nothing. state.json and the cover are the payloads the row re-reads;
// levels.json is the stream; tick, beat, cmd and helper.lock are pulses nothing here acts on.
const STATE_FILES = /^(state\.json|cover-[0-9a-f-]+\.png)$/;
const LEVELS_FILE = /^levels\.json$/;

// What launch.ps1 answers when it cannot start the helper. Anything else is a real error to quote.
const REASON = {
  "no-python": "python is not installed",
  "no-deps": "module deps missing",
  "helper not responding": "helper not responding",
};
const PIP =
  'python -m pip install --target "%USERPROFILE%\\.config\\herdr-app\\mods\\media\\vendor" winrt-runtime winrt-Windows.Media.Control winrt-Windows.Storage.Streams winrt-Windows.Foundation winrt-Windows.Storage soundcard numpy Pillow';

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
    this.voice = 0.5; // the helper's read of whether a singer owns the mix, 0..1
    this.gain = REST_GAIN; // the art's breath: 0 at its floor, 1 fully opaque, REST_GAIN at rest
    this.gainAt = 0; // when `gain` last moved, so the attack and release are time-based
    this.base = null; // the voice level this passage has been at, for the swell to be relative to
    this.breathKey = null; // the track the breath belongs to: a new one starts from rest
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
    this.nowBody = null; // the transport body last published for the footer
    this.headW = 0; // the header row, in window px: what the label's box is cut from
    this.textW = 0; // the label unclipped, which is what says how far it has to travel
    // Whether the sky is mid-motion, so a level reading need not ask for a frame of its own.
    this.skyMoving = false;
    // What moves above the columns — sparks, peak caps, landings — has to outlive a render, so it
    // lives here rather than in ui.js.
    this.sky = new Sky();
    if (checking()) return;
    this.parked = this.hidden();
    if (!this.parked) this.spawnHelper(cx);
    this.read(cx); // a reload starts on an empty payload; a settled track writes nothing
    cx.timer.every(5000, (cx) => this.alive(cx));
    // The sidebar footer draws the transport, and it cannot read this mod's payload: the few numbers it
    // needs are published here, once a second, and only when they change.
    cx.timer.every(1000, () => this.publishNow());
    // "prev" | "toggle" | "next", from the footer's buttons.
    cx.spawn(async (cx) => {
      for (;;) {
        const name = await nextCommand();
        if (name === "prev" || name === "toggle" || name === "next") this.send(name, cx);
      }
    });
    // One clock for the row: this tick advances the sky and draws it; it does not read the level
    // file, because the watch does that when the helper actually writes. A reading that would paint
    // the frame already on screen asks for nothing.
    cx.timer.every(LEVELS_MS, (cx) => {
      if (!this.presenting()) return;
      this.skyMoving = this.sky.frame();
      if (this.skyMoving) cx.notify();
    });
    cx.timer.every(BEAT_MS, (cx) => this.beat(cx));
    // Parking follows the layout, and a hidden copy keeps its timers: this tick is what
    // starts the helper again once the row is shown. A playing track also needs a redraw a
    // second for the clock, which no file event provides.
    cx.timer.every(1000, (cx) => {
      this.syncParked(cx);
      // A playing track needs a redraw a second for its clock, whether the player reports a length
      // or the row is counting one itself — but not for a window nobody is looking at, whose
      // redraw costs the same as a visible one.
      if (this.state?.playing && this.presenting()) cx.notify();
    });
    // state.json, the cover and a new levels.json are the reasons to re-read something: tick, beat,
    // cmd and helper.lock arrive in the same batches. Watch paths are absolute with a `\\?\` prefix,
    // so compare basenames only. Reading levels on the write instead of on a clock is what makes the
    // stream event-driven: no tick reads a file the helper did not just write.
    cx.spawn(async (cx) => {
      const dir = `${appHome()}/data/media`;
      const base = (p) => p.split(/[\\/]/).pop();
      for (;;) {
        const changed = await watchFolder(dir);
        if (this.parked) continue; // parked: the watch still runs, nothing is read
        const names = changed.map(base);
        if (names.some((n) => STATE_FILES.test(n))) this.read(cx);
        if (names.some((n) => LEVELS_FILE.test(n))) this.readLevels(cx);
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
  // The art is drawn as a square as big as the taller of the band's width and the row's height, in
  // window px. Publishing that number is what lets the helper encode the cover at the size it is
  // actually drawn, so it is sharp at any sidebar width and zoom without shipping a full image.
  wantsArt(px, cut, shape_span, cx) {
    const want = Math.max(64, Math.min(512, Math.round(px / 8) * 8));
    // The only writer of this file, so a value that has not changed still has to go out once: a
    // deleted art.json would otherwise leave the helper on its defaults for the rest of the session.
    const share = Math.round(Math.max(0, Math.min(0.5, cut || 0)) * 1000) / 1000;
    const span = Math.round(Math.max(0.05, Math.min(1, shape_span || 1)) * 1000) / 1000;
    if (want === this.artPx && share === this.artCut && span === this.artSpan && this.artPublished) return;
    this.artPx = want;
    this.artCut = share;
    this.artSpan = span;
    this.artPublished = true;
    if (this.parked || checking()) return;
    cx.spawn(async () => {
      await writeTextFile(`${appHome()}/data/media/art.json`, JSON.stringify({ px: want, cut: share, span }));
    });
  }

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
        // this launch may have found that same wedged process still running. Neither is the audio
        // thread's: only a payload that stops carrying it clears that one.
        if (this.why !== "helper not responding" && !this.why?.startsWith(AUDIO_WHY)) this.why = null;
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
      // The audio thread reports its failure inside the same body, because it cannot write one of
      // its own without blanking the track fields. A launcher's reason is left alone: only a reason
      // this read set is cleared by its absence.
      const audio = typeof this.state?.audio === "string" && this.state.audio;
      if (audio) this.why = AUDIO_WHY + audio;
      else if (this.why?.startsWith(AUDIO_WHY)) this.why = null;
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

  // Whether the app's window is on screen at all: a hidden copy keeps its timers, and a redraw of a
  // minimized window costs what a visible one does. `window()` is null where there is no window.
  presenting() {
    return window()?.visible !== false;
  }

  // Bars only move while a track plays, and only when the bars are on screen: a folded
  // sidebar (< 160 px) does not draw them at all. Called by a watch event for a new levels.json,
  // not by the frame clock.
  readLevels(cx) {
    if (!this.active()) {
      // Nothing is being read, so the art settles back to rest instead of holding the last chorus.
      const was = this.gain;
      this.breathe();
      if (Math.abs(this.gain - was) > 0.002) cx.notify();
      return;
    }
    cx.spawn(async (cx) => {
      const body = await readText("levels.json");
      if (body === this.levelsBody) return;
      this.levelsBody = body;
      try {
        const payload = JSON.parse(body);
        this.levels = payload.l ?? [];
        this.voice = typeof payload.v === "number" ? payload.v : 0.5;
      } catch {
        // Keep the last good reading rather than blanking the skyline: a parse that fails is this
        // reader's problem, not the absence of sound.
      }
      // Every new reading is also where a hit is heard and thrown.
      this.sky.read(this.levels, Boolean(this.state?.playing), {
        ...this.geom(),
        t: theme(),
        key: this.state?.session ?? null,
      });
      this.breathe();
      // Only ask for a frame when the sky is still: mid-flight, the frame clock draws within one
      // frame interval anyway, so a second notify per reading repaints the window for nothing.
      // Still is not the same as changed, though: a reading that rounds to the same bars and the
      // same art alpha would repaint the window with the picture it already shows. Compare what
      // would be *painted* — one pixel per step of bar height, one step of opacity — and skip that.
      const painted = this.painted();
      const same = painted === this.paintedSig;
      this.paintedSig = painted;
      if (!this.skyMoving && !same) cx.notify();
    });
  }

  // What the next frame would draw, at the resolution the frame can show it: each band in whole
  // pixels of bar height, the art's weight in whole 1/255 of opacity. Two readings that agree here
  // are the same picture, so a notify would only repaint the window with what it already shows.
  painted() {
    const { width, height } = this.geom();
    const barH = Math.max(1, bandOf(width, height).barH);
    const bars = (this.levels ?? []).map((level) => Math.round((level ?? 0) * barH)).join(",");
    return `${bars}|${Math.round(this.gain * 255)}|${this.state?.playing ? 1 : 0}`;
  }

  // Whether the row has sound to draw: playing, on screen, and wide enough to show the bars at all.
  active() {
    return !this.parked && this.presenting() && Boolean(this.state?.playing) && this.width >= COMPACT_PX;
  }

  // The artwork breathes with the voice: an envelope follower over the helper's voice score, fast to
  // rise and slow to fall — how a game drives a light from an audio level without it strobing with
  // every syllable. Leaves the art's weight in `this.gain`, 0 at its floor and 1 fully opaque.
  breathe() {
    const now = Date.now();
    const dt = Math.min(250, Math.max(0, now - this.gainAt));
    this.gainAt = now;
    // A new track is a new breath: keep the old passage's baseline and the first few seconds of the
    // next song would be spent chasing a level it never had.
    const key = this.state?.session ?? null;
    if (key !== this.breathKey) {
      this.breathKey = key;
      this.base = null;
    }
    // Held still: nothing playing, folded to the rail, no window. The art settles to its rest weight
    // rather than freezing wherever the last chorus left it.
    if (!this.active()) {
      this.base = null;
      this.gain += (REST_GAIN - this.gain) * Math.min(1, dt / 600);
      return;
    }
    // The helper's voice score, not the vocal band: a guitar solo in the same octaves must not breathe
    // the art as if it were singing.
    const heard = this.voice;
    // Relative to how loud the voice has been in this passage, not to an absolute number: only a swell
    // above its own baseline should move the art. A ~3 s average, so it follows a passage, not a word.
    if (this.base === null) this.base = heard;
    else this.base += (heard - this.base) * Math.min(1, dt / 3000);
    const swell = (heard - this.base) / Math.max(0.06, this.base * 0.4);
    const target = Math.max(0, Math.min(1, REST_GAIN + swell * REST_GAIN));
    // Fast to rise, slow to fall: the asymmetry is what reads as breathing rather than flicker.
    const step = Math.min(1, dt / (target > this.gain ? 90 : 700));
    this.gain += (target - this.gain) * step;
  }

  // Where the track is now: the player's own position, corrected by the time since it was sampled, or
  // the time since it appeared when the player reports no position at all (streams often send zero).
  position() {
    const reported = Number(this.state?.pos) || 0;
    if (reported > 0) return elapsedPos(reported, this.state?.playing ? Date.now() - this.posAt : 0);
    return this.state?.playing && this.clockAt ? (Date.now() - this.clockAt) / 1000 : 0;
  }

  // What the footer's transport draws, in the one place both mods can read. Buttons the helper would
  // ignore are worse than none, so an outdated payload publishes itself as idle.
  publishNow() {
    const now = {
      session: Boolean(this.state?.session),
      playing: Boolean(this.state?.playing),
      stale: Boolean(this.state) && this.state.v !== PROTOCOL_V,
      pos: Math.round(this.position()),
      dur: Math.round(Number(this.state?.dur) || 0),
    };
    const body = JSON.stringify(now);
    if (body === this.nowBody) return;
    this.nowBody = body;
    setShared("media.now", now);  }

  // A label too long for the header scrolls itself; one that fits sits still. The travel is the
  // measured overflow of the box the header actually offers, and the pass is slow enough to read.
  marquee() {
    const zoom = settings().zoom || 1;
    const box = Math.max(40, Math.round(this.headW / zoom) - HEAD_PAD);
    const travel = Math.max(0, Math.round(this.textW / zoom) - box);
    return { travel, box, period: Math.max(4000, Math.round(travel * 70)) };
  }

  // The header measurements, in window px; a size that has not changed costs nothing.
  measured(field, width, cx) {
    const next = Math.round(width);
    if (next === this[field]) return;
    this[field] = next;
    cx.notify();
  }

  render(_cx) {
    const t = theme();
    const session = Boolean(this.state?.session);
    const playing = Boolean(this.state?.playing);
    const offline = this.launchFailures >= OFFLINE_AFTER || this.staleRetries >= STALE_RETRIES;
    // A dead audio thread leaves a running helper that never reaches OFFLINE_AFTER: the reason is
    // the only thing that tells the flat row apart from a paused track.
    const audioWhy = this.why?.startsWith(AUDIO_WHY) ? this.why.slice(AUDIO_WHY.length) : "";
    // A helper that predates this field (or a future one) keeps running until it exits: it is a
    // separate process, so the on-disk code can be newer than the payload being served.
    const stale = Boolean(this.state) && this.state.v !== PROTOCOL_V;
    const title = offline
      ? "Media helper offline"
      : session
        ? this.state.title || "Untitled"
        : "Nothing playing";
    const subtitle = audioWhy
      ? audioWhy
      : offline
        ? REASON[this.why] ?? "helper could not start"
        : stale
          ? "helper outdated — restart it"
          : session
            ? this.state.artist || ""
            : "";
    // Only the dependency case has an action worth carrying; the other two are already sentences.
    const hint = offline && this.why === "no-deps" ? PIP : "";

    return row({
      t,
      offline,
      playing,
      title,
      subtitle,
      hint,
      cover: this.state?.cover,
      artGain: this.gain,
      levels: this.levels,
      hovered: this.hovered,
      marquee: this.marquee(),
      onText: (w, cx) => this.measured("textW", w, cx),
      onHeader: (w, cx) => this.measured("headW", w, cx),
      width: this.width,
      height: this.height,
      sky: this.sky,
      onHover: (on, cx) => {
        if (on === this.hovered) return;
        this.hovered = on;
        cx.notify();
      },
      onSize: (size, cx) => {
        // `on_size_change` counts window px; this row draws in logical px.
        const zoom = settings().zoom;
        const w = Math.round(size.width / zoom);
        const h = Math.round(size.height / zoom);
        if (w === Math.round(this.width) && h === Math.round(this.height)) return;
        const before = this.wantsBars();
        const shape = artShape(w, h);
        this.wantsArt(Math.round(shape.side * zoom), shape.cut, shape.span, cx);
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
