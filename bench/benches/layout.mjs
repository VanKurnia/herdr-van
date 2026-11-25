// Layout audit: what a layout asks the app to build. Every mod block is one
// live copy of that mod — its timers, its data, its renders — and every pane
// frame wraps a terminal. Counting them is how a layout's cost is read without
// watching the window.

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";

const home = process.env.HERDR_HOME ?? `${homedir()}/.config/herdr-app`;

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
  for (const child of node.floating ?? []) walk(child, visit);
}

export async function runLayout() {
  let names = [];
  try { names = (await readdir(`${home}/layouts`)).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }

  const rows = [];
  for (const file of names) {
    let layout;
    try { layout = JSON.parse(await readFile(`${home}/layouts/${file}`, "utf8")); } catch (error) {
      rows.push({ layout: file, error: error.message });
      continue;
    }
    const mods = new Map();
    let nodes = 0, blocks = 0, modBlocks = 0, hidden = 0, floating = 0, tabs = 0, framed = 0;

    walk(layout, (node) => {
      nodes++;
      if (node.hidden) hidden++;
      if (node.type === "block") {
        blocks++;
        if (node.content?.mod) {
          modBlocks++;
          mods.set(node.content.mod, (mods.get(node.content.mod) ?? 0) + 1);
        }
        if (node.content?.tab) tabs++;
      }
      if (node.type === "row" || node.type === "column" || node.type === "stack") framed++;
      if (node.pane) framed += Object.keys(node.pane).length ? 1 : 0;
    });
    floating = (layout.floating ?? []).length;

    rows.push({
      layout: file.replace(/\.json$/, ""),
      nodes, blocks, modBlocks, hidden, tabs,
      copies: [...mods.entries()].map(([mod, count]) => `${mod}${count > 1 ? ` x${count}` : ""}`).join(", "),
      liveCopies: modBlocks,
    });
  }
  return rows;
}
