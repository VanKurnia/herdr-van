// The files the helper publishes, as the mod reads them, and the writes back. One writer each: the
// helper owns state.json, levels.json, tick and the covers; the mod owns beat and the clicks.
import { appHome, readTextFile, writeTextFile } from "herdr";

export const mediaFile = (name) => `${appHome()}/data/media/${name}`;

// A read that never throws: a missing file is an empty body, which every caller reads as "nothing".
// A real failure (permissions, too many open files, a locked file) would otherwise read as "nothing
// playing", so each distinct reason is logged once instead of being swallowed silently.
const logged = new Set();
export const readText = (name) =>
  readTextFile(mediaFile(name)).catch((error) => {
    const why = String(error?.message ?? error);
    if (!logged.has(why)) {
      logged.add(why);
      console.log(`media: reading ${name} failed: ${why}`);
    }
    return "";
  });

// writeTextFile is a read-modify-write: it needs the body it expects to find, and an empty
// expectation means "there is no file yet", which is how a first write creates one.
export async function writeFile(name, body, expected) {
  await writeTextFile(mediaFile(name), body, expected || undefined);
}
