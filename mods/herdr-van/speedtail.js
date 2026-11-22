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

const HEAD_BYTES = 65536; // the first line names the session and the one it continues
const OWN = /^[0-9a-f]{8}-[0-9a-f]{4}-/i; // pi's own ids; a sub-agent's carry the agent's name

// The first line's record, or null for a file that is not a session head.
const head = function (file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const got = fs.readSync(fd, buf, 0, buf.length, 0);
    return JSON.parse(buf.toString("utf8", 0, got).split("\n")[0]);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
};

const sessions = function (dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (f.slice(-6) !== ".jsonl") continue;
    const file = dir + "/" + f;
    try {
      out.push({ file, at: fs.statSync(file).mtimeMs, head: head(file) });
    } catch {
      // a session being replaced, or one this user cannot read: skip it, do not fail
    }
  }
  return out;
};

// A sub-agent runs in its parent's folder and writes there, so the newest file in the folder is
// often the agent's, not the person's: herdr names those sessions after the agent, while the
// person's own carry pi's uuid. The newest own session is the one in use; following its parent
// chain back keeps the wave across a compaction, which starts a new file.
const pick = function (dir) {
  const all = sessions(dir);
  const mine = all.filter((s) => s.head && OWN.test(String(s.head.id ?? "")));
  let newest = null;
  for (const s of mine) if (!newest || s.at > newest.at) newest = s;
  if (!newest) return []; // no session of the person's here: nothing to draw, not someone else's
  // A parent is named by its path, whose stem is `<timestamp>_<id>`: index both, since the id alone
  // is what a session header carries.
  const byName = new Map();
  for (const s of all) {
    byName.set(s.file.replace(/^.*[\\/]/, "").replace(/\.jsonl$/, ""), s);
    if (s.head && s.head.id) byName.set(String(s.head.id), s);
  }
  const chain = [newest];
  // Up the continuations to the session this one grew out of. The seen-check ends the walk: every
  // step adds a file that was not in the chain already.
  for (;;) {
    const parent = chain[0].head && chain[0].head.parentSession;
    if (!parent) break;
    const prev = byName.get(String(parent).replace(/^.*[\\/]/, "").replace(/\.jsonl$/, ""));
    if (!prev || chain.indexOf(prev) >= 0) break;
    chain.unshift(prev);
  }
  return chain.map((s) => s.file);
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

const count = +flag("n", 40);
const dir = flag("dir");
const file = flag("file") || null;
let rows = [];
try {
  for (const f of file ? [file] : dir ? pick(dir) : []) rows = rows.concat(read(f, count));
} catch {
  rows = []; // no session here yet, or one being replaced: nothing to draw, not an error
}
process.stdout.write(JSON.stringify(rows.slice(-count)));
