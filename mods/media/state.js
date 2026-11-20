// The files the helper publishes, as the mod reads them. One writer each: the helper owns
// state.json, levels.json, tick and the covers; the mod owns beat and the transport clicks.
import { appHome, readTextFile, writeTextFile } from "herdr";

export const mediaFile = (name) => `${appHome()}/data/media/${name}`;

// A read that never throws: a missing file is an empty body, which every caller reads as "nothing".
export const readText = (name) => readTextFile(mediaFile(name)).catch(() => "");

// writeTextFile is a read-modify-write: it needs the body it expects to find. An empty expectation
// means "there is no beat yet", which is how a first write creates the file.
export async function writeBeat(body, expected) {
  await writeTextFile(mediaFile("beat"), body, expected || undefined);
}

// A transport click. The helper polls this file; `n` is the click's timestamp, so a number is
// never reused across a restart of either side.
export async function writeCommand(body, expected) {
  await writeTextFile(mediaFile("cmd"), body, expected || undefined);
}
