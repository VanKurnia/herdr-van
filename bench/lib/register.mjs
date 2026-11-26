// `node --import ./bench/lib/register.mjs <bench>` — installs the resolver hook
// and the globals a mod expects from the app. Imported for its side effect only.

import { register } from "node:module";

import { paintPath } from "./stubs/gpui-kit.mjs";

register("./hooks.mjs", import.meta.url);

// The gpui window a mod draws geometry on: `globalThis.window.paint_path(path, background)` in the
// app. Without it a mod that builds paths throws instead of rendering.
Object.defineProperty(globalThis, "window", {
  configurable: true,
  writable: true,
  value: { paint_path: paintPath },
});

// A mod reaches for the app's localStorage. Node ships one only behind a flag, and
// merely reading the property warns, so replace it outright.
const store = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  },
});
