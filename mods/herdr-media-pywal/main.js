// Follow the artwork: the cover the media mod is playing becomes the window's colours.
//
// The media mod already publishes what it is playing in data/media/state.json, cover included. This
// mod reads that, has pywal.py turn the cover into a wallpaper and a theme, and puts both in front of
// the user. Nothing here draws: it renders nothing, so its floating slot stays out of the way.
//
// What it will not do:
//   - fight the user: a theme they pick stays picked until the next cover arrives, and once this mod
//     has been told to stop (palette: Follow the artwork), it stops for good (the flag is sticky).
//   - change a window it never changed: if it has not applied anything, it has nothing to revert.
//   - act on a picture it could not read: a failed generation leaves the current colours alone.
//
// The base theme and the base wallpaper are never touched. `tokyo-night` and the base wallpaper are
// what "off" means, and they are restored as paths, not as regenerated colours.
import { View } from "gpui-kit";
// The shell installs a global `window` (the gpui Window object: `window.localStorage`, its dialogs),
// and that global shadows an import of the same name — `import { window }` yields the object, so
// calling it throws "not a function". The alias is what makes herdr's presentation signal reachable
// at all; gpui-kit's Window has no `visible`, only `is_window_active()`, which is focus.
import {
  appHome, checking, exec, layout, nextCommand, notify, readTextFile, run, shared, watchFolder,
  window as appWindow, writeTextFile,
} from "herdr";

const STATE = "data/media/state.json"; // the media mod's contract: title, playing, cover
const THEME = "pywal"; // written here, applied here
const BASE_THEME = "tokyo-night"; // the theme to come back to
const BASE_WALLPAPER = "backgrounds/tokyo-grid.png";
const FLAG = "herdr-media-pywal.disabled"; // sticky: the user turned it off
const POLL_MS = 5000;

// The payload a palette is made from. The helper also writes `beat`, `tick` and `levels.json` twelve
// times a second; a watch batch carrying only those has nothing to say about colours.
const PAYLOAD = /(state\.json|cover-[^/\\]+\.png)$/i;

const home = () => appHome();
const statePath = () => `${home()}/${STATE}`;
const dataDir = () => `${home()}/data/herdr-van/herdr-media-pywal`;
const scriptPath = () => `${home()}/mods/herdr-media-pywal/pywal.py`;
const themePath = () => `${home()}/themes/${THEME}.json`;

// Herdr's layout() is an untyped tree; this walks it for the blocks it needs to know about.
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
  for (const floating of node.floating ?? []) walk(floating, visit);
}

function showsMedia() {
  let found = false;
  walk(layout(), (node) => {
    const content = node.content;
    if (content?.mod === "media" && !node.hidden) found = true;
  });
  return found;
}

function shownLayout() {
  const name = shared("layout");
  return typeof name === "string" && name ? name : null;
}

export default class MediaPywal extends View {
  init(_props, cx) {
    this.applied = null; // the cover we generated for last
    this.touched = false; // whether the theme or wallpaper has been changed by this mod
    this.problem = null; // the last failure, for the palette to report
    this.busy = false;
    this.watch = null; // the pending folder watch, kept so close() can release it
    this.disabled = localStorage.getItem(FLAG) === "1";
    if (checking()) return;
    cx.spawn((cx) => this.observe(cx));
    // A tick that does nothing while the window is not presenting: the work is paused, not the
    // timer, so the first tick after the window comes back is what catches up.
    cx.timer.every(POLL_MS, (cx) => {
      if (this.presenting()) this.sync(cx);
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const name = await nextCommand();
        if (name === "toggle") this.toggle(cx);
        if (name === "refresh") {
          this.applied = null;
          this.sync(cx);
        }
      }
    });
  }

  // The media mod writes state.json and a cover in one go; watching the folder means a track change
  // is answered at once instead of at the next poll. The poll is the fallback: a watch can be
  // reclaimed, and a failure must not leave the colours stuck on the last song forever.
  //
  // The handle is kept so close() can cancel it, and a batch of the helper's per-frame files is
  // dropped: watching a folder is cheap, reacting to every beat it writes is not.
  async observe(cx) {
    for (;;) {
      if (this.presenting()) this.sync(cx);
      try {
        this.watch = watchFolder(`${home()}/data/media`);
        const changed = await this.watch;
        this.watch = null;
        if (changed.some((path) => PAYLOAD.test(String(path))) && this.presenting()) this.sync(cx);
      } catch {
        // Nothing to watch yet, or the watch was reclaimed: wait, then try again.
        this.watch = null;
        await cx.sleep(3000);
      }
    }
  }

  // False while the window is minimized, hidden or covered: work that only paints a window nobody
  // can see can wait for the tick after it comes back.
  presenting() {
    return appWindow()?.visible !== false;
  }

  // The watch is the only thing this copy holds. Cancel it on close so the next copy is not
  // competing for the app's pending watches; the colours stay as they were last applied, because
  // unmounting a floating slot is not the user asking for the base theme back.
  close() {
    this.watch?.cancel();
    this.watch = null;
  }

  toggle(cx) {
    this.disabled = !this.disabled;
    localStorage.setItem(FLAG, this.disabled ? "1" : "0");
    this.applied = null;
    notify({
      title: this.disabled ? "Colours follow the artwork: off" : "Colours follow the artwork: on",
      body: this.disabled ? "Back to the base theme and wallpaper." : "The next cover repaints the window.",
    });
    this.sync(cx);
  }

  async sync(cx) {
    if (this.busy) return; // one generation at a time: a second would race the files
    if (this.disabled) {
      await this.revert(cx, "off");
      return;
    }
    if (!showsMedia()) {
      // Toggled off by the user: the media mod is not in this layout, so nothing is playing here.
      await this.revert(cx, "media not shown");
      return;
    }
    // readTextFile resolves with null for a file that is not there, and rejects only for a real
    // failure. Those are different things: absent means nothing is playing; unreadable means the
    // colours should stay as they are rather than flap to the base theme over a locked file.
    let text = null;
    try {
      text = await readTextFile(statePath());
    } catch (error) {
      console.log(`herdr-media-pywal: reading state.json failed: ${error?.message ?? error}`);
      return;
    }
    if (!text) {
      await this.revert(cx, "nothing playing");
      return;
    }
    let state;
    try {
      state = JSON.parse(text);
    } catch {
      console.log("herdr-media-pywal: state.json is not JSON; leaving the colours alone");
      return;
    }
    const cover = typeof state?.cover === "string" ? state.cover : "";
    if (!cover) {
      await this.revert(cx, "no cover");
      return;
    }
    if (cover === this.applied) return; // already the window's colours
    // A paused track keeps its cover: the window stays on it rather than flashing back.
    if (state.playing === false && state.session === false) {
      await this.revert(cx, "stopped");
      return;
    }

    this.busy = true;
    try {
      const result = await this.generate(cx, cover, state);
      if (!result?.ok) {
        this.problem = result?.error ?? "generation failed";
        console.log(`herdr-media-pywal: ${this.problem}`);
        return;
      }
      await this.paint(cx, result);
      this.applied = cover;
      this.problem = null;
    } catch (error) {
      this.problem = String(error?.message ?? error);
      console.log(`herdr-media-pywal: ${this.problem}`);
    } finally {
      this.busy = false;
    }
  }

  async generate(cx, cover, state) {
    const args = [
      scriptPath(),
      "--cover", `${home()}/${cover}`,
      "--app-home", home(),
      "--data-dir", dataDir(),
      "--title", typeof state?.title === "string" ? state.title : "",
    ];
    const out = await exec("python", args, { timeout: 120000 });
    const text = String(out.stdout ?? "").trim();
    const line = text.split("\n").filter(Boolean).pop() ?? "";
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`pywal.py said: ${line || String(out.stderr ?? "").slice(0, 200)}`);
    }
  }

  // Both halves are the app's own files: the theme is a file in themes/, the wallpaper a path in the
  // shown layout. Writing the layout's background is a text edit of the one field, so everything
  // else in that file — sizes, colours, mods — is left exactly as the user wrote it.
  async paint(cx, result) {
    run("app.theme", { name: result.theme });
    await this.setBackground(result.wallpaper);
    this.touched = true;
  }

  async revert(cx, why) {
    if (!this.touched) return; // never changed it, so there is nothing to put back
    run("app.theme", { name: BASE_THEME });
    await this.setBackground(BASE_WALLPAPER);
    this.touched = false;
    this.applied = null;
    console.log(`herdr-media-pywal: reverted (${why})`);
  }

  async setBackground(path) {
    const name = shownLayout();
    if (!name) return;
    const file = `${home()}/layouts/${name}.json`;
    let text = null;
    try {
      text = await readTextFile(file);
    } catch (error) {
      console.log(`herdr-media-pywal: cannot read ${file}: ${error?.message ?? error}`);
      return;
    }
    if (!text) return;
    const next = text.replace(/"image"\s*:\s*"backgrounds\/[^"]*"/, `"image": "${path}"`);
    if (next === text) return; // already that picture: rewriting would only churn the file
    try {
      await writeTextFile(file, next, text);
    } catch (error) {
      console.log(`herdr-media-pywal: cannot write ${file}: ${error?.message ?? error}`);
    }
  }

  // Nothing is drawn. The kit has no empty-element API: `render` must return an Element, an Entity
  // or a string, so an empty string is the one description that draws nothing. A floating block
  // sizes to its content, so this copy keeps running with no frame over the layout (measured: the
  // corner under it is the theme background across 92% of its pixels).
  render() {
    return "";
  }
}
