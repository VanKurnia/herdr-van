// `herdr` as the benches see it: the app's live data, answered from the scene
// the bench built, with the acting half recorded instead of performed.

import { counts, state } from "../env.mjs";

const color = () => "#7aa2f7";
const palette = new Proxy({}, { get: () => color() });

export const theme = () => palette;
export const settings = () => state.settings;
export const props = () => state.props;
export const spaces = () => state.spaces;
export const agents = () => state.agents;
export const panes = () => state.panes;
export const terminals = () => state.terminals;
export const machines = () => state.machines;
export const layout = () => state.layout;
export const layouts = () => ["herdr-van", "main", "terminals", "win98", "neo-brutalism"];
export const keys = () => ({});
export const commands = () => [];
export const updates = () => ({
  app: { ready: false, available: null, version: "0.1.18", checked_at: null },
  core: { ready: false, available: null, version: "0.1.22" },
  notes: [],
});
export const checking = () => false;
export const focused = () => {
  const pane = state.panes.find((p) => p.focused) ?? state.panes[0] ?? null;
  const space = state.spaces.find((s) => s.active) ?? state.spaces[0] ?? null;
  return {
    space: space?.id ?? null, tab: space?.tabs?.[0]?.id ?? null, pane: pane?.pane ?? null,
    terminal: pane?.terminal ?? null, shown: pane?.pane ?? null,
    agent: state.agents.find((a) => a.focused)?.address ?? null, cwd: pane?.cwd ?? null,
    selection: null,
  };
};
export const window = () => ({ visible: true, active: true, buttons: true, platform: "windows", zoom: 1, width: 1512, height: 950 });

export const shared = (key) => state.shared.get(key) ?? null;
export const setShared = (key, value) => {
  counts.shared++;
  state.shared.set(key, value);
};
export const placement = () => null;

export const run = (name, args) => { counts.runs.push(name); return null; };
export const openOverlay = () => { counts.overlays++; return "overlay-bench"; };
export const closeOverlay = () => {};
export const notify = () => {};
export const setAgentOrder = () => {};
export const setWindowTitle = () => {};
export const setBadge = () => {};
export const playSound = () => {};
export const nextCommand = () => new Promise(() => {});

export const exec = async () => { counts.execs++; return { stdout: "", stderr: "", code: 0 }; };
export const hc = async () => { counts.hc++; return ""; };

// The panel reads the snapshot the pi extension writes. Answer it with a
// generated one so the bench renders the busy view, not the empty state.
const snapshot = () => ({
  v: 1,
  terminal: "t100",
  cwd: "C:/src/repo-0",
  updatedAt: Date.now(),
  files: Array.from({ length: state.snapshotFiles }, (_, i) => ({
    path: `app/Models/Thing${i}.php`,
    kind: i % 3 ? "edited" : "created",
    added: 12 + i,
    removed: i,
    updatedAt: Date.now(),
    diff: `--- a/app/Models/Thing${i}.php\t\n+++ b/app/Models/Thing${i}.php\t\n@@ -1,3 +1,4 @@\n context\n-removed\n+added\n`,
  })),
});

export const readTextFile = async (path) => (String(path).includes("herdr-filechanges") ? JSON.stringify(snapshot()) : "");
export const writeTextFile = async () => true;
export const pickFolder = async () => null;
export const pickFiles = async () => null;
export const knownAgents = async () => [];

const watched = () => {
  const p = new Promise(() => {});
  p.cancel = () => {};
  return p;
};
export const watchFolder = () => watched();

export const home = () => "C:/Users/bench";
export const appHome = () => "C:/Users/bench/.config/herdr-app";
