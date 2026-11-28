// The row itself: a cover, two lines of text, the skyline, and the transport. Nothing here reads a
// file, runs a process or keeps state: it is handed the values and draws them.
import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

const ART_OPACITY = 0.5; // the art's floor: with the voice breathing it, 0.5 gain rests near 0.75
const HEAD_H = 24; // the sidebar's section titles are 11 px in a 24 px row
const HEAD_GAP = 6; // air between that row and the poster, so the poster is not part of the title
const PAD_X = 0; // the poster runs edge to edge: it no longer lines up with the lists' 8px gutter
// Every dissolve is baked into the cover's own alpha (see `fade_top` and `fade_bottom` in store.py):
// the poster goes to nothing over whatever it stands on, so the wallpaper of the moment shows through
// and no backdrop colour has to be guessed here. This build has no mask, and a band of clipped copies
// is culled when its top leaves the clip, so the ramp has to arrive baked in the image.
const GRAPH_SHARE = 0.3; // the skyline's band: this much of the poster's height, at its foot
const GRAPH_TOP = `${((1 - GRAPH_SHARE) * 100).toFixed(1)}%`; // where that band starts

// The header's own width has to give the label's box: px(10) twice, the icon, two gaps and the rule's
// 12 px floor. Measured from the header so a short title cannot leave a stale, too-narrow box behind.
export const HEAD_PAD = 58;

// The skyline's box: inside the poster's side gutter, at its foot. The row lays out from these
// numbers and the skyline draws from the same ones, both measured below the header line.
export const bandOf = (width, height) => ({
  width: Math.max(0, width - PAD_X * 2),
  barH: Math.max(0, height - HEAD_H - HEAD_GAP) * GRAPH_SHARE,
});

// The bands are log-spaced over this range (levels.py), so a band's colour follows the frequency it
// stands for and keeps its place if the band count changes.
const LOW_HZ = 40;
const HIGH_HZ = 16000;
// Four registers of one hue, held as one continuous ramp rather than four flat zones: the theme's
// accent taken down toward the backdrop at the bass and up toward white at the air. A zone that is
// one colour leaves a visible step at its edge and makes neighbouring columns identical, which is
// what reads as rigid; a ramp changes a little every column and stays the same colour scheme.
function bandColor(index, count, t) {
  const k = count <= 1 ? 0 : index / (count - 1);
  const deep = blend(t.accent, t.background, 0.28);
  const lift = blend(t.accent, "#ffffff", 0.42);
  return k < 0.5 ? blend(deep, t.accent, k / 0.5) : blend(t.accent, lift, (k - 0.5) / 0.5);
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
export function clock(seconds) {
  const at = Math.max(0, Math.round(seconds));
  const hours = Math.floor(at / 3600);
  const minutes = Math.floor((at % 3600) / 60);
  const rest = String(at % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

// The band tones, as one function of position: each column takes the colour of the register it
// stands for, so the skyline reads as four zones rather than a continuous rainbow.
export function palette(n, t) {
  const zones = Array.from({ length: n }, (_, i) => bandColor(i, n, t));
  return (u) => zones[Math.max(0, Math.min(n - 1, Math.round(u)))];
}

// `onWidth` is the size callback's body, so this file never touches the view's cx.
// The cover's own geometry, in logical px: the square it is drawn at, and how much of its top the
// poster's edge hides. A square wider than the poster starts above the clip, so the helper has to
// bake the fade at that offset: baked at row 0 it lands where nothing is seen.
export function artShape(width, height) {
  const artW = bandOf(width, height).width;
  const artH = Math.max(0, height - HEAD_H - HEAD_GAP);
  const side = Math.max(artW, artH);
  const cut = side > artH ? Math.min(0.5, (side - artH) / 2 / side) : 0;
  return { side, cut, span: side > 0 ? Math.min(1, artH / side) : 1 };
}

export function row({
  t,
  offline,
  playing,
  title,
  subtitle,
  hint,
  cover,
  artGain = 0.5,
  levels,
  hovered,
  marquee = { travel: 0, period: 4000 },
  width,
  height,
  sky,
  onSize,
  onHover,
  onText,
  onHeader,
}) {
  const paint = globalThis.window;
  // The header carries the words the poster used to: the song while the pointer is away, the artist
  // under it. Same type as the sidebar's section titles, so the row reads as part of the list.
  const label = hovered && subtitle ? subtitle : title;

  // The label gives way to the rule when it is long: the clip takes what the text needs, the text is
  // measured by an invisible copy laid out at its natural width, and only an overflow travels.
  const titleClip = div()
    .id("media-title")
    .flex_shrink(1)
    .min_w(0)
    .h(HEAD_H)
    .overflow_hidden()
    // While it overflows, the clip is pinned to the width the header gave it: the travelling copy is
    // absolute, and an absolute child would otherwise leave the clip with no width of its own.
    .when(marquee.travel > 0, (el) => el.w(marquee.box))
    // Absolute, so nothing stretches it: in flow the parent's width becomes the child's, and the
    // label would report the clip's size back as its own.
    .child(
      div()
        .absolute()
        .top(0)
        .left(0)
        .opacity(0)
        .whitespace_nowrap()
        .on_size_change((size, cx) => onText(size.width, cx))
        .child(label),
    )
    // Fits: drawn in flow, nothing moves. Overflows: a copy travels left to its end and back, which is
    // the only motion the host animates for `left`.
    .when(marquee.travel === 0, (el) => el.child(div().whitespace_nowrap().child(label)))
    .when(marquee.travel > 0, (el) =>
      el.child(
        div()
          .id("media-title-run")
          .absolute()
          .top(0)
          .bottom(0)
          .left(0)
          .flex()
          .items_center()
          .whitespace_nowrap()
          .loop("left", {
            from: 0,
            to: -marquee.travel,
            period: marquee.period,
            easing: "linear",
          })
          .child(label),
      ),
    );

  const header = h_flex()
    .id("media-header")
    .flex_none()
    .h(HEAD_H)
    .px(10)
    .gap(6)
    .items_center()
    .text_size(11)
    .font_semibold()
    .text_color(t.accent)
    .when(Boolean(hint), (el) => el.tooltip(hint))
    .on_size_change((size, cx) => onHeader(size.width, cx))
    .child(svg("mods/media/music.svg").size(14).flex_none().text_color(t.accent))
    .child(titleClip)
    .child(div().flex_1().min_w(12).h(1).bg(`${t.accent}55`));

  // Layer 1: the artwork edge to edge as a tint, dissolving out under the top edge where the words
  // sit and again from the seam down to its foot. Cover fit, done by hand: one square, sized to the
  // longer side and centred, then clipped. The host has no object-fit, and a stretched square would
  // show the art squashed.
  const band = bandOf(width, height);
  const artW = band.width;
  const { side, cut, span } = artShape(width, height);
  const artTop = -Math.round(cut * side);
  const artLeft = Math.round((artW - side) / 2);
  const art = div()
    .id("media-art")
    .absolute()
    .top(0)
    .left(PAD_X)
    .bottom(0)
    .w(artW)
    .overflow_hidden()
    .when(Boolean(cover) && side > 0, (el) =>
      el.child(
        // The dissolves are the art's own alpha — see `fade_top` and `fade_bottom` in store.py — so
        // the poster goes to nothing over whatever it stands on, and no colour is painted here.
        image(cover)
          .absolute()
          .top(artTop)
          .left(artLeft)
          .w(side)
          .h(side)
          .opacity(ART_OPACITY + (1 - ART_OPACITY) * artGain),
      ),
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

  // The poster: the artwork and the skyline, in the space under the header.
  const poster = div()
    .flex_1()
    .relative()
    .min_h(0)
    .overflow_hidden()
    .child(art)
    .child(graph);

  return div()
    .id("media")
    .size_full()
    .flex()
    .flex_col()
    .overflow_hidden()
    // The poster's top corners are rounded like the rows above it, and the clip carries the artwork
    // and the skyline into that shape.
    .rounded_tl(6)
    .rounded_tr(6)
    .on_size_change((size, cx) => onSize(size, cx))
    .on_hover((on, cx) => onHover(on, cx))
    .child(header)
    .child(div().flex_none().h(HEAD_GAP))
    .child(poster);
}
