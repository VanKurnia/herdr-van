// The tab bar: flat tabs, drag to reorder, and the + and window buttons, which are
// drawn only while the pointer is on the bar. No per-tab X (close with ctrl-shift-w
// or the right-click menu) and no Files/Changes toggles: this layout's panel toggle
// lives on the pane header instead (this mod's pane part, pi panes only).

import { div, svg, image, PathBuilder, Background } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, agents, run, openOverlay, theme, window, layout, settings, focused, home, appHome, exec, watchFolder, checking } from "herdr";
import { sidebar } from "./lib.js";

// Where pi keeps one session log per folder: `sessions/--C--Users-ivan-app--`, the path with its
// separators and drive colon turned to dashes.
const sessionsFor = (cwd) => `${home()}/.pi/agent/sessions/--${cwd.replace(/[:\\/]/g, "-")}--`;

// Resolve after a wait without a polling clock of our own.
const park = (cx, ms) => new Promise((done) => cx.timer.after(ms, done));

// One wave, drawn rather than stacked: a monotone cubic through the rates, emitted as cubic Bézier
// segments in percentages of the box, so the renderer anti-aliases a line instead of stair-stepping
// a column of rectangles. Monotone (Fritsch-Carlson) and not Catmull-Rom: a spline that overshoots
// draws a peak between two samples that never happened, and a dip below the floor, which the data
// cannot produce.
const FLOOR = 60; // tok/s the box always spans, so a quiet stretch does not fill it
const SETTLE_MS = 600; // writes arrive in bursts, and a burst is one message

// The bar's span is time, not messages. A point per finished message meant the curve slid a slot
// every few seconds during a turn, and three or four at once when a burst landed: too fast to read,
// and it settled into a new shape rather than moving. One point per BUCKET_MS instead, SLOTS of
// them, so the curve advances one slot every 15 s however the messages fall — 15 minutes across the
// bar. One slot per tick is the smallest step this runtime allows: the curve is geometry, and a
// per-frame redraw of the whole window is what animating it smoothly would cost.
const SLOTS = 60;
const BUCKET_MS = 15 * 1000;

// A step rather than the sample's own maximum: the box keeps its scale while a message arrives, so
// two moments in the same session can be compared by eye.
const scaleFor = (values) => Math.max(FLOOR, Math.ceil((Math.max(...values) * 1.1) / 20) * 20);

// Fritsch-Carlson tangents, clamped so no segment leaves the interval between its own endpoints.
const tangents = (v) => {
  const n = v.length;
  if (n < 2) return v.map(() => 0);
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push(v[i + 1] - v[i]);
  const m = [d[0]];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      m[i] = k * a * d[i];
      m[i + 1] = k * b * d[i];
    }
  }
  return m;
};

// Every point is one slice of the same width, so the curve is one unbroken line: a quiet slice is a
// real zero, not a hole, and nothing has to be bridged or split.
const waveShape = (values, peak) => {
  const n = values.length;
  // A fixed slot width, anchored at the right edge: a new slice arrives at 100 % and every older one
  // keeps its place, so the curve marches left one slot per slice. Fitting the points to the box
  // instead re-spaced the whole line on every arrival, which early in a session swept the bar.
  const slot = 100 / (SLOTS - 1);
  const x = (i) => 100 - (n - 1 - i) * slot;
  // The stroke is centred on the curve: half of it falls outside the box at 0 % or 100 %, so the
  // curve keeps a stroke's width off both edges.
  const y = (v) => 97 - (v / peak) * 94;
  // Tangents from these samples, clamped so no segment leaves the interval between its own ends.
  const m = tangents(values);
  const xs = values.map((_, i) => x(i));
  const step = (b, k) => {
    const a = xs[k], d = xs[k + 1];
    return b.cubic_bezier_to(
      `${d}%`, `${y(values[k + 1])}%`,
      `${(a + (d - a) / 3).toFixed(3)}%`, `${y(values[k] + m[k] / 3)}%`,
      `${(d - (d - a) / 3).toFixed(3)}%`, `${y(values[k + 1] - m[k + 1] / 3)}%`,
    );
  };
  let line = PathBuilder.stroke(2).move_to(`${xs[0]}%`, `${y(values[0])}%`);
  let body = PathBuilder.fill().move_to(`${xs[0]}%`, `${y(values[0])}%`);
  for (let k = 1; k < n; k++) {
    line = step(line, k - 1);
    body = step(body, k - 1);
  }
  // The body runs to the box's floor, so the fade has the whole height to work over.
  body = body.line_to(`${xs[n - 1]}%`, "100%").line_to(`${xs[0]}%`, "100%").close();
  return { line: line.build(), body: body.build(), peak, top: Math.max(...values) };
};

export default class Tabs {
  init(_props, cx) {
    this.pressed = null;
    this.onBar = false; // the pointer is on the tab bar, so its buttons are drawn
    // A wheel gesture's progress: how far it has moved, how many tabs it already stepped, and when
    // it last stepped (ms). Shared by every event of one flick.
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
    // Tokens per second, one per slice of BUCKET_MS of the focused agent's own pi session, oldest
    // first. `pending` holds the slices read but not yet shown: the display takes one per tick, so a
    // burst is drawn a slice at a time instead of shoving the curve several slots at once. The scale
    // only grows within a session: a peak that fell when one slice left the window would re-scale
    // every point the eye is following.
    this.speed = [];
    this.pending = [];
    this.seenKey = null; // the newest slice already queued
    this.peak = 0;
    // Follow the agent that has the keyboard, and only pi: its session log gains an entry per
    // message, so a watch brings each new rate; the slow beat is for telling one agent from another
    // — a watch cannot say that the person switched, so without it the old rates would sit there.
    // The display's own clock. Driven by arrivals the window lurches; driven by a clock it slides a
    // slice every BUCKET_MS, and a silence still advances, so a quiet agent leaves the bar behind
    // rather than freezing it.
    if (!checking()) cx.timer.every(BUCKET_MS, (cx) => this.slide(cx));
    if (!checking()) cx.spawn(async (cx) => {
      let key = null, watch = null, fresh = true;
      for (;;) {
        const agent = agents().find((a) => a.focused) ?? null;
        const cwd = agent ? focused()?.cwd ?? null : null;
        // The wave is pi's or it is nothing: another agent in the same folder (opencode beside pi,
        // say) has no log here, and pi's last run is not its rate.
        const follows = Boolean(agent && cwd) && agent.program?.name === "Pi";
        const next = follows ? `${agent.address}|${cwd}` : null;
        if (next !== key) {
          key = next;
          // Safe after settlement, so a watch that already answered needs no guard.
          watch?.cancel();
          watch = null;
          this.speed = [];
          this.pending = [];
          this.peak = 0;
          this.seenKey = null;
          fresh = true;
          cx.notify();
        }
        if (!key) {
          await park(cx, 2000);
          continue;
        }
        const dir = sessionsFor(cwd);
        // Armed before the read, so a write that lands while speedtail runs is still seen.
        if (!watch) {
          try {
            watch = watchFolder(dir);
          } catch {
            watch = null; // no session in this folder yet: the beat retries
          }
        }
        // A read that could not happen (no folder yet, no node) is retried on the next beat:
        // nothing else would wake it, and the reason may be temporary.
        if (fresh) fresh = !(await this.tail(dir, cx));
        const changed = watch
          ? await Promise.race([watch.then(() => true, () => true), park(cx, 1500).then(() => false)])
          : await park(cx, 1500).then(() => false);
        if (changed) {
          watch = null;
          fresh = true;
          await park(cx, SETTLE_MS); // let the rest of the burst land before reading it
        }
      }
    });
  }

  // The last few minutes as tokens per second, in even slices of time rather than one point per
  // finished message, from pi's own numbers. Unchanged rates redraw nothing, and whether it could
  // read at all is the caller's to retry.
  async tail(dir, cx) {
    let rows;
    try {
      rows = JSON.parse((await exec("node", [`${appHome()}/mods/herdr-van/speedtail.js`, `--dir=${dir}`, "--n=400"], { timeout: 8000 })).stdout);
    } catch {
      return false; // no node, no session in this folder yet, or a body cut short
    }
    // A slice's rate is its own tokens over its own time, so a burst and a slow turn both read
    // honestly. The slice keeps the time of its last message: that is what tells a silence apart from
    // a busy stretch, and it lets the wave break across one as it always has.
    const slices = new Map();
    for (const [at, tokens, ms] of rows) {
      const key = Math.floor(at / BUCKET_MS);
      const slice = slices.get(key) ?? { tokens: 0, ms: 0, at };
      slice.tokens += tokens;
      slice.ms += ms;
      slice.at = Math.max(slice.at, at);
      slices.set(key, slice);
    }
    const keys = [...slices.keys()].sort((a, b) => a - b);
    const fresh = this.seenKey === null ? keys.slice(-SLOTS) : keys.filter((k) => k > this.seenKey);
    if (!fresh.length) return true;
    this.seenKey = fresh[fresh.length - 1];
    // A slice's rate is its own tokens over its own time, so a burst and a slow turn both read
    // honestly. The scale grows with the busiest slice of this read, not with its sum.
    const next = fresh.map((k) => { const s = slices.get(k); return Math.round(s.tokens / (s.ms / 1000)); });
    this.peak = Math.max(this.peak, scaleFor(next));
    for (const rate of next) this.pending.push(rate);
    return true;
  }

  // One slice per tick, from the queue; a silent slice when it is empty, so the window is time and
  // not events. A new session takes as many as fit at once — filling the bar over 15 minutes would
  // show an empty graph for the session it is meant to describe.
  slide(cx) {
    if (!this.speed.length && !this.pending.length) return; // nothing followed: nothing to draw
    if (!this.speed.length) {
      this.speed = this.pending.splice(0, SLOTS);
    } else {
      this.speed.push(this.pending.length ? this.pending.shift() : 0);
      if (this.speed.length > SLOTS) this.speed.shift();
    }
    // One repaint per slice: the curve is geometry, not a tween, and everything that moves here
    // moves in the compositor.
    cx.notify();
  }

  // One tab per wheel notch. A touchpad or a smooth-scrolling mouse sends many small events per
  // gesture: a short swipe or one smoothed notch (about 25 px) switches one tab, a longer swipe
  // keeps going a tab per 60 px, at most one every 100 ms so each one shows.
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe, now = Date.now();
    // Phases often arrive only as moves (a macOS touchpad included): a pause or a turn starts a new gesture.
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    // The active tab can change without the bar moving. Its id and its index are both compared:
    // a space switch can change one without the other.
    const active = shown.findIndex((c) => c.active);
    const ps = panes();
    // Square hover blocks, full bar height, like the tabs beside them: the width
    // follows the height, so the block stays square whatever the bar's height is.
    const button = (id, label, action) => div().id(id).aspect_square().h_full().flex_none().flex().items_center().justify_center().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
    const item = (c, i) => {
      const program = ps.find(p => p.tab === c.id && p.program?.agent)?.program ?? ps.find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      // Only the bottom edge is emphasised: every tab reserves the same 2px, transparent
      // while idle, so switching never moves a label.
      return h_flex().id(`tab-${c.id}`).h_full().px(10).gap(7).items_center().flex_none().text_size(12.8)
        .border_b(2).border_color(c.active ? t.accent : "#00000000")
        .bg(c.active ? t.raised : "#00000000").text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }))
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/herdr-van/icons/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])));
    };
    const w = window(), bar = sidebar(), lights = layout()?.traffic_lights;
    // macOS draws its traffic lights over the bar, so the tabs leave them room.
    // Elsewhere the first tab starts at the sidebar's edge: no gap to the left.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && lights
      ? Math.max(10, (lights[0] + 64) / settings().zoom - (bar?.hidden ? 0 : bar?.size?.px ?? 0))
      : 0;
    // Windows draws its own style of X; everywhere else the flat one.
    const closeIcon = w?.platform === "windows"
      ? svg("mods/herdr-van/icons/win-close.svg").size(16)
      : svg("mods/herdr-van/icons/close.svg").size(13);
    // No fill of its own, so the layout's backdrop shows through; only the active tab
    // and the hovered one are painted. No bottom border and no right padding: the
    // active tab's edge meets the pane's focus hairline, and the window button meets
    // the window's edge. Buttons appear only while the pointer is on the bar, and the
    // id is what makes it hoverable at all — pointer state is tracked per element id.
    // The tabs are laid out in a row of their own, so the wave starts exactly where the last one
    // ends: an overflow scroll area here would stretch its children to its own width, which fed a
    // wrong width back into whatever was measured from them. Overflowing tabs are clipped instead
    // (the bar hides its overflow) and the wheel still steps through them.
    const rates = this.speed;
    // The wave is drawn only while the pointer is away from the bar, but its box stays: the tooltip
    // hangs off it, and the numbers live there.
    const shape = rates.length < 2 ? null : waveShape(rates, this.peak);
    // `window` here is the gpui window the mod draws into, not the app's window data (imported as
    // `window` from herdr above), so it is reached through globalThis.
    const paint = globalThis.window;
    const speed = shape
      ? div().id("tab-speed").relative().flex_1().min_w(0).h_full()
        .tooltip(`Tokens per second, last ${rates.length} messages · best ${Math.round(shape.top)}, scale ${shape.peak}`)
        .when(!this.onBar, el => el
          .child(paint.paint_path(shape.body, Background.linear_gradient(180, `${t.accent}99`, `${t.accent}00`))
            .absolute().top(3).left(0).right(0).bottom(0))
          .child(paint.paint_path(shape.line, t.accent).absolute().top(3).left(0).right(0).bottom(0)))
      : null;
    return h_flex().id("tab-bar").size_full().min_w(0).pl(lightsPadding).items_center().overflow_hidden()
      .on_hover((on, cx) => { if (on !== this.onBar) { this.onBar = on; cx.notify(); } })
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(h_flex().id("tab-strip").flex_none().h_full().items_center()
        .children(shown.map(item)))
      .when(this.onBar, el => el.child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }))))
      .child(speed ?? div().flex_1())
      .when(this.onBar && Boolean(w?.buttons), el => el.child(button("close-window", closeIcon, () => run("window.close"))));
  }
}
