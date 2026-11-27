// The tab bar: flat tabs, drag to reorder, and the + and window buttons, which are
// drawn only while the pointer is on the bar. No per-tab X (close with ctrl-shift-w
// or the right-click menu) and no Files/Changes toggles: this layout's panel toggle
// lives on the pane header instead (this mod's pane part, pi panes only).

import { div, svg, image, PathBuilder, Background } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, agents, run, openOverlay, theme, window, layout, settings, focused, home, appHome, exec, watchFolder, checking } from "herdr";
import { hidden, park, sidebar } from "./lib.js";

// Where pi keeps one session log per folder: `sessions/--C--Users-ivan-app--`, the path with its
// separators and drive colon turned to dashes.
const sessionsFor = (cwd) => `${home()}/.pi/agent/sessions/--${cwd.replace(/[:\\/]/g, "-")}--`;

const FLOOR = 60; // tok/s the box always spans, so a quiet stretch does not fill it
const SETTLE_MS = 600; // writes arrive in bursts; a burst is one message

// The bar's span is time, not messages: a point per finished message slid a slot every few seconds
// during a turn, several at once when a burst landed, and re-spaced the whole line on every arrival.
// One point per BUCKET_MS instead, so the band advances one slot at a fixed rate however messages
// fall — a little over three minutes across the bar.
const SLOTS = 60;
const BUCKET_MS = 3333;
// Drawn this many slices wider than the bar, to the right: new data is drawn where it cannot be seen
// and drifts in, rather than appearing at the edge.
const LEAD = 2;
const SLICES = SLOTS + LEAD; // the band's points: what the bar shows, plus the lead
// The slide is drawn by hand: the curve is geometry, and the compositor cannot interpolate between two
// of its shapes. Each frame repaints the whole window, so the step is set to land under a pixel.
const GLIDE_MS = 120;
// Carried by the compositor as a plain number, so the fade costs no frames of its own.
const FADE_MS = 500;

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

// Drawn, not stacked: a monotone cubic through the rates, so the renderer anti-aliases a line instead
// of stair-stepping a column of rectangles. Every point is one slice of the same width, so the curve
// is one unbroken line: a quiet slice is a real zero, not a hole.
const waveShape = (values, peak) => {
  const n = values.length;
  // A fixed slot width, anchored at the band's right edge: a new slice arrives beyond it and every
  // older one keeps its place, so the band slides as one piece.
  const slotPct = 100 / (SLICES - 1);
  const x = (i) => 100 - (n - 1 - i) * slotPct;
  // The stroke is centred on the curve: half of it falls outside the box at 0 % or 100 %, so the
  // curve keeps a stroke's width off both edges.
  const y = (v) => 97 - (v / peak) * 94;
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
  return { line: line.build(), body: body.build(), top: Math.max(...values) };
};

export default class Tabs {
  init(_props, cx) {
    this.pressed = null;
    this.onBar = false; // the pointer is on the tab bar, so its buttons are drawn
    this.barTools = false; // the buttons themselves: they take the band's width, so they wait for it
    this.follows = false; // the focused terminal is a pi agent, whose session the wave reads
    this.held = null; // the wave's last geometry, kept so it can fade out and back in
    // A wheel gesture's progress: how far it has moved, how many tabs it already stepped, and when
    // it last stepped (ms). Shared by every event of one flick.
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
    // Tokens per second, one per slice of BUCKET_MS of the focused agent's own pi session, oldest
    // first. `pending` holds slices read but not yet shown: the bar takes one per slot, so a burst is
    // drawn a slice at a time. The scale only grows within a session: a peak that fell when one slice
    // left the band would re-scale every point the eye is following.
    this.resetWave();
    this.waveW = 0; // the box's width in px, measured after layout
    // Follow the agent that has the keyboard, and only pi: its session log gains an entry per
    // message, so a watch brings each new rate; the slow beat is for telling one agent from another
    // — a watch cannot say that the person switched, so without it the old rates would sit there.
    // The slide's clock. Driven by arrivals the window lurches; driven by a clock it creeps, a
    // fraction of a slot per frame, and a silence still advances, so a quiet agent leaves the bar
    // behind rather than freezing it.
    if (!checking()) cx.timer.every(GLIDE_MS, (cx) => this.glide(cx));
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
          this.follows = follows;
          // Safe after settlement, so a watch that already answered needs no guard.
          watch?.cancel();
          watch = null;
          this.resetWave();
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
        if (fresh) fresh = !(await this.tail(dir));
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

  // The session's rates as tokens per second, in even slices of time, from pi's own numbers: queued,
  // not drawn, because the bar shows one slice per slot. Whether the read could happen at all is the
  // caller's to retry.
  async tail(dir) {
    let rows;
    try {
      rows = JSON.parse((await exec("node", [`${appHome()}/mods/herdr-van/speedtail.js`, `--dir=${dir}`, "--n=400"], { timeout: 8000 })).stdout);
    } catch {
      return false; // no node, no session in this folder yet, or a body cut short
    }
    // A slice's rate is its own tokens over its own time, so a burst and a slow turn both read
    // honestly.
    const slices = new Map();
    for (const [at, tokens, ms] of rows) {
      const key = Math.floor(at / BUCKET_MS);
      const slice = slices.get(key) ?? { tokens: 0, ms: 0 };
      slice.tokens += tokens;
      slice.ms += ms;
      slices.set(key, slice);
    }
    // Only what has not been queued yet: a re-read of the same log must not slide out of step.
    const keys = [...slices.keys()].sort((a, b) => a - b);
    const fresh = this.seenKey === null ? keys.slice(-SLICES) : keys.filter((k) => k > this.seenKey);
    if (!fresh.length) return true;
    this.seenKey = fresh[fresh.length - 1];
    const rates = fresh.map((k) => { const s = slices.get(k); return Math.round(s.tokens / (s.ms / 1000)); });
    this.peak = Math.max(this.peak, scaleFor(rates));
    for (const rate of rates) this.pending.push(rate);
    return true;
  }

  // Tokens per second, one per slice of BUCKET_MS of the focused agent's own pi session, oldest
  // first; `pending` holds slices read but not yet shown, so a burst is drawn a slice at a time. The
  // scale only grows within a session: a peak that fell when one slice left the band would re-scale
  // every point the eye is following.
  resetWave() {
    this.speed = [];
    this.pending = [];
    this.seenKey = null; // the newest slice already queued
    this.peak = 0;
    this.slotAt = 0; // when the current slot began
  }

  // The slide's clock: one slot every BUCKET_MS, a whole slice promoted each time and a silent one
  // when the queue is empty, so the band moves with time rather than with arrivals and a quiet agent
  // leaves the bar behind instead of freezing it. The data shifts and the phase returns to zero in the
  // same frame, so the band never jumps.
  glide(cx) {
    // Hidden or minimized: the slide would repaint a window nobody can see, and the wall-clock
    // catch-up would jump the band anyway. Stop the clock so it resumes in phase.
    if (hidden()) {
      this.slotAt = 0;
      return;
    }
    if (!this.speed.length && !this.pending.length) return; // nothing followed: nothing to draw
    // A band scrolled down to the floor is a flat line: sliding it changes no pixel, so the clock stops
    // instead of redrawing the window over an identical picture. Clearing slotAt restarts the clock in
    // phase on the next slice rather than advancing a slot for every one that went by.
    if (!this.pending.length && this.speed.every((v) => !v)) {
      this.slotAt = 0;
      return;
    }
    const now = Date.now();
    if (!this.slotAt) this.slotAt = now;
    // A band with nothing drawn yet fills at once: filling it over a quarter of an hour would show an
    // empty graph for the session it describes.
    if (!this.speed.length) this.speed = this.pending.splice(0, SLICES);
    while (now - this.slotAt >= BUCKET_MS) {
      this.slotAt += BUCKET_MS;
      this.speed.push(this.pending.length ? this.pending.shift() : 0);
      if (this.speed.length > SLICES) this.speed.shift();
    }
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

  // The pointer arriving on the bar, or leaving it.
  hover(on, cx) {
    if (on === this.onBar) return;
    this.onBar = on;
    // The buttons are laid out beside the band, so they take its width: arriving while it fades would
    // squeeze the shape. They go at once, when the band is near nothing and its box may grow back.
    if (on) cx.spawn(async (cx) => { await park(cx, FADE_MS); if (this.onBar) { this.barTools = true; cx.notify(); } });
    else this.barTools = false;
    cx.notify();
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
    // The band is drawn only while the pointer is away from the bar and a session is behind it; what
    // it last drew outlives both, so a band with no data behind it still fades instead of vanishing.
    const live = this.follows && rates.length >= 2;
    if (live) this.held = waveShape(rates, this.peak);
    const shape = this.held;
    // `window` here is the gpui window the mod draws into, not the app's window data (imported as
    // `window` from herdr above), so it is reached through globalThis.
    const paint = globalThis.window;
    // The band sits (LEAD + phase) slots to the left of the box, which is what slides it; the box
    // clips the part that has not come into view. SLOTS - 1 slots of travel is what sets a slot's
    // width in px.
    const slot = this.waveW / (SLOTS - 1);
    const phase = this.slotAt ? Math.min(1, (Date.now() - this.slotAt) / BUCKET_MS) : 0;
    // Only the opacity changes: a band that unmounted would have nothing to fade out with.
    const lit = live && !this.onBar && this.waveW > 0;
    const wave = shape
      ? div().id("tab-speed").relative().flex_1().min_w(0).h_full().overflow_hidden()
        .on_size_change((size, cx) => { if (size.width !== this.waveW) { this.waveW = size.width; cx.notify(); } })
        .when(live, el => el.tooltip(`Tokens per second, ${Math.round((rates.length * BUCKET_MS) / 60000)} min · best ${Math.round(shape.top)} · scale ${this.peak}`))
        .child(div().id("tab-wave").absolute().top(3).bottom(0).left(-(LEAD + phase) * slot).w((SLICES - 1) * slot)
          .opacity(lit ? 1 : 0)
          .transition("opacity", FADE_MS)
          .child(paint.paint_path(shape.body, Background.linear_gradient(180, `${t.accent}99`, `${t.accent}00`))
            .absolute().top(0).left(0).right(0).bottom(0))
          .child(paint.paint_path(shape.line, t.accent).absolute().top(0).left(0).right(0).bottom(0)))
      : null;
    return h_flex().id("tab-bar").size_full().min_w(0).pl(lightsPadding).items_center().overflow_hidden()
      .on_hover((on, cx) => this.hover(on, cx))
      .on_mouse_up("left", () => { this.pressed = null; })
      // A drag can end anywhere; only a release inside the bar clears the press, so the next move
      // that reports nothing held finishes the job. Passive: it cannot disturb the release itself.
      .on_window_mouse_move((e) => { if (e.pressed_button !== "left") this.pressed = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(h_flex().id("tab-strip").flex_none().h_full().items_center()
        .children(shown.map(item)))
      .when(this.barTools, el => el.child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }))))
      .child(wave ?? div().flex_1())
      .when(this.barTools && Boolean(w?.buttons), el => el.child(button("close-window", closeIcon, () => run("window.close"))));
  }
}
