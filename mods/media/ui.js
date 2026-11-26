// The row itself: a cover, two lines of text, the skyline, and the transport. Nothing here reads a
// file, runs a process or keeps state: it is handed the values and draws them.
import { div, image, svg, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

const ART_OPACITY = 0.25; // the artwork over the panel; the fade below the seam takes it out
const PAD_X = 8; // the sidebar's own side gutter, so the poster lines up with the lists above it
const FADE_TOP = "33%"; // where the artwork starts dissolving into the panel
const TOP_FADE_SHARE = 0.28; // a fade at the very top, deep enough for two lines of words over it
const GRAPH_SHARE = 0.375; // the skyline's band: this much of the poster's height, at its foot
const GRAPH_TOP = `${((1 - GRAPH_SHARE) * 100).toFixed(1)}%`; // where that band starts

// The skyline's box: inside the poster's side gutter, at its foot. The row lays out from these
// numbers and the skyline draws from the same ones.
export const bandOf = (width, height) => ({
  width: Math.max(0, width - PAD_X * 2),
  barH: height * GRAPH_SHARE,
});

// How many bands either side of a colour seam the two zones blend across.
const FADE = 2;
const ICONS = "mods/media/icons/";

// A filled rect over whatever box it is given. The fades are painted rather than written as a
// gradient with stops, because `Background.stop` percentages are ignored in this build and render
// flat.
function fullRect() {
  return PathBuilder.fill()
    .add_polygon(
      [
        ["0%", "0%"],
        ["100%", "0%"],
        ["100%", "100%"],
        ["0%", "100%"],
      ],
      true,
    )
    .build();
}

// The bands are log-spaced over this range (levels.py), so a band's colour follows the frequency it
// stands for and keeps its place if the band count changes.
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

// A blend of two theme colours for the seams between the zones, in polar OKLCH: hue takes the short
// way round the colour circle. Blending channels instead passes through grey — red→green lands on
// tan at chroma 0.070 where the polar blend lands on amber at 0.149 — so the seams keep the colour
// the zones are meant to have.
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

export function blend(from, to, k) {
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

// Nothing until the player reports a timeline or we have counted one: a length alone is the whole
// clock, a position alone is how long this track has been going.
function clockText(pos, dur) {
  if (!(dur > 0)) return pos > 0 ? clock(pos) : "";
  return pos > 0 ? `${clock(pos)} / ${clock(dur)}` : clock(dur);
}

// The band tones, as one function of position: each zone's colour, and the seams between them
// walked over FADE samples either side, so a hue eases from zone to zone instead of switching at a
// boundary.
export function palette(n, t) {
  const zones = Array.from({ length: n }, (_, i) => bandColor(i, n, t));
  const seams = zones.flatMap((color, i) => (i > 0 && color !== zones[i - 1] ? [i] : []));
  return (u) => {
    for (const seam of seams) {
      const k = (u - (seam - FADE)) / (2 * FADE);
      if (k > 0 && k < 1) return blend(zones[seam - 1], zones[seam], k);
    }
    return zones[Math.max(0, Math.min(n - 1, Math.round(u)))];
  };
}

// `onWidth` is the size callback's body, so this file never touches the view's cx.
export function row({
  t,
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
  width,
  height,
  sky,
  onPrev,
  onToggle,
  onNext,
  onSize,
  onHover,
}) {
  const time = clockText(pos, dur);
  const paint = globalThis.window;

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

  // Layer 1: the artwork edge to edge at 25 %, dissolving into the panel from a third of the way
  // down, and again over the top edge where the words sit.
  // Cover fit, done by hand: one square, sized to the longer side and centred, then clipped. The
  // host has no object-fit, and a stretched square would show the art squashed.
  const band = bandOf(width, height);
  const artW = band.width;
  const side = Math.max(artW, height);
  const art = div()
    .id("media-art")
    .absolute()
    .top(0)
    .left(PAD_X)
    .right(PAD_X)
    .bottom(0)
    .overflow_hidden()
    .when(Boolean(cover) && side > 0, (el) =>
      el.child(
        image(cover)
          .absolute()
          .top((height - side) / 2)
          .left((artW - side) / 2)
          .w(side)
          .h(side)
          .opacity(ART_OPACITY),
      ),
    )
    // Downward: nothing at the seam, the panel colour at the bottom, which is what takes the art
    // from 25 % to gone by the bottom edge.
    .child(
      paint
        .paint_path(fullRect(), Background.linear_gradient(180, `${t.surface}00`, t.surface))
        .absolute()
        .top(FADE_TOP)
        .left(0)
        .right(0)
        .bottom(0),
    )
    // Upward: opaque at the top edge so two lines of words sit on the panel, then empty before a
    // third of the way down.
    .child(
      paint
        .paint_path(fullRect(), Background.linear_gradient(180, t.surface, `${t.surface}00`))
        .absolute()
        .top(0)
        .left(0)
        .right(0)
        .h(height * TOP_FADE_SHARE),
    );

  // Layer 2: the skyline at the poster's foot. Both insets, not a height: a percentage height beside
  // `bottom(0)` is ignored, and the band then fills the whole poster.
  const graph = div()
    .absolute()
    .top(GRAPH_TOP)
    .left(PAD_X)
    .right(PAD_X)
    .bottom(0)
    .child(sky.el(t, { ...band, levels, playing, offline }));

  // Layer 3: the words. The title and artist sit at the top left, two lines; the clock and the
  // transport at the top right, which the pointer brings in. Both are always laid out and only their
  // ink appears, so nothing shifts when the pointer arrives.
  const detailsLayer = h_flex()
    .absolute()
    .top(0)
    .left(0)
    .right(0)
    .px(12)
    .pt(8)
    .gap(8)
    .items_start()
    .justify_between()
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .items_start()
        .gap(1)
        .child(
          div()
            .max_w_full()
            .overflow_x_hidden()
            .truncate()
            .text_size(12)
            .text_color(offline || !session ? t.dim : playing ? t.foreground : t.muted)
            .child(title),
        )
        .when(Boolean(subtitle), (el) =>
          el.child(
            div()
              .max_w_full()
              .overflow_x_hidden()
              .truncate()
              .text_size(10)
              .text_color(t.muted)
              .child(subtitle),
          ),
        ),
    )
    .child(
      v_flex()
        .flex_none()
        .items_end()
        .gap(2)
        .opacity(hovered ? 1 : 0)
        .transition("opacity", 120)
        .when(Boolean(time), (el) =>
          el.child(div().text_size(10).text_color(t.muted).child(time)),
        )
        .when(Boolean(transport), (el) =>
          el.child(
            h_flex()
              .items_center()
              .gap(2)
              .child(button("prev", "prev.svg", onPrev))
              .child(button("toggle", playing ? "pause.svg" : "play.svg", onToggle))
              .child(button("next", "next.svg", onNext)),
          ),
        ),
    );

  return div()
    .id("media")
    .size_full()
    .relative()
    .overflow_hidden()
    // The poster's top corners are rounded like the rows above it, and the clip carries the artwork
    // and the skyline into that shape.
    .rounded_tl(6)
    .rounded_tr(6)
    .on_size_change((size, cx) => onSize(size, cx))
    .on_hover((on, cx) => onHover(on, cx))
    .when(Boolean(hint), (el) => el.tooltip(hint))
    .child(art)
    .child(graph)
    .child(detailsLayer);
}
