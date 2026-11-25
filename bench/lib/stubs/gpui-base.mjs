// `gpui-base` as the benches see it: the same counting elements, plus the
// control and text-state stubs a render or an init may touch.

import { counts } from "../env.mjs";

function element(kind) {
  counts.elements++;
  const proxy = new Proxy({ __kind: kind }, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      if (prop === "when") return (cond, fn) => { if (cond) fn(proxy); return proxy; };
      return () => proxy;
    },
  });
  return proxy;
}

export const h_flex = () => element("h_flex");
export const v_flex = () => element("v_flex");
export const Input = Object.assign(() => element("input"), { new: () => element("input") });
export const Editor = () => element("editor");
export const Button = () => element("button");
export const Checkbox = () => element("checkbox");
export const Switch = () => element("switch");
export const Scrollbar = Object.assign(() => element("scrollbar"), {
  vertical: () => element("scrollbar"),
  horizontal: () => element("scrollbar"),
});
export const resizable_panel = () => element("resizable_panel");
export const v_resizable = () => element("v_resizable");

export const v_virtual_list = (handle, count, fn) => {
  const el = element("v_virtual_list");
  const n = typeof count === "number" ? count : (count?.length ?? 0);
  if (typeof fn === "function") {
    for (let i = 0; i < Math.min(n, 30); i++) {
      try { fn(i); counts.listItems++; } catch { counts.listFailures++; }
    }
  }
  return el;
};

export class ScrollHandle {
  static new() { return new ScrollHandle(); }
  offset() { return { x: 0, y: 0 }; }
  content_size() { return { width: 0, height: 0 }; }
  viewport_size() { return { width: 0, height: 0 }; }
  scroll_to_item() {}
}

export class InputState {
  static new(value = "") { return new InputState(value); }
  constructor(value = "") { this.text = value; }
  value() { return this.text; }
  set_value(v) { this.text = v; }
  on() { return () => {}; }
  focus() {}
  blur() {}
  release() {}
}

// Text states are created once and then configured; the benches only need the
// configuration calls to exist so an init or a render can finish.
export class EditorState {
  static new(options = {}) { return new EditorState(options); }
  constructor(options = {}) { this.options = options; }
  set_soft_wrap() {}
  set_tab_size() {}
  focus() {}
  blur() {}
  release() {}
}
