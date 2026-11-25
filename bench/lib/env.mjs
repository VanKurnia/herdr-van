// Scenario data and counters shared by the stubs and the benches.
//
// The stubs answer the herdr API with whatever this module holds, so a bench
// changes the scene and renders again: no app, no window, no real git.

export const counts = {
  elements: 0, // elements constructed since the last reset
  notifies: 0, // cx.notify() calls
  spawns: 0, // cx.spawn() calls
  overlays: 0,
  shared: 0, // setShared() calls (each re-renders every mod)
  runs: [], // commands a render asked for
  execs: 0,
  hc: 0,
  listItems: 0, // virtual-list rows the stubs actually rendered
  listFailures: 0, // rows whose render callback threw (signature mismatch)
  timers: [], // { ms, fn, where } every registered timer, never fired
  spawned: [], // promises cx.spawn() started, settled (bounded) before rendering
  spawnErrors: [], // what a spawned task threw, swallowed so one mod cannot stop a run
  logs: 0, // console lines a mod printed while loading or rendering
};

export function resetCounts() {
  counts.elements = 0;
  counts.notifies = 0;
  counts.spawns = 0;
  counts.overlays = 0;
  counts.shared = 0;
  counts.runs = [];
  counts.execs = 0;
  counts.hc = 0;
  counts.listItems = 0;
  counts.listFailures = 0;
  counts.timers = [];
  counts.spawned = [];
  counts.spawnErrors = [];
  counts.logs = 0;
}

export const state = {
  spaces: [],
  agents: [],
  panes: [],
  terminals: [],
  machines: [{ name: null, layout: "ready" }],
  layout: null,
  props: {},
  shared: new Map(),
  snapshotFiles: 24, // entries in the generated herdr-filechanges snapshot
  settings: { font_size: 14, zoom: 1, font_family: "JetBrains Mono", font_weight: 500, dark: true, pane_scrollbars: true, copy_on_select: true, clipboard_write: true },
};

const program = (key, name, icon) => ({ key, name, icon, tint: true, tile: "#334155", color: "#ffffff", shell: false, agent: true });

const APP = { key: "pi", name: "Pi", icon: "icons/pi.svg" };

// A plausible workspace at a given size. Everything a mod reads comes from
// here, so a bigger scene is a bigger render and nothing else.
export function buildScene({ spaces = 12, agents = 18, tabsPerSpace = 2, panesPerTab = 2, branch = true } = {}) {
  state.snapshotFiles = Math.max(8, spaces * 2); // the filechanges panel's list grows with the scene
  const now = Date.now();
  const out = { spaces: [], agents: [], panes: [], terminals: [] };
  let agentAt = 0;
  for (let s = 0; s < spaces; s++) {
    const id = `sp${String(s).padStart(3, "0")}`;
    const named = s % 3 !== 0;
    const tabs = [];
    for (let t = 0; t < tabsPerSpace; t++) {
      tabs.push({
        id: `${id}t${t}`, index: t + 1, name: t === 0 ? "main" : `work ${t}`, named: t !== 0,
        active: t === 0, status: s % 4 === 0 ? "working" : null, panes: panesPerTab, zoomed: false,
        settled: false, settled_at: null, changed_at: now - 1000 * (s + t),
        working_since: s % 4 === 0 ? now - 60000 : null,
      });
    }
    out.spaces.push({
      id, index: s, name: named ? `project ${s}` : `/src/repo-${s}`, named,
      folder: `C:/src/repo-${s}`, machine: s === 5 ? "vps" : null,
      branch: branch ? ["main", "feat/login", "fix/units", "master"][s % 4] : null,
      active: s === 0, status: s % 4 === 0 ? "working" : null, tabs,
    });
    for (let t = 0; t < tabsPerSpace; t++) {
      for (let p = 0; p < panesPerTab; p++) {
        const address = `t${100 + out.panes.length}`;
        out.panes.push({
          pane: `p${out.panes.length}`, terminal: address, tab: tabs[t].id, title: `zsh ${s}.${t}.${p}`,
          name: null, cwd: `C:/src/repo-${s}`, branch: branch ? "feat/login" : null,
          status: null, app: null, program: { key: "shell", name: "Shell", icon: null, tint: true, tile: null, color: null, shell: true, agent: false },
          focused: out.panes.length === 0, zoomed: false, movable: true, scroll: { total: 400, offset: 400, len: 30, from_bottom: 0 },
        });
        out.terminals.push({ address, machine: s === 5 ? "vps" : null, cwd: `C:/src/repo-${s}`, labels: {}, parent: null });
      }
    }
  }
  // Agents spread across the spaces, one per tab where there are enough.
  for (let i = 0; i < agents; i++) {
    const sp = out.spaces[i % out.spaces.length];
    const tab = sp.tabs[i % sp.tabs.length];
    const pane = out.panes[i % out.panes.length];
    const status = ["working", "idle", "blocked", "done"][i % 4];
    out.agents.push({
      address: `t${100 + i}`, pane: pane.pane, space: sp.id, space_name: sp.name, tab: tab.id,
      tab_index: tab.index, tab_name: tab.name, status, app: "pi",
      program: program(APP.key, APP.name, APP.icon), title: `fix the ${i} thing`,
      pane_name: null, seq: agents - i, pinned: i === 0, focused: i === 1,
    });
    agentAt++;
  }
  out.layout = {
    id: "root", type: "row",
    children: [
      {
        id: "sidebar", type: "column", size: { px: 268 },
        children: [
          { id: "brand", type: "block", size: { px: 46 }, content: { mod: "herdr-van" } },
          { id: "spaces", type: "block", content: { mod: "herdr-van" } },
          { id: "agents", type: "block", content: { mod: "herdr-van" } },
          { id: "sidebar-footer", type: "block", size: { px: 40 }, content: { mod: "herdr-van" } },
        ],
      },
      {
        id: "work", type: "column",
        children: [
          { id: "tabs", type: "block", size: { px: 42 }, content: { mod: "herdr-van" } },
          { id: "main", type: "block", content: { tab: "active" } },
        ],
      },
    ],
  };
  return out;
}

export function applyScene(scene) {
  state.spaces = scene.spaces;
  state.agents = scene.agents;
  state.panes = scene.panes;
  state.terminals = scene.terminals;
  state.layout = scene.layout;
}

// What the app hands a mod copy: one per render, never kept.
export function makeCx(where = "") {
  const cx = {
    timer: {
      every: (ms, fn) => counts.timers.push({ ms, fn, where }),
      after: (ms, fn) => counts.timers.push({ ms, fn, where, once: true }),
    },
    // Work started from init or a callback: run it, so a mod that fills its state
    // asynchronously renders the populated view rather than an empty one.
    spawn: (fn) => {
      counts.spawns++;
      const started = Promise.resolve().then(() => fn(cx));
      counts.spawned.push(started.catch((error) => { counts.spawnErrors.push(String(error?.message ?? error)); }));
      return null;
    },
    // The real kit hands out a cancellable wait; loading time is not measured, so
    // it resolves on the next turn instead of sleeping.
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    notify: () => { counts.notifies++; },
    focus_handle: () => ({ focus() {}, blur() {}, is_focused: () => false }),
    stop_propagation: () => {},
    global: () => ({ stop_propagation: () => {} }),
  };
  return cx;
}

// Loading is not what is being measured, but it has to finish: a task that waits
// on something the stubs never answer (a command loop) is abandoned, not awaited.
export const settle = (ms = 50) => Promise.race([
  Promise.allSettled(counts.spawned),
  new Promise((resolve) => setTimeout(resolve, ms)),
]);
