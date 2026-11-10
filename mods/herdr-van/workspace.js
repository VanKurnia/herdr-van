// Workspace snapshots: what each live space is shaped like, kept in shared
// state so the sidebar list and restore can render it. No UI here, only the
// store and the readers that fill it.

import { readTextFile, spaces, panes, home, shared, setShared, run, notify } from "herdr";

export const LIST = "workspace.list";
export const MODE = "workspace.mode";

// The store, always shaped: a version and the saved records.
export function list() {
  const s = shared(LIST);
  if (s && typeof s === "object" && Array.isArray(s.records)) return { v: 1, records: s.records };
  return { v: 1, records: [] };
}

// A write re-renders every part, so only a real change is written.
export function writeList(next) {
  if (JSON.stringify(shared(LIST)) === JSON.stringify(next)) return;
  setShared(LIST, next);
}

// One pass per render: the record behind each live space, for its icon.
export function liveRecords() {
  const map = new Map();
  for (const r of list().records) if (r.live != null) map.set(r.live, r);
  return map;
}

const patchIcon = (id, icon) => writeList({ v: 1, records: list().records.map((r) => (r.id === id ? { ...r, icon } : r)) });

// The icon of a saved record, or of a live space that has none yet: a live
// space with no record gets one first, because the record is the only thing
// that outlives the space. Returns { error } when the save cannot happen.
export async function setIcon({ space, record: id }, icon) {
  // A row's record can lag a render behind, so the live space answers for it.
  const target = id ?? liveRecords().get(space)?.id;
  if (target) { patchIcon(target, icon); return null; }
  if (!icon) return null;
  const saved = await saveSpace(space);
  if (saved.error) return saved;
  patchIcon(saved.id, icon);
  return null;
}

// The core's app document (spaces and their tab trees), or null. Never throws: a
// mod must not throw in init, or the sidebar keeps the last good build.
export async function readDoc() {
  try {
    const base = home().replace(/\\/g, "/").replace(/\/$/, "");
    for (const dir of ["AppData/Local/herdr-core", ".local/share/herdr-core"]) {
      const text = await readTextFile(`${base}/${dir}/default/docs.json`);
      if (text == null) continue;
      const value = JSON.parse(text)?.["herdr-app"]?.value;
      if (Array.isArray(value?.spaces)) return value;
    }
  } catch {}
  return null;
}

// Cheap string for "did the structure change": space and tab ids with pane
// counts, plus each pane's id and live folder. Takes the arrays the caller
// already read — never calls spaces()/panes() here (the 1 s tick copies both).
export function signature(sp, ps) {
  const tabs = sp.map((s) => `${s.id}:${(s.tabs ?? []).map((t) => `${t.id}/${t.panes}`).join(",")}`).join(";");
  const folders = ps.map((p) => `${p.pane}=${p.cwd ?? ""}`).join(";");
  return `${tabs}|${folders}`;
}

// A doc tree with ids and weights stripped (they change on re-creation and
// weights are not restorable): containers keep type and children only, leaves
// keep their content verbatim plus their live folder, matched by terminal
// address rather than array position.
function copyRoot(root, ps) {
  if (!root) return root;
  if (root.type === "block") {
    const term = root.content?.terminal;
    const cwd = term == null ? null : (ps.find((p) => p.terminal === term)?.cwd ?? null);
    return { type: "block", content: root.content, cwd };
  }
  return { type: root.type, children: (root.children ?? []).map((c) => copyRoot(c, ps)) };
}

// Every live space's shape, keyed by space id: name and folder from the doc,
// named/machine/active from spaces() (live-only; the doc has no such fields).
export function snapshotDoc(doc) {
  const sp = spaces();
  const ps = panes();
  const out = {};
  for (const s of doc.spaces ?? []) {
    if (!s || !s.id) continue;
    const live = sp.find((x) => x.id === s.id);
    out[s.id] = {
      name: s.name,
      named: live?.named ?? false,
      folder: s.folder,
      machine: live?.machine ?? null,
      tabs: (s.tabs ?? []).map((t) => {
        const lt = live?.tabs?.find((x) => x.id === t.id);
        return { name: t.name, named: lt?.named ?? false, active: lt?.active ?? false, root: copyRoot(t.root, ps) };
      }),
    };
  }
  return out;
}

// The store's only constructor, so the record shape lives in one place.
// `machine` stays null: only this machine's spaces are saved.
function record(snap, { id, auto, live, icon }) {
  const now = Date.now();
  return {
    id: id ?? "w" + now.toString(36) + Math.random().toString(36).slice(2, 5),
    name: snap.name,
    named: snap.named,
    folder: snap.folder,
    machine: null,
    auto,
    saved_at: now,
    live,
    icon: icon ?? null,
    tabs: snap.tabs,
  };
}

// Save a live space as an explicit workspace. A record with the same folder and
// name is refreshed in place, so saving twice never appends.
export async function saveSpace(spaceId) {
  const doc = await readDoc();
  if (!doc) return { error: "docs.json unavailable" };
  const snap = snapshotDoc(doc)[spaceId];
  if (!snap) return { error: "space not in docs.json" };
  if (snap.machine != null) return { error: "remote spaces cannot be saved here" };
  const { records } = list();
  // Prefer the record already attached to this live space: a renamed space
  // would otherwise fork a second record for the same space.
  const attached = records.findIndex((r) => !r.auto && r.live === spaceId);
  const at = attached >= 0 ? attached : records.findIndex((r) => !r.auto && r.folder === snap.folder && r.name === snap.name);
  const rec = record(snap, { id: records[at]?.id, auto: false, live: spaceId, icon: records[at]?.icon ?? null });
  writeList({ v: 1, records: at < 0 ? [...records, rec] : records.map((r, i) => (i === at ? rec : r)) });
  return { id: rec.id };
}

// Keep spaces that vanished as automatic workspaces, newest first, at most
// AUTO_CAP of them; explicit saves are never pruned.
const AUTO_CAP = 20;

export function saveAuto(spaceSnapshots) {
  const snaps = spaceSnapshots.filter((s) => s && s.machine == null);
  if (!snaps.length) return;
  const records = [...list().records, ...snaps.map((snap) => record(snap, { auto: true, live: null }))];
  const autos = records.filter((r) => r.auto).sort((a, b) => b.saved_at - a.saved_at);
  const drop = new Set(autos.slice(AUTO_CAP).map((r) => r.id));
  writeList({ v: 1, records: drop.size ? records.filter((r) => !drop.has(r.id)) : records });
}

// Forget one saved workspace.
export function dropRecord(id) {
  writeList({ v: 1, records: list().records.filter((r) => r.id !== id) });
}

// A container with one child is that child.
const unwrap = (n) =>
  n && n.type !== "block" && (n.children?.length ?? 0) === 1 ? unwrap(n.children[0]) : n;

// A node's children, with same-type nesting flattened: row[row[a,b],c] -> [a,b,c].
const kids = (n) =>
  (n.children ?? []).flatMap((c) => (c.type === n.type && c.children ? kids(c) : [c]));

// Every leaf, in document order, and the pane ids of the first and last.
const leaves = (n) => (n?.type === "block" ? [n] : (n?.children ?? []).flatMap(leaves));
const firstLeaf = (n) => leaves(n)[0];
const lastLeafPane = (n) => leaves(n).at(-1).id;

// One step: which leaf to add next, beside which pane, in which direction.
// null means the two trees already have the same shape.
export function nextAdd(target, live) {
  const walk = (t, l) => {
    t = unwrap(t);
    l = unwrap(l);
    if (!t || !l) return null;
    // The live side is still one pane: split it toward the target's second
    // child. Fresh spaces start here, so this is the first step of every
    // multi-pane restore.
    if (l.type === "block" && t.type !== "block") {
      const tk = kids(t);
      if (tk.length < 2) return null;
      return {
        direction: t.type === "row" ? "right" : "down",
        anchor: l.id,
        leaf: firstLeaf(tk[1]),
      };
    }
    if (t.type === "block" || l.type === "block" || t.type !== l.type) return null;
    const tk = kids(t);
    const lk = kids(l);
    if (lk.length < tk.length) {
      return {
        direction: t.type === "row" ? "right" : "down",
        anchor: lastLeafPane(lk[lk.length - 1]),
        leaf: firstLeaf(tk[lk.length]),
      };
    }
    for (let i = 0; i < tk.length; i++) {
      if (tk[i].type === "block") continue;
      const deeper = walk(tk[i], lk[i]);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(unwrap(target), unwrap(live));
}

// The folder a restored space (and each of its tabs) starts in.
const startFolder = (rec) => (rec.tabs ?? []).map((t) => firstLeaf(t.root)).find((l) => l?.cwd)?.cwd ?? rec.folder;

// One restore at a time. Module scope, so it is shared by every copy of the mod.
let opening = null;

const sleep = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));

// Waits until probe() returns something truthy; issues no commands itself.
async function until(cx, probe, tries = 40, ms = 150) {
  for (let i = 0; i < tries; i++) {
    const v = probe();
    if (v) return v;
    await sleep(cx, ms);
  }
  return null;
}

export function openWorkspace(rec, cx) {
  if (rec.live && spaces().some((s) => s.id === rec.live)) {
    run("space.select", { id: rec.live });
    return;
  }
  if (opening) {
    notify({ title: "Already opening a workspace", body: opening, level: "warning" });
    return;
  }
  opening = rec.name;
  const before = new Set(spaces().map((s) => s.id));
  run("space.new", { name: rec.name, folder: startFolder(rec) });
  // cx.spawn's context stays valid for this whole task, across awaits.
  cx.spawn(async (cx) => {
    try {
      await build(cx, rec, before);
    } catch (e) {
      notify({ title: "Could not open workspace", body: `${rec.name}: ${e?.message ?? e}`, level: "error" });
    } finally {
      opening = null;
    }
  });
}

async function build(cx, rec, before) {
  const made = await until(cx, () => spaces().find((s) => !before.has(s.id)));
  if (!made) throw new Error("the space never appeared");
  const spaceId = made.id;

  for (let i = 0; i < rec.tabs.length; i++) {
    const want = rec.tabs[i];
    const find = () => spaces().find((s) => s.id === spaceId)?.tabs[i];
    let tab = find();
    if (!tab) {
      // Tab 1 arrives with the space; the rest are created here.
      run("tab.new", { name: want.named ? want.name : undefined, space: spaceId, folder: startFolder({ tabs: [want] }) });
      tab = await until(cx, find);
      if (!tab) throw new Error(`tab ${i + 1} never appeared`);
    } else if (want.named && tab.name !== want.name) {
      run("tab.rename", { id: tab.id, name: want.name });
    }
    await buildTree(cx, rec, spaceId, i, want.root);
  }

  const activeIndex = rec.tabs.findIndex((t) => t.active);
  const tabs = spaces().find((s) => s.id === spaceId)?.tabs ?? [];
  if (activeIndex >= 0 && tabs[activeIndex]) run("tab.select", { id: tabs[activeIndex].id });
  run("space.select", { id: spaceId });
  writeList({ v: 1, records: list().records.map((r) => (r.id === rec.id ? { ...r, live: spaceId } : r)) });
  notify({ title: "Opened workspace", body: rec.name, level: "success" });
}

// Act, re-read the live tree, compare, act again, until nextAdd() returns null.
async function buildTree(cx, rec, spaceId, tabIndex, root) {
  for (let guard = 0; guard < 60; guard++) {
    const doc = await readDoc();
    const liveRoot = doc?.spaces?.find((s) => s.id === spaceId)?.tabs?.[tabIndex]?.root;
    if (!liveRoot) throw new Error("the tab's tree is unreadable");
    const step = nextAdd(root, liveRoot);
    if (!step) return;
    if (step.leaf.content?.mod) {
      run("pane.split", { direction: step.direction, pane: step.anchor, mod: step.leaf.content.mod, props: step.leaf.content.props });
    } else {
      // terminal.open's place is relative to the FOCUSED pane, so focus first
      // and let it land before opening.
      run("pane.focus", { pane: step.anchor });
      await sleep(cx, 120);
      run("terminal.open", { folder: step.leaf.cwd ?? rec.folder, place: step.direction });
    }
    await sleep(cx, 200);
  }
  throw new Error("the tree did not converge");
}
