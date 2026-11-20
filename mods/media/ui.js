// The row itself: a cover, two lines of text, and the spectrum. Nothing here reads a file, runs a
// process or keeps state: it is handed the values and draws them.
import { div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

const COVER_PX = 46;
const BARS_H = 16;

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

// Bars scale with the sidebar: each one is flex_1 of what the row has left.
export function bars(levels, playing, offline, t) {
  return levels.length
    ? h_flex()
        .w_full()
        .h(BARS_H)
        .items_end()
        .gap(2)
        .children(
          levels.map((raw, i) => {
            const level = playing && !offline ? Math.min(1, Math.max(0, raw)) : 0;
            return div()
              .id(`band-${i}`)
              // GPUI eases the height between frames, so the data rate no longer sets how
              // smooth the bars look — and no redraw is needed to animate them.
              .transition("height", 80)
              .flex_1()
              .h(Math.max(1, Math.round(level * BARS_H)))
              .rounded(1)
              .bg(level > 0.06 ? bandColor(i, levels.length, t) : t.border);
          }),
        )
    : div().w_full().h(1).bg(t.border);
}

// `onWidth` is the size callback's body, so this file never touches the view's cx.
export function row({ t, compact, offline, playing, session, title, subtitle, hint, cover, levels, onWidth }) {
  const art = cover
    ? image(cover).w(COVER_PX).h(COVER_PX).rounded(6).flex_none()
    : div().w(COVER_PX).h(COVER_PX).rounded(6).flex_none().bg(t.raised);

  const text = v_flex()
    .flex_1()
    .min_w(0)
    .gap(2)
    .child(
      div()
        .min_w(0)
        .overflow_x_hidden()
        .truncate()
        .text_size(12)
        .text_color(offline || !session ? t.dim : playing ? t.foreground : t.muted)
        .child(title),
    )
    .when(Boolean(subtitle), (el) =>
      el.child(
        div().min_w(0).overflow_x_hidden().truncate().text_size(10).text_color(t.muted).child(subtitle),
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
