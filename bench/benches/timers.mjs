// Timer budget: what each mod asks of the process per minute, read from its
// source. A render is only part of the cost — the rest is timers that wake up,
// poll, spawn programs and write shared state, whether or not anything changed.
//
// The scan is static: it reads the registration and the lines just after it to
// see whether the callback returns early while the window is hidden. It does not
// run the timer, so an early return inside a nested promise is not seen.

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";

const home = process.env.HERDR_HOME ?? `${homedir()}/.config/herdr-app`;
const MODS = ["herdr-van", "herdr-filechanges", "herdr-tui-prefix", "media"];
const GUARD_WINDOW = 4; // lines after a registration in which an early return may sit

// A period is often a named constant (an 80 ms level poll hides behind LEVELS_MS
// easily), so resolve those before reporting, or the budget reads far too low.
function constants(source) {
  const found = new Map();
  for (const match of source.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*(\d+)\s*;/g)) found.set(match[1], Number(match[2]));
  return found;
}

export async function runTimers({ mods = MODS } = {}) {
  const rows = [];
  for (const mod of mods) {
    const dir = `${home}/mods/${mod}`;
    let files = [];
    try { files = (await readdir(dir)).filter((f) => f.endsWith(".js")); } catch { continue; }

    for (const file of files.sort()) {
      const source = await readFile(`${dir}/${file}`, "utf8");
      const lines = source.split("\n");
      const consts = constants(source);

      lines.forEach((line, index) => {
        for (const match of line.matchAll(/cx\.timer\.(every|after)\(\s*([A-Za-z0-9_]+)\s*,/g)) {
          // The callback body, not the neighbouring registrations: a guard on the
          // next timer must not launder this one.
          let end = index + 1;
          while (end < lines.length && end <= index + GUARD_WINDOW && !/cx\.timer\./.test(lines[end])) end++;
          const near = lines.slice(index, end).join("\n");
          const gated = /hidden\(\)|visible === false/.test(near);
          const calls = [];
          if (/\bexec\(/.test(near)) calls.push("exec");
          if (/\bhc\(/.test(near)) calls.push("hc");
          if (/\breadTextFile\(|\breadText\(/.test(near)) calls.push("read");
          if (/\bsetShared\(/.test(near) || /syncProcs|refreshMachines|refreshGit|sync\(/.test(near)) calls.push("work");
          const literal = Number(match[2].replace(/_/g, ""));
          rows.push({
            mod, file, line: index + 1, kind: match[1],
            ms: Number.isFinite(literal) ? literal : consts.get(match[2]) ?? null,
            gated, calls,
            code: line.trim().slice(0, 110),
          });
        }
      });
    }
  }
  return rows;
}

// Per-mod totals: wake-ups per minute while the window is shown, and the share
// that keeps running while it is hidden. A one-shot (`after`) is not a rate and
// is counted only in the timer total.
export function timerTotals(rows) {
  const mods = [...new Set(rows.map((r) => r.mod))];
  return mods.map((mod) => {
    const own = rows.filter((r) => r.mod === mod);
    const repeating = own.filter((r) => r.kind === "every" && r.ms > 0);    const perMinute = (list) => list.reduce((sum, r) => sum + 60000 / r.ms, 0);
    return {
      mod,
      timers: own.length,
      shownPerMinute: Math.round(perMinute(repeating)),
      hiddenPerMinute: Math.round(perMinute(repeating.filter((r) => !r.gated))),
      withWork: own.filter((r) => r.calls.length && !r.gated).length,
    };
  });
}
