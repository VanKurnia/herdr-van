// The tab bar's token rates, read from pi's own session log.
//
// pi appends one entry per finished message, carrying that message's `usage.output` and
// `durationMs`, so the log is the honest source for tokens per second — and it gains entries at
// message end, which is the finest granularity it has. Reads only the tail: sessions reach tens of
// megabytes.
//
//   node speedtail.js --dir=<session folder> [--n=40]
//   node speedtail.js --file=<session.jsonl> [--n=40]
//
// Prints `[[time, outputTokens, durationMs], ...]`, oldest first. Empty list if there is nothing.
const fs = require("node:fs");

const argv = process.argv.slice(1);
const flag = function (name, dflt) {
  for (const a of argv) if (a.indexOf("--" + name + "=") === 0) return a.slice(name.length + 3);
  return dflt;
};

// The newest session in a folder is the one that is still being written.
const newest = function (dir) {
  let best = null, at = 0;
  for (const f of fs.readdirSync(dir)) {
    if (f.slice(-6) !== ".jsonl") continue;
    const file = dir + "/" + f;
    const m = fs.statSync(file);
    if (m.mtimeMs > at) {
      at = m.mtimeMs;
      best = file;
    }
  }
  return best;
};

const read = function (path, count) {
  const size = fs.statSync(path).size;
  const start = Math.max(0, size - 524288);
  const fd = fs.openSync(path, "r");
  const buf = Buffer.alloc(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const out = [];
  for (const line of buf.toString("utf8").split("\n")) {
    if (line.indexOf('"assistant"') < 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the first line may be cut by the window
    }
    const m = entry.message;
    if (!m || !m.usage || m.role !== "assistant") continue;
    const ms = m.durationMs | 0;
    const tokens = m.usage.output | 0;
    if (ms <= 0) continue;
    out.push([Date.parse(entry.timestamp || m.timestamp || 0) || 0, tokens, ms]);
  }
  return out.slice(-count);
};

const dir = flag("dir");
let file = flag("file") || null;
let rows = [];
try {
  if (!file && dir) file = newest(dir);
  if (file) rows = read(file, +flag("n", 40));
} catch {
  rows = []; // no session here yet, or one being replaced: nothing to draw, not an error
}
process.stdout.write(JSON.stringify(rows));
