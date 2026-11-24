// The row itself: a cover, two lines of text, the spectrum, and the transport. Nothing here reads a
// file, runs a process or keeps state: it is handed the values and draws them.
import { div, image, svg, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

const COVER_PX = 46;
const BARS_H = 33;
const STROKE = 1.6;
// How many bands either side of a colour seam the two zones blend across.
const FADE = 2;
const ICONS = "mods/media/icons/";

// The bars are log-spaced over this range (levels.py), so a bar's band follows the
// frequency it stands for and keeps its place if the bar count changes.
const LOW_HZ = 40;
const HIGH_HZ = 16000;
const BAND_STOPS = [
  { upTo: 60, color: "ansi5" }, // sub-bass: the deepest hue
  { upTo: 250, color: "ansi1" }, // bass: warm and heavy
  { upTo: 2000, color: "ansi2" }, // vocal: the middle, where the voice sits
  { upTo: Infinity, color: "ansi6" }, // treble: air and cymbals
];

function bandColor(index, count, t) {
  const hz = LOW_HZ * (HIGH_HZ / LOW_HZ) ** ((index + 0.5) / count);
  return t[BAND_STOPS.find((band) => hz < band.upTo).color];
}

// A blend of two theme colours for the seams between the spectrum's zones, in polar OKLCH: hue
// takes the short way round the colour circle. Blending channels instead passes through grey —
// red→green lands on tan at chroma 0.070 where the polar blend lands on amber at 0.149 — so the
// seams keep the colour the zones are meant to have.
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) =>
  Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));

function channels(hex) {
  const m = /^#([0-9a-fA-F]{6})/.exec(hex);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => toLinear(c / 255));
}

function oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(toSrgb);
}

function blend(from, to, k) {
  const a = channels(from);
  const b = channels(to);
  if (!a || !b) return k < 0.5 ? from : to;
  const [L1, A1, B1] = oklab(a);
  const [L2, A2, B2] = oklab(b);
  const h1 = Math.atan2(B1, A1);
  const h2 = Math.atan2(B2, A2);
  const turn = (((h2 - h1 + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  const C1 = Math.hypot(A1, B1);
  const C2 = Math.hypot(A2, B2);
  const h = h1 + turn * k;
  const C = C1 + (C2 - C1) * k;
  const L = L1 + (L2 - L1) * k;
  return `#${fromOklab([L, C * Math.cos(h), C * Math.sin(h)])
    .map((v) => Math.round(v * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

// 1:23, or 1:02:03 past the hour.
function clock(seconds) {
  const at = Math.max(0, Math.round(seconds));
  const hours = Math.floor(at / 3600);
  const minutes = Math.floor((at % 3600) / 60);
  const rest = String(at % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

// Nothing until the player reports a length; a length without a position is the whole clock.
function clockText(pos, dur) {
  if (!(dur > 0)) return "";
  return pos > 0 ? `${clock(pos)} / ${clock(dur)}` : clock(dur);
}

// The spectrum is painted, not stacked: a Catmull-Rom curve through the levels, emitted as cubic
// Bézier segments in percentages of the box, so the renderer anti-aliases a line instead of
// stair-stepping rectangles. Segment i is stroked in that band's tone and filled down to the
// baseline, so the hue eases from zone to zone instead of switching at a boundary.
export function bars(levels, playing, offline, t) {
  const n = levels.length;
  if (n < 2) return div().w_full().h(1).bg(t.border);
  const paint = globalThis.window;
  const value = (i) => (playing && !offline ? Math.min(1, Math.max(0, levels[i])) : 0) ** 0.7;
  // Samples sit on the rails, which `justify_between` spreads edge to edge: a band's value and the
  // hairline that marks its place are the same x, including the outermost two.
  const x = (i) => (i / (n - 1)) * 100;
  const y = (i) => 92 - value(i) * 84;
  const at = (i) => Math.max(0, Math.min(n - 1, i));
  // One cubic from sample i to i + 1, its control points in whatever vertical scale `f` gives, so
  // the stroked line and the filled body share the same outline.
  const segment = (builder, i, f) =>
    builder.cubic_bezier_to(
      `${x(i + 1)}%`, `${f(i + 1)}%`,
      `${x(i) + (x(i + 1) - x(at(i - 1))) / 6}%`, `${f(i) + (f(i + 1) - f(at(i - 1))) / 6}%`,
      `${x(i + 1) - (x(at(i + 2)) - x(i)) / 6}%`, `${f(i + 1) - (f(at(i + 2)) - f(i)) / 6}%`,
    );

  // The theme colours the zones are built from, and the seams between them. Each seam is walked
  // over FADE samples either side, so the line reads as one gradient rather than four blocks.
  const zones = levels.map((_, i) => bandColor(i, n, t));
  const seams = zones.flatMap((color, i) => (i > 0 && color !== zones[i - 1] ? [i] : []));
  const tone = (u) => {
    for (const seam of seams) {
      const k = (u - (seam - FADE)) / (2 * FADE);
      if (k > 0 && k < 1) return blend(zones[seam - 1], zones[seam], k);
    }
    return zones[Math.max(0, Math.min(n - 1, Math.round(u)))];
  };

  // The body fades from the loudest band down to the baseline: the fill box starts there, because
  // `Background.stop` percentages are not honoured in this build and render flat.
  const peak = Math.max(0, Math.min(...levels.map((_, i) => y(i))));
  const span = 100 - peak;
  const rise = (i) => (span <= 0 ? 0 : ((y(i) - peak) / span) * 100);

  // Bodies before lines: every element spans the row's width and paints only its own band inside
  // it, so a fill pushed between two strokes would sit over the earlier one.
  const bodies = [];
  const lines = [];
  for (let i = 0; i < n - 1; i++) {
    const shade = tone(i + 0.5);
    const color = /^#[0-9a-fA-F]{6}$/.test(shade) ? shade : "#ffffff";
    if (span > 0) {
      bodies.push(
        paint
          .paint_path(
            segment(PathBuilder.fill().move_to(`${x(i)}%`, `${rise(i)}%`), i, rise)
              .line_to(`${x(i + 1)}%`, "100%")
              .line_to(`${x(i)}%`, "100%")
              .close()
              .build(),
            Background.linear_gradient(180, `${color}99`, `${color}00`),
          )
          .absolute()
          .top((peak / 100) * BARS_H)
          .left(0)
          .right(0)
          .bottom(0),
      );
    }
    lines.push(
      paint
        .paint_path(
          segment(PathBuilder.stroke(STROKE).move_to(`${x(i)}%`, `${y(i)}%`), i, y).build(),
          color,
        )
        .absolute()
        .top(0)
        .left(0)
        .right(0)
        .bottom(0),
    );
  }

  // One hairline per band behind the curve, so a sample's frequency stays readable as it moves.
  return div()
    .id("spectrum")
    .relative()
    .w_full()
    .h(BARS_H)
    .child(
      h_flex()
        .w_full()
        .h_full()
        .justify_between()
        .children(levels.map((_, i) => div().w(1).h_full().bg(t.border))),
    )
    .children([...bodies, ...lines]);
}

// `onWidth` is the size callback's body, so this file never touches the view's cx.
export function row({
  t,
  compact,
  offline,
  playing,
  session,
  title,
  subtitle,
  hint,
  cover,
  levels,
  pos,
  dur,
  transport,
  hovered,
  onPrev,
  onToggle,
  onNext,
  onWidth,
  onHover,
}) {
  const art = cover
    ? image(cover).w(COVER_PX).h(COVER_PX).rounded(6).flex_none()
    : div().w(COVER_PX).h(COVER_PX).rounded(6).flex_none().bg(t.raised);

  const time = clockText(pos, dur);

  // The icon brightens with the row's text colour on hover, so it is set on the button.
  const button = (id, icon, onClick) =>
    div()
      .id(`media-${id}`)
      .size(18)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(4)
      .cursor_pointer()
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_event, cx) => onClick(cx))
      .child(svg(ICONS + icon).size(12));

  const text = v_flex()
    .flex_1()
    .min_w(0)
    .gap(2)
    .child(
      h_flex()
        .w_full()
        .items_center()
        .gap(6)
        .child(
          div()
            .flex_1()
            .min_w(0)
            .overflow_x_hidden()
            .truncate()
            .text_size(12)
            .text_color(offline || !session ? t.dim : playing ? t.foreground : t.muted)
            .child(title),
        )
        .when(Boolean(time), (el) =>
          el.child(div().flex_none().text_size(10.5).text_color(t.muted).child(time)),
        ),
    )
    .when(Boolean(subtitle) || transport, (el) =>
      el.child(
        h_flex()
          .w_full()
          .items_center()
          .gap(6)
          .child(
            div()
              .flex_1()
              .min_w(0)
              .overflow_x_hidden()
              .truncate()
              .text_size(10)
              .text_color(t.muted)
              .child(subtitle),
          )
          .when(transport, (el) =>
            el.child(
              // Faded rather than removed, so the title and artist do not shift when the
              // pointer arrives: the buttons keep their place, only their ink appears.
              h_flex()
                .items_center()
                .gap(2)
                .opacity(hovered ? 1 : 0)
                .transition("opacity", 120)
                .child(button("prev", "prev.svg", onPrev))
                .child(button("toggle", playing ? "pause.svg" : "play.svg", onToggle))
                .child(button("next", "next.svg", onNext)),
            ),
          ),
      ),
    );

  return v_flex()
    .id("media")
    .size_full()
    .gap(6)
    .px(12)
    .pb(6)
    // The cover keeps the same gap to the bars above as to the footer below. The bars
    // grow upward from it; the rail keeps its cover centred.
    .when(compact, (el) => el.justify_center())
    .when(!compact, (el) => el.justify_end())
    .on_size_change((size, cx) => onWidth(size, cx))
    .on_hover((on, cx) => onHover(on, cx))
    .when(Boolean(hint), (el) => el.tooltip(hint))
    .when(!compact, (el) => el.child(bars(levels, playing, offline, t)))
    .child(
      h_flex()
        .w_full()
        .items_center()
        .gap(10)
        .child(art)
        .when(!compact, (el) => el.child(text)),
    );
}
