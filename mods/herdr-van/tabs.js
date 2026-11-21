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

// One wave, drawn rather than stacked: a Catmull-Rom curve through the rates, emitted as cubic
// Bézier segments in percentages of the box, so the renderer anti-aliases a line instead of
// stair-stepping a column of rectangles. The body under it is the same curve closed along the
// baseline, for a gradient that fades to nothing at the bottom.
const waveShape = (values) => {
  const n = values.length;
  const peak = Math.max(1, ...values);
  const x = (i) => (i / (n - 1)) * 100;
  const y = (i) => 97 - (values[i] / peak) * 94; // the stroke is centred on the curve: half of it
  // falls outside the box at 0 % or 100 %, so the curve keeps a stroke's width off both edges.
  const at = (i) => Math.max(0, Math.min(n - 1, i));
  const curve = (builder) => {
    let out = builder;
    for (let i = 0; i < n - 1; i++) {
      const a = at(i - 1), c = at(i), d = at(i + 1), e = at(i + 2);
      out = out.cubic_bezier_to(
        `${x(d)}%`, `${y(d)}%`,
        `${x(c) + (x(d) - x(a)) / 6}%`, `${y(c) + (y(d) - y(a)) / 6}%`,
        `${x(d) - (x(e) - x(c)) / 6}%`, `${y(d) - (y(e) - y(c)) / 6}%`,
      );
    }
    return out;
  };
  return {
    line: curve(PathBuilder.stroke(2).move_to(`${x(0)}%`, `${y(0)}%`)).build(),
    // The body runs to the box's floor, so the fade has the whole height to work over.
    body: curve(PathBuilder.fill().move_to(`${x(0)}%`, `${y(0)}%`))
      .line_to("100%", "100%").line_to("0%", "100%").close().build(),
  };
};

export default class Tabs {
  init(_props, cx) {
    this.pressed = null;
    this.onBar = false; // the pointer is on the tab bar, so its buttons are drawn
    // A wheel gesture's progress: how far it has moved, how many tabs it already stepped, and when
    // it last stepped (ms). Shared by every event of one flick.
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
    // Tokens per second, one per finished message of the focused agent's own pi session, oldest
    // first, and the running ease from the previous list to it (null between samples).
    this.speed = [];
    this.fade = null;
    // Follow the agent that has the keyboard, and only pi: its session log gains an entry per
    // message, so a watch brings each new rate; the slow beat is for telling one agent from another
    // — a watch cannot say that the person switched, so without it the old rates would sit there.
    if (!checking()) cx.spawn(async (cx) => {
      let key = null, watch = null, fresh = true;
      for (;;) {
        const agent = agents().find((a) => a.focused) ?? null;
        const cwd = agent ? focused()?.cwd ?? null : null;
        // Another agent in the same folder (opencode beside pi, say) has no log here, and pi's last
        // run is not its rate: the wave is pi's or it is nothing.
        const follows = Boolean(agent && cwd) && (/pi/i.test(agent.app ?? "") || agent.program?.name === "Pi");
        const next = follows ? `${agent.address}|${cwd}` : null;
        if (next !== key) {
          key = next;
          try {
            watch?.cancel();
          } catch {
            // a watch that already answered cannot be cancelled again
          }
          watch = null;
          this.speed = [];
          this.fade = null; // a new session's curve is not a blend of the old one's
          fresh = true;
          cx.notify();
        }
        if (!key) {
          await park(cx, 2000);
          continue;
        }
        const dir = sessionsFor(cwd);
        if (fresh) {
          fresh = false;
          await this.tail(dir, cx);
        }
        if (!watch) {
          try {
            watch = watchFolder(dir);
          } catch {
            watch = null; // no session in this folder yet: the beat retries
          }
        }
        const changed = watch
          ? await Promise.race([watch.then(() => true, () => true), park(cx, 1500).then(() => false)])
          : await park(cx, 1500).then(() => false);
        if (changed) {
          watch = null;
          fresh = true;
        }
      }
    });
  }

  // The last few finished messages as tokens per second, from pi's own numbers. Unchanged rates
  // redraw nothing.
  async tail(dir, cx) {
    let out;
    try {
      out = (await exec("node", [`${appHome()}/mods/herdr-van/speedtail.js`, `--dir=${dir}`, "--n=40"], { timeout: 8000 })).stdout;
    } catch {
      return;
    }
    let rows;
    try {
      rows = JSON.parse(out || "[]");
    } catch {
      return;
    }
    const next = rows.map((r) => Math.round(r[1] / (r[2] / 1000)));
    if (next.join() === this.speed.join()) return;
    // A new sample would snap every height and the peak at once. Keep what is on screen as the
    // start of a short ease, so the curve slides into the new shape instead of jumping to it.
    this.fade = { from: this.speed, t0: Date.now(), ms: 320 };
    this.speed = next;
    this.wake(cx);
  }

  // Redraws for as long as an ease is running. Bounded: a few frames per sample, only when one
  // arrives, and nothing at all while the curve sits still.
  wake(cx) {
    const step = (cx) => {
      if (!this.fade) return;
      cx.notify();
      if (Date.now() - this.fade.t0 < this.fade.ms) cx.timer.after(33, step);
      else this.fade = null;
    };
    cx.timer.after(33, step);
  }

  // The values to draw: the new ones, or a blend of the old and new while an ease runs. The two
  // lists are lined up at their newest sample, since that end is "now" for both; an older, shorter
  // list holds its first value across the columns it does not reach.
  shown() {
    const f = this.fade;
    if (!f) return this.speed;
    const p = (Date.now() - f.t0) / f.ms;
    if (p >= 1) {
      this.fade = null;
      return this.speed;
    }
    const ease = 1 - (1 - p) * (1 - p); // slows into place rather than stopping dead
    const from = f.from, to = this.speed;
    const n = Math.max(from.length, to.length);
    const at = (list, i) => list.length
      ? list[Math.max(0, Math.min(list.length - 1, i - (n - list.length)))]
      : 0;
    return Array.from({ length: n }, (_, i) => at(from, i) * (1 - ease) + at(to, i) * ease);
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
    const rates = this.shown().slice(-30);
    const shape = this.onBar || rates.length < 2 ? null : waveShape(rates);
    // `window` here is the gpui window the mod draws into, not the app's window data (imported as
    // `window` from herdr above), so it is reached through globalThis.
    const paint = globalThis.window;
    const fade = /^#[0-9a-fA-F]{6}$/.test(t.accent) ? `${t.accent}00` : "#00000000";
    const speed = shape
      ? div().id("tab-speed").relative().flex_1().min_w(0).h_full()
        .tooltip(`Tokens per second, last ${rates.length} messages · peak ${Math.round(Math.max(...rates))}`)
        .child(paint.paint_path(shape.body, Background.linear_gradient(180, `${t.accent}99`, fade))
          .absolute().top(3).left(0).right(0).bottom(0))
        .child(paint.paint_path(shape.line, t.accent).absolute().top(3).left(0).right(0).bottom(0))
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
