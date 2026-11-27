// `gpui-kit` as the benches see it: every call builds a stand-in element and
// counts it. Nothing is laid out or drawn — the count is the point, because
// the app rebuilds and lays out whatever a render returns.

import { counts } from "../env.mjs";

const MAX_LIST_ROWS = 30; // enough to see a virtual list's per-row cost

// One stand-in element. Every builder returns the same proxy, so a chain is one
// element, and `.when` only builds its branch when the condition holds, as the
// real builder does.
function element(kind) {
  counts.elements++;
  const proxy = new Proxy({ __kind: kind }, {
    get(_target, prop) {
      if (prop === "then") return undefined; // never await an element
      if (typeof prop === "symbol") return undefined;
      if (prop === "when") return (cond, fn) => { if (cond) fn(proxy); return proxy; };
      return () => proxy;
    },
  });
  return proxy;
}

export const div = () => element("div");
export const h_flex = () => element("h_flex");
export const v_flex = () => element("v_flex");
export const image = () => element("image");
export const svg = () => element("svg");

export const list = (items, fn) => {
  const el = element("list");
  const n = typeof items === "number" ? items : (items?.length ?? 0);
  if (typeof fn === "function") {
    for (let i = 0; i < Math.min(n, MAX_LIST_ROWS); i++) {
      try { fn(i); counts.listItems++; } catch { counts.listFailures++; }
    }
  }
  return el;
};

// Paths are geometry: they add no element to the tree. The element that carries one does count,
// so a mod that draws its own geometry through the gpui window is measured like any other.
export const paintPath = () => element("path");

export class PathBuilder {
  constructor() {
    // Every method chains back to the same proxy: `fill().add_polygon().build()` is one builder.
    // Returning the raw instance would break at the second call.
    const proxy = new Proxy(this, { get: (_target, prop) => (prop === "then" ? undefined : () => proxy) });
    return proxy;
  }

  // The statics the mods use: a filled path and a stroked one. Each returns a builder whose every
  // method (move_to, line_to, build) chains back to it, which is all a bench needs.
  static fill() { return new PathBuilder(); }
  static stroke(_width) { return new PathBuilder(); }
}
// A background is a paint description, not an element: it adds nothing to the tree. The real
// builder chains (`Background.solid(c).opacity(0.5)`), so the stand-in's methods all return the
// same object rather than a fresh `{}` that a chain could not continue from.
function background() {
  const bg = { opacity: () => bg, color_space: () => bg };
  return bg;
}
export const Background = {
  solid: () => background(),
  linear_gradient: () => background(),
};

// The app's base class: mods extend it and implement init/render.
export class View {
  constructor() {}
  init() {}
  render() { return null; }
  async close() {}
}
