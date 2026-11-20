// The row itself: a cover, two lines of text, the spectrum, and the transport. Nothing here reads a
// file, runs a process or keeps state: it is handed the values and draws them.
import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

const COVER_PX = 46;
const BARS_H = 16;
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

// 1:23, or 1:02:03 past the hour.
function clock(seconds) {
  const at = Math.max(0, Math.round(seconds));
  const hours = Math.floor(at / 3600);
  const minutes = Math.floor((at % 3600) / 60);
  const rest = String(at % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
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
  onPrev,
  onToggle,
  onNext,
  onWidth,
}) {
  const art = cover
    ? image(cover).w(COVER_PX).h(COVER_PX).rounded(6).flex_none()
    : div().w(COVER_PX).h(COVER_PX).rounded(6).flex_none().bg(t.raised);

  // Nothing, until the player reports a length: a zero end time means it has no timeline to show.
  // A zero position means it has a length but no position, so the length is all there is to say.
  const time = dur > 0 ? (pos > 0 ? `${clock(pos)} / ${clock(dur)}` : clock(dur)) : "";

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
              h_flex()
                .items_center()
                .gap(2)
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
