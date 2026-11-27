// The skyline and what moves over it, after the afterhours layout's equaliser: a dot matrix whose
// columns follow the bands (low on the left, high on the right, in this mod's own tones), a dim cap
// that marks each column's recent peak and sinks, and dots thrown off the skyline when the music
// hits.
//
// The motion is computed here, frame by frame, rather than handed to `.transition()`: in this build
// a transition does not tween — an element given a new position appears there — so every position
// below is a function of the clock, and the row is redrawn only while something is in flight.
import { div, PathBuilder, Background } from "gpui-kit";
import { h_flex } from "gpui-base";
import { palette, blend } from "./ui.js";

const DOT = 4; // px: even, so a mark's centre lands on a whole pixel and no column is half-lit
const GUTTER = 4; // half the row's 8 px gutter: `justify_between` adds its share beside each spacer
const PITCH_X = 6; // column pitch: even with DOT, so every mark covers whole pixels
const PITCH_Y = 6; // row pitch
const BASE = 10; // the skyline stands this far above the band's bottom edge
const POOL = 14; // sparks in flight at once, two dots each
const TAIL_MS = 55; // how far a spark's trail follows behind it
const LAND_MS = 150; // how long the dot that lands lingers before it goes
const CAP_SINK = 0.5; // px a peak cap falls per 80 ms
const LIFT = 0.7; // the curve the level is raised by, so a column is as tall as it looks in the mix
const SWELL = 0.22; // how much the beat swells the whole skyline
const ZONES = 8; // shared paths: the tips are gathered into this many colour zones
const BODY_ZONES = 24; // the columns' own colour steps: finer than the tips, so the ramp stays smooth

// The bands each voice listens to, its floor (our levels are 0..1), how much of a rise counts as a
// hit, how many sparks a hit throws and how far they rise. Our helper smooths each band before
// publishing it, so a hit is a modest rise over the usual level (about 10 %), not the 35 %
// afterhours can look for on raw levels.
const VOICES = [
  { key: "bass", from: 1, to: 7, floor: 0.35, ratio: 1.09, jump: 0.05, quiet: 300, count: 5, reach: 2 },
  { key: "mid", from: 10, to: 17, floor: 0.3, ratio: 1.05, jump: 0.03, quiet: 380, count: 3, reach: 3 },
  { key: "treble", from: 19, to: 26, floor: 0.2, ratio: 1.07, jump: 0.03, quiet: 380, count: 2, reach: 4 },
];

// A column's pixel height for a number of dots: the gaps between rows are real space, and they are
// what make the columns a matrix rather than a bar.
const heightOf = (dots) => dots * PITCH_Y - (PITCH_Y - DOT);

// A hop slows into its apex and speeds up out of it, which is what draws an arc rather than a
// triangle.
const easeOut = (p) => 1 - (1 - p) * (1 - p);
const easeIn = (p) => p * p;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export class Sky {
  constructor() {
    this.cols = 0;
    this.used = []; // dots per column, the one reading the columns, the caps and the sparks share
    this.caps = []; // px height of each column's recent peak
    this.flash = []; // per column: 1 just after a spark lands there, fading
    this.sparks = Array.from({ length: POOL }, (_, k) => ({ k, state: "idle" }));
    this.usual = {}; // each voice's recent level, so a hit reads as a rise rather than loudness
    this.quietAt = {}; // the earliest time each voice may throw again
    this.track = null; // the track the baselines belong to
    this.pulse = 0; // the beat swell, 1 on a hit and fading
    this.beat = 500; // the bass's own interval, folded in over a few hits
    this.lastBass = 0;
  }

  // How many dots each column stands for. One reading feeds everything: the columns draw from it,
  // the caps sink to it and the sparks leave from its top.
  measure(levels, { width, barH }, live) {
    const n = levels.length;
    const cols = Math.max(8, Math.floor(width / PITCH_X));
    const rows = Math.max(2, Math.min(12, Math.floor((barH - BASE - PITCH_Y - 4) / PITCH_Y)));
    this.cols = cols;
    // The columns stand on a PITCH_X grid and the ink of the first one starts at the grid's own left
    // edge, so a band that is not a whole number of pitches wide leaves a remainder: it is split
    // between the two sides, and the skyline sits centred instead of pushed left with a gap on the
    // right. The columns and the sparks both read this one offset, so a spark still lands on its
    // column. Floored to a whole pixel, and the dots start on an even one, so no dot is half-lit.
    this.offX = Math.max(0, Math.floor((width - ((cols - 1) * PITCH_X + DOT)) / 2));
    this.used = Array.from({ length: cols }, (_, c) => {
      if (!live) return 1;
      const p = (c / (cols - 1)) * (n - 1);
      const i = Math.floor(p);
      const a = levels[i] ?? 0;
      const b = levels[Math.min(n - 1, i + 1)] ?? a;
      const level = clamp01(a + (b - a) * (p - i)) ** LIFT * (1 + SWELL * this.pulse);
      return Math.max(1, Math.round(clamp01(level) * rows));
    });
  }

  // Called on every new level reading (12.5 Hz): how tall the columns are, where the caps are, and
  // what to throw.
  read(levels, playing, { width, barH, t, key = null }) {
    const live = playing && levels.length > 1;
    // A new track is measured from scratch: the voices' baselines are that song's, not the last one's.
    if (key !== this.track) {
      this.track = key;
      this.usual = {};
      this.quietAt = {};
    }
    this.measure(levels, { width, barH }, live);
    if (!live) {
      for (const s of this.sparks) s.state = "idle";
      this.caps = new Array(this.cols).fill(0);
      this.flash = new Array(this.cols).fill(0);
      // The voices' own baselines go too: kept across a pause, the first reading after it is measured
      // against a level from another song and throws a burst nothing played.
      this.usual = {};
      this.quietAt = {};
      return;
    }

    const now = Date.now();
    if (this.caps.length !== this.cols) {
      this.caps = new Array(this.cols).fill(0);
      this.flash = new Array(this.cols).fill(0);
    }
    for (let c = 0; c < this.cols; c++) {
      this.caps[c] = Math.max(heightOf(this.used[c]), this.caps[c]);
    }

    const n = levels.length;
    for (const voice of VOICES) {
      let sum = 0;
      for (let b = voice.from; b <= voice.to; b++) sum += levels[b] ?? 0;
      const value = sum / (voice.to - voice.from + 1);
      const usual = this.usual[voice.key] ?? value;
      this.usual[voice.key] = usual + (value - usual) * 0.12;
      if (this.quietAt[voice.key] > now) continue;
      // A hit is a rise over what this voice has been doing, by ratio or by a small absolute step:
      // loud steady passages throw nothing, and the ratio alone misses quiet voices in a dense mix.
      const risen = value >= usual * voice.ratio || value - usual >= voice.jump;
      if (value < voice.floor || !risen) continue;
      this.quietAt[voice.key] = now + voice.quiet;
      if (voice.key === "bass") {
        this.pulse = 1;
        if (this.lastBass && now - this.lastBass > 240 && now - this.lastBass < 1400) {
          this.beat = this.beat * 0.7 + (now - this.lastBass) * 0.3;
        }
        this.lastBass = now;
      }
      // The burst leaves together, spread over a few milliseconds so it reads as a splash rather
      // than one dot at a time.
      for (let k = 0; k < voice.count; k++) {
        this.spawn(voice, levels, { barH }, now + k * 18, t);
      }
    }
  }

  // Called ~30 times a second: ages the caps, the flashes and the sparks, and reports whether
  // anything is still in flight so the caller knows to redraw.
  frame() {
    const now = Date.now();
    let moving = false;
    if (this.pulse > 0) {
      this.pulse = Math.max(0, this.pulse - 0.055);
      moving = true;
    }
    for (let c = 0; c < this.caps.length; c++) {
      const floor = heightOf(this.used[c] ?? 1);
      if (this.caps[c] > floor) {
        this.caps[c] = Math.max(floor, this.caps[c] - CAP_SINK);
        moving = true;
      }
      if (this.flash[c] > 0) {
        this.flash[c] = Math.max(0, this.flash[c] - 0.09);
        moving = true;
      }
    }
    for (const s of this.sparks) {
      if (s.state === "idle") continue;
      const age = now - s.startAt;
      if (age > 2 * s.hop + LAND_MS) {
        s.state = "idle";
        continue;
      }
      if (s.state !== "lit" && age > 2 * s.hop) {
        s.state = "lit";
        this.flash[s.landCol] = 1;
      }
      moving = true;
    }
    return moving;
  }

  // Where a spark is now: up the arc, down the other side, or resting where it landed.
  pos(s, now) {
    const up = clamp01((now - s.startAt) / s.hop);
    if (up < 1) {
      return { x: s.x0 + (s.mx - s.x0) * up, y: s.y0 + (s.my - s.y0) * easeOut(up), rising: true };
    }
    const down = clamp01((now - s.startAt - s.hop) / s.hop);
    return { x: s.mx + (s.x1 - s.mx) * down, y: s.my + (s.y1 - s.my) * easeIn(down), rising: false };
  }

  // A spark leaves the top of a column in the voice's range, arcs up and across, and comes down on
  // another column, so the tops of the arcs trace the shape of the skyline.
  spawn(voice, levels, { barH }, at, t) {
    const s = this.sparks.find((p) => p.state === "idle");
    if (!s) return;
    const n = levels.length;
    const band = voice.from + Math.random() * (voice.to - voice.from);
    const columnOf = (b) => Math.round((b / (n - 1)) * (this.cols - 1));
    const from = columnOf(band);
    const to = Math.min(this.cols - 1, Math.max(0, from + pick([-3, -2, -1, 1, 2, 3])));
    const offX = this.offX ?? 0; // the same shift the columns are drawn at
    s.state = "up";
    s.startAt = at;
    s.hop = Math.max(150, Math.min(320, this.beat / 2)); // half a beat, once the bass has told us
    s.landCol = to;
    s.x0 = offX + from * PITCH_X;
    s.y0 = barH - BASE - heightOf(this.used[from]);
    // The apex sits between the two columns, one to `reach` rows above the taller of them, and never
    // at the very top of the band: the burst would just smear along that edge.
    s.mx = Math.round(offX + ((from + to) / 2) * PITCH_X);
    s.my = Math.max(
      PITCH_Y,
      Math.min(s.y0, barH - BASE - heightOf(this.used[to])) - (1 + Math.round(Math.random() * voice.reach)) * PITCH_Y,
    );
    s.x1 = offX + to * PITCH_X;
    s.y1 = barH - BASE - heightOf(this.used[to]);
    s.color = palette(n, t)(band);
    s.bright = blend(s.color, "#ffffff", 0.35); // the newest event is the brightest thing on screen
  }

  // The whole skyline: the columns, their lit tips, the caps, the landing flashes and the sparks.
  el(t, { width, barH, levels, playing, offline }) {
    const n = levels.length;
    // Before any reading the bands are unknown: a dim dotted baseline, which is what a check renders.
    // The gutters are flex spacers, not insets: `right()` and the right half of a padding are dropped
    // on an absolutely positioned layer.
    if (n < 2) {
      return h_flex()
        .id("spectrum")
        .size_full()
        .items_end()
        .justify_between()
        .pb(BASE)
        .children([
          div().flex_none().w(GUTTER).h(DOT),
          ...Array.from({ length: 48 }, (_, c) =>
            div().id(`base-${c}`).flex_none().w(DOT).h(DOT).bg(t.border).opacity(0.5),
          ),
          div().flex_none().w(GUTTER).h(DOT),
        ]);
    }

    const live = playing && !offline;
    const cols = this.cols;
    // The offset `measure` worked out for these columns: the sparks carry the same one, so their
    // tops still line up with the columns they left and landed on.
    const offX = this.offX ?? 0;
    const paint = globalThis.window;
    const tone = palette(n, t);
    const out = [];
    // The lit pixel, the cap and the flash were three elements per column — about 900 at a wide
    // window. They are gathered into a few shared paths below: one per colour zone for the columns,
    // because their colour follows the frequency, and one each for the caps and the flash.
    const bodies = []; // one dashed path per colour zone: the columns of that shade in one path
    const tips = [];
    let caps = null;
    let flashes = null;
    let topFlash = 0;
    const baseline = barH - BASE;
    for (let c = 0; c < cols; c++) {
      const dots = this.used[c] ?? 1;
      const h = heightOf(dots);
      const x = offX + c * PITCH_X + DOT / 2;
      const zone = Math.min(ZONES - 1, Math.floor((c / Math.max(1, cols - 1)) * ZONES));
      const body = Math.min(BODY_ZONES - 1, Math.floor((c / Math.max(1, cols - 1)) * BODY_ZONES));
      // One dashed line instead of one quad per dot: the dashes are the dots. Drawn from the column's
      // own top, and two pixels past the baseline so its length is a whole number of dash periods:
      // the dasher carries its phase from one subpath to the next, so unequal lengths would walk the
      // dot rows out of line column by column. The tail sits where the fade is already transparent.
      bodies[body] ??= PathBuilder.stroke(DOT).dash_array([DOT, PITCH_Y - DOT]);
      bodies[body].add_polygon([[x, baseline - h], [x, baseline + (PITCH_Y - DOT)]], false);
      // A lighter pixel caps a column with more than one, so the outline reads as a lit edge.
      if (live && dots > 1) {
        const tipY = baseline - h;
        tips[zone] ??= PathBuilder.fill();
        tips[zone].add_polygon(
          [[x - DOT / 2, tipY], [x + DOT / 2, tipY], [x + DOT / 2, tipY + DOT], [x - DOT / 2, tipY + DOT]],
          true,
        );
      }
      if (!live) continue;
      const cap = this.caps[c] ?? 0;
      if (cap > h + 4) {
        const capY = baseline - cap - PITCH_Y;
        caps ??= PathBuilder.fill();
        caps.add_polygon(
          [[x - DOT / 2, capY], [x + DOT / 2, capY], [x + DOT / 2, capY + DOT], [x - DOT / 2, capY + DOT]],
          true,
        );
      }
      const flash = this.flash[c] ?? 0;
      if (flash > 0.05) {
        const flashY = baseline - h;
        flashes ??= PathBuilder.fill();
        flashes.add_polygon(
          [[x - DOT / 2, flashY], [x + DOT / 2, flashY], [x + DOT / 2, flashY + DOT], [x - DOT / 2, flashY + DOT]],
          true,
        );
        topFlash = Math.max(topFlash, flash);
      }
    }

    // One element per colour zone, not one per column: about eighty painted pieces become eight.
    // The fade runs over the band rather than each column's own box, so brightness follows absolute
    // height — a tip is what keeps a short column lit at its top.
    for (let z = 0; z < BODY_ZONES; z += 1) {
      const path = bodies[z];
      if (!path) continue;
      const away = Math.abs((z + 0.5) / BODY_ZONES - 0.5) * 2;
      const edge = (live ? 1 : 0.3) * (1 - 0.45 * away * away);
      const color = tone(((z + 0.5) / BODY_ZONES) * (n - 1));
      const shade = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#ffffff";
      out.push(
        paint
          .paint_path(path.build(), Background.linear_gradient(180, shade, `${shade}00`).opacity(edge))
          .id(`cols-${z}`)
          .absolute()
          .left(0)
          .top(0)
          .w(width)
          .h(barH),
      );
    }

    for (let z = 0; z < ZONES; z += 1) {
      const path = tips[z];
      if (!path) continue;
      const color = blend(tone(((z + 0.5) / ZONES) * (n - 1)), "#ffffff", 0.3);
      out.push(
        paint
          .paint_path(path.build(), color)
          .id(`tips-${z}`)
          .absolute()
          .left(0)
          .top(0)
          .w(width)
          .h(barH)
          .opacity(0.95),
      );
    }
    if (caps) {
      out.push(
        paint
          .paint_path(caps.build(), t.border)
          .id("caps")
          .absolute()
          .left(0)
          .top(0)
          .w(width)
          .h(barH)
          .opacity(0.55),
      );
    }
    if (flashes) {
      out.push(
        paint
          .paint_path(flashes.build(), t.foreground)
          .id("flashes")
          .absolute()
          .left(0)
          .top(0)
          .w(width)
          .h(barH)
          .opacity(0.8 * topFlash),
      );
    }

    const now = Date.now();
    for (const s of this.sparks) {
      if (!live || s.state === "idle" || now < s.startAt) continue;
      const p = this.pos(s, now);
      // `lit` is the landing marker the frame sets, so the flash fires once however often we draw.
      const landed = s.state === "lit";
      const fade = landed ? Math.max(0, 1 - (now - s.startAt - 2 * s.hop) / LAND_MS) : 1;
      const alpha = (p.rising ? 0.95 : 0.6) * fade;
      // A trail: the same path a moment behind, only while the spark is still climbing.
      if (p.rising && now - s.startAt > TAIL_MS) {
        const q = this.pos(s, now - TAIL_MS);
        out.push(
          div()
            .id(`trail-${s.k}`)
            .absolute()
            .left(Math.round(q.x))
            .top(Math.round(q.y))
            .w(DOT)
            .h(DOT)
            .bg(s.bright)
            .opacity(alpha * 0.35),
        );
      }
      out.push(
        div()
          .id(`spark-${s.k}`)
          .absolute()
          .left(Math.round(p.x))
          .top(Math.round(p.y))
          .w(DOT)
          .h(DOT)
          .bg(p.rising ? s.bright : s.color)
          .opacity(alpha),
      );
    }

    const band = div().id("spectrum").relative().size_full().children(out);
    // A paused skyline settles to a dim baseline that breathes on its own: one loop on the
    // container, not one per pixel, and no redraws for it.
    return live ? band : band.loop("opacity", { from: 0.45, to: 0.8, period: 3600 });
  }
}
