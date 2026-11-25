// Render bench: loads each mod's real code, builds its element tree at several
// workspace sizes, and reports the cost of one render.
//
// This measures the JavaScript half of a render — data prep plus element
// construction. The app then lays out and paints that tree in Rust, which no
// bench here can see. Element count is reported alongside the time because the
// Rust half scales with it: more elements means more layout, whatever the ms.

import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

import { applyScene, buildScene, counts, makeCx, resetCounts, settle, state } from "../lib/env.mjs";

const home = process.env.HERDR_HOME ?? `${homedir()}/.config/herdr-app`;
const modUrl = (path) => pathToFileURL(`${home}/mods/${path}`).href;

// One entry per copy the live layouts actually instantiate, plus the shipped
// mods we forked, so a fork can be read against the original it came from.
export const TARGETS = [
  { name: "herdr-van:brand", path: "herdr-van/main.js", props: { part: "brand" } },
  { name: "herdr-van:spaces", path: "herdr-van/main.js", props: { part: "spaces" } },
  { name: "herdr-van:agents", path: "herdr-van/main.js", props: { part: "agents" } },
  { name: "herdr-van:footer", path: "herdr-van/main.js", props: { part: "footer" } },
  { name: "herdr-van:tabs", path: "herdr-van/main.js", props: { part: "tabs" } },
  { name: "herdr-van:pane", path: "herdr-van/main.js", props: { part: "pane", pane: "p0", terminal: "t100" } },
  { name: "herdr-van:jump", path: "herdr-van/main.js", props: { part: "jump" } },
  { name: "herdr-van:runner", path: "herdr-van/main.js", props: { part: "runner" } },
  { name: "herdr-van:spaceMenu", path: "herdr-van/main.js", props: { part: "spaceMenu" } },
  { name: "herdr-van:icon", path: "herdr-van/main.js", props: { part: "icon" } },
  { name: "herdr-filechanges", path: "herdr-filechanges/main.js", props: {} },
  { name: "herdr-tui-prefix", path: "herdr-tui-prefix/main.js", props: {} },
  { name: "media", path: "media/main.js", props: { block: "media" } },
  { name: "upstream:spaces", path: "spaces/main.js", props: {}, comparison: true },
  { name: "upstream:agents", path: "agents/main.js", props: {}, comparison: true },
  { name: "upstream:tabs", path: "tabs/main.js", props: {}, comparison: true },
  { name: "upstream:files", path: "files/main.js", props: {}, comparison: true },
  { name: "upstream:changes", path: "changes/main.js", props: {}, comparison: true },
];

export const SCALES = [
  { name: "small", spaces: 4, agents: 6, tabsPerSpace: 1, panesPerTab: 1 },
  { name: "typical", spaces: 12, agents: 18, tabsPerSpace: 2, panesPerTab: 2 },
  { name: "heavy", spaces: 40, agents: 80, tabsPerSpace: 3, panesPerTab: 2 },
];

const RENDERS = 40;
const WARMUP = 5;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function measure(target, scale) {
  const scene = buildScene(scale);
  applyScene(scene);
  state.props = target.props;

  // A mod that logs while it loads is reporting its own environment, not a
  // finding: swallow it and count it, so a run's output stays the tables.
  const written = console.log;
  const writtenError = console.error;
  console.log = () => { counts.logs++; };
  console.error = () => { counts.logs++; };
  try {
    const module = await import(modUrl(target.path));
    const Ctor = module.default;
    if (typeof Ctor !== "function") throw new Error(`${target.name}: no default export class`);

    resetCounts();
    const cx = makeCx(target.name);
    const instance = new Ctor();
    const initAt = performance.now();
    instance.init(target.props, cx);
    const initMs = performance.now() - initAt;
    const initElements = counts.elements;
    const timers = counts.timers.map((t) => t.ms);

    // Let a mod's own loading finish first: what it renders afterwards is the view
    // people actually see, not the placeholder before the data arrives.
    await settle();

    for (let i = 0; i < WARMUP; i++) instance.render(makeCx(target.name));

    const samples = [];
    let elements = 0;
    resetCounts();
    for (let i = 0; i < RENDERS; i++) {
      const renderCx = makeCx(target.name);
      const at = performance.now();
      instance.render(renderCx);
      samples.push(performance.now() - at);
      elements += counts.elements;
      counts.elements = 0;
    }

    return {
      target: target.name,
      scale: scale.name,
      spaces: scale.spaces,
      agents: scale.agents,
      initMs,
      initElements,
      timers,
      renderMs: median(samples),
      renderMax: Math.max(...samples),
      elements: elements / RENDERS,
      notifies: counts.notifies,
      commands: counts.runs.length,
      listFailures: counts.listFailures,
      spawnErrors: counts.spawnErrors.length,
    };
  } finally {
    console.log = written;
    console.error = writtenError;
  }
}

export async function runRender({ targets = TARGETS, scales = SCALES, log = () => {} } = {}) {
  const rows = [];
  for (const target of targets) {
    for (const scale of scales) {
      try {
        const row = await measure(target, scale);
        rows.push({ ...row, comparison: Boolean(target.comparison) });
        log(`  ${row.target.padEnd(20)} ${row.scale.padEnd(8)} ${row.renderMs.toFixed(3).padStart(8)} ms  ${Math.round(row.elements).toString().padStart(5)} el`);
      } catch (error) {
        rows.push({ target: target.name, scale: scale.name, error: error.message });
        log(`  ${target.name.padEnd(20)} ${scale.name.padEnd(8)} FAILED: ${error.message}`);
      }
    }
  }
  return rows;
}
