"""Generate a wallpaper and a theme from a cover, so the window follows what is playing.

One picture in, two files out:

  backgrounds/pywal-<hash>.png   the base wallpaper's grid, re-hued to the cover's backdrop and
                                 tone-matched so its flat band *is* the theme's background
  themes/pywal.json              the cover's hues in tokyo-night's proportions, with every role
                                 lifted until it clears the contrast tokyo-night already reaches

Called by main.js with the cover to read; prints one JSON object on success.

Why the theme is not sampled from the picture directly: a cover's pixels are mostly mid-tones, and a
theme made of them is unreadable. What is taken from the art is the **hue** of each role and which
cluster becomes the accent; the lightness and chroma come from a theme known to work, then get
lifted per role until they meet that theme's own contrast. Readability is therefore never worse
than the base theme, whatever the picture.

Hue slots the art does not supply (a green for `done`, a magenta for the terminal) are borrowed:
inventing a hue a picture never shows is worse than keeping one that reads correctly.
"""

import argparse
import hashlib
import json
import math
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

BASE_THEME = "tokyo-night"
BASE_WALLPAPER = "tokyo-grid.png"
THEME_NAME = "pywal"
PITCH, OFFSET = 20, 10  # the reference grid's spacing and its half-pitch offset


# ---- colour space -----------------------------------------------------------


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * c ** (1 / 2.4) - 0.055)


def to_oklab(rgb):
    r, g, b = (srgb_to_lin(rgb[..., i]) for i in range(3))
    l = np.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    m = np.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    s = np.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return np.stack([
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ], axis=-1)


def to_rgb(lab):
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return lin_to_srgb(np.stack([
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ], axis=-1))


def hex_to_rgb(value):
    value = value.lstrip("#")
    return np.array([int(value[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32) / 255.0


def lch(lum, chroma, hue):
    rad = math.radians(hue)
    return to_rgb(np.array([lum, chroma * math.cos(rad), chroma * math.sin(rad)], dtype=np.float32))


def as_hex(rgb01):
    r, g, b = (int(round(float(v) * 255)) for v in np.clip(rgb01, 0, 1))
    return f"#{r:02x}{g:02x}{b:02x}"


def contrast(a, b):
    """WCAG contrast ratio between two #rrggbb colours."""

    def luminance(hexv):
        r, g, bl = srgb_to_lin(hex_to_rgb(hexv))
        return float(0.2126 * r + 0.7152 * g + 0.0722 * bl)

    lo, hi = sorted((luminance(a), luminance(b)))
    return (hi + 0.05) / (lo + 0.05)


# ---- the art ----------------------------------------------------------------


def clusters(path, k=10, iterations=30, seed=7, side=96):
    """The cover's palette, as k clusters in OKLab.

    The picture is first thumbnailed to `side` px: a 96x96 cover still carries its own palette (the
    clusters move by a hair), while k-means runs on ~9 k pixels instead of ~58 k, which is the whole
    difference between 0.65 s and 0.03 s. The seed is fixed so the same cover always yields the same
    theme — a palette that drifted between runs would repaint the window on every poll.
    """
    img = Image.open(path).convert("RGB")
    img.thumbnail((side, side), Image.LANCZOS)
    px = np.asarray(img).astype(np.float32) / 255.0
    sample = to_oklab(px).reshape(-1, 3)
    rng = np.random.default_rng(seed)
    cent = sample[rng.choice(len(sample), min(k, len(sample)), replace=False)].copy()
    k = len(cent)
    for _ in range(iterations):
        idx = ((sample[:, None, :] - cent[None, :, :]) ** 2).sum(axis=2).argmin(axis=1)
        for i in range(k):
            hit = idx == i
            if hit.any():
                cent[i] = sample[hit].mean(axis=0)
    share = np.bincount(idx, minlength=k) / len(idx)
    out = []
    for i in range(k):
        L, a, b = (float(v) for v in cent[i])
        out.append({"share": float(share[i]), "L": L, "C": math.hypot(a, b),
                    "hue": math.degrees(math.atan2(b, a)) % 360, "hex": as_hex(to_rgb(cent[i]))})
    return out


def hue_gap(a, b):
    d = abs((a - b) % 360)
    return min(d, 360 - d)


def band_hue(cl, band, taken, fallback):
    """A hue from a cluster inside a hue band, ignoring clusters already spoken for.

    Statuses keep their meaning: `blocked` reads red, `working` amber, `done` green, in every theme.
    The art decides *which* red and how much chroma, but not whether red means stop.
    """
    lo, hi = band
    found = []
    for c in cl:
        if any(c is t for t in taken) or c["C"] < 0.02:
            continue
        inside = (lo <= c["hue"] <= hi) if lo <= hi else (c["hue"] >= lo or c["hue"] <= hi)
        if inside:
            found.append(c)
    if not found:
        return fallback
    return max(found, key=lambda c: c["share"] * c["C"])["hue"]


def separate(hue, taken, minimum=28.0, prefer=-1):
    """Nudge a hue until it is tellable apart from every hue already taken.

    Two roles that land on the same hue paint the same colour, and a status nobody can tell from
    another is worse than one whose hue was nudged. `prefer` decides which way to walk when the
    first step collides: a red that clashes with the art's accent walks down into crimson rather
    than up into amber, so the statuses do not all pile onto the warm side of the wheel.
    """
    for direction in (prefer, -prefer):
        candidate, step = hue, 0
        while step < 360 and any(hue_gap(candidate, t) < minimum for t in taken):
            step += 10
            candidate = (candidate + direction * 10) % 360
        if not any(hue_gap(candidate, t) < minimum for t in taken):
            return candidate
    return hue


def roles(cl):
    """Which cluster each role's hue comes from, kept apart so no two roles paint the same colour."""
    dark = [c for c in cl if c["L"] < 0.38]
    weight = sum(c["share"] * max(c["C"], 0.01) for c in dark) or 1.0
    hue_dark = sum(c["hue"] * c["share"] * max(c["C"], 0.01) for c in dark) / weight
    mids = [c for c in cl if 0.45 < c["L"] < 0.9 and c["C"] > 0.05]
    accent = max(mids, key=lambda c: c["share"] * c["C"]) if mids else max(cl, key=lambda c: c["C"])

    hue_accent = accent["hue"]
    hue_blocked = band_hue(cl, (340, 40), [accent], 25)
    hue_working = band_hue(cl, (40, 105), [accent], 55)
    hue_done = band_hue(cl, (105, 180), [accent], 140)
    hue_blocked = separate(hue_blocked, [hue_accent], prefer=-1)
    hue_working = separate(hue_working, [hue_accent, hue_blocked], prefer=1)
    hue_done = separate(hue_done, [hue_accent, hue_blocked, hue_working], prefer=1)
    return {
        "hue_dark": hue_dark % 360,
        "accent": accent,
        "hue_accent": hue_accent,
        "hue_blocked": hue_blocked,
        "hue_working": hue_working,
        "hue_done": hue_done,
    }


def floors(base):
    """The contrast each role must reach: what the base theme already achieves, plus a little."""
    if not base:
        return {"foreground": 7.0, "muted": 3.0, "accent": 4.5, "blocked": 4.5, "working": 4.5, "done": 4.5}
    bg = base["background"]
    out = {}
    for role in ("foreground", "muted", "accent", "blocked", "working", "done"):
        colour = base.get("colors", {}).get(role) or base.get(role)
        out[role] = (contrast(colour, bg) * 1.03) if colour else 4.5
    return out


def fitted(lum, chroma, hue, floor, bg):
    """The colour at this hue and chroma, lifted in lightness until it clears `floor` on `bg`."""
    level, colour = lum, as_hex(lch(lum, chroma, hue))
    while contrast(colour, bg) < floor and level < 0.95:
        level = min(0.95, level + 0.01)
        colour = as_hex(lch(level, chroma, hue))
    return colour


def build_theme(r, base):
    need = floors(base)
    hue = r["hue_dark"]
    accent_l = min(0.80, max(0.62, r["accent"]["L"]))
    accent_c = min(0.16, max(0.10, r["accent"]["C"]))
    bg = as_hex(lch(0.225, 0.025, hue))
    colors = {
        "background": bg,
        "surface": as_hex(lch(0.205, 0.020, hue)),
        "popover": as_hex(lch(0.205, 0.020, hue)),
        "raised": as_hex(lch(0.265, 0.030, hue)),
        "hover": as_hex(lch(0.265, 0.030, hue)),
        "border": as_hex(lch(0.265, 0.030, hue)),
        "input": as_hex(lch(0.320, 0.035, hue)),
        "foreground": fitted(0.850, 0.055, hue, need["foreground"], bg),
        "muted": fitted(0.560, 0.065, hue, need["muted"], bg),
        "accent": fitted(accent_l, accent_c, r["hue_accent"], need["accent"], bg),
        "selection": as_hex(lch(0.320, 0.060, r["hue_accent"])),
        "working": fitted(0.780, 0.135, r["hue_working"], need["working"], bg),
        "blocked": fitted(0.660, 0.170, r["hue_blocked"], need["blocked"], bg),
        "done": fitted(0.760, 0.120, r["hue_done"], need["done"], bg),
    }
    colors["dim"] = colors["muted"]
    colors["idle"] = colors["muted"]
    colors["unknown"] = colors["muted"]
    colors["accent_foreground"] = colors["background"]

    slots = {0: hue, 1: r["hue_blocked"], 2: r["hue_done"], 3: r["hue_working"], 4: r["hue_accent"],
             5: separate(330, [hue, r["hue_accent"], r["hue_blocked"], r["hue_working"], r["hue_done"]]),
             6: separate(200, [hue, r["hue_accent"], r["hue_blocked"], r["hue_working"], r["hue_done"]])}
    ansi = []
    for slot in range(16):
        if slot == 0:
            ansi.append(as_hex(lch(0.180, 0.020, hue)))
        elif slot == 7:
            ansi.append(as_hex(lch(0.780, 0.030, hue)))
        elif slot == 8:
            ansi.append(as_hex(lch(0.330, 0.050, hue)))
        elif slot == 15:
            ansi.append(as_hex(lch(0.900, 0.030, hue)))
        else:
            lowered = slot == 9 or slot == 10 or slot == 11 or slot == 12 or slot == 13 or slot == 14
            ansi.append(as_hex(lch(0.780 if lowered else 0.680, 0.160 if lowered else 0.150, slots[slot % 8])))
    return {
        "background": colors["background"],
        "foreground": colors["foreground"],
        "selection": colors["selection"],
        "cursor": colors["foreground"],
        "ansi": ansi,
        "colors": colors,
    }


def report(theme, base):
    need = floors(base)
    rows = []
    for role in ("foreground", "muted", "accent", "blocked", "working", "done"):
        ratio = contrast(theme["colors"][role], theme["background"])
        rows.append({"role": role, "colour": theme["colors"][role],
                     "contrast": round(ratio, 2), "floor": round(need[role], 2), "ok": ratio >= need[role]})
    return rows


# ---- the wallpaper ----------------------------------------------------------

def load_wallpaper(path):
    return np.asarray(Image.open(path).convert("RGB")).astype(np.float32)


def fit_wallpaper(ref):
    """Measure the base wallpaper into (row ramp, grid deltas, geometry)."""
    height, width, _ = ref.shape
    pitch, offset = PITCH, OFFSET
    luma = ref @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    rows = np.flatnonzero((luma > 13).mean(axis=1) > 0.5)
    cols = np.flatnonzero((luma > 13).mean(axis=0) > 0.2)
    if rows.size > 1:
        pitch = int(np.median(np.diff(rows)))
        offset = int(rows[0])
    grid_rows = np.arange(offset, height, pitch)
    grid_cols = np.arange(offset, width, pitch)
    gap_rows = np.array([y for y in range(height) if (y - offset) % pitch != 0])
    base = ref[gap_rows].mean(axis=1)
    dh = np.array([ref[y].reshape(-1, 3).mean(axis=0) - ref[y - 4].reshape(-1, 3).mean(axis=0)
                   for y in grid_rows if y >= 4])
    alive = np.flatnonzero(dh.max(axis=1) > 0.5)
    horizon = (int(grid_rows[4 + alive[-1]]) + pitch) if alive.size else height
    flat = base[gap_rows >= horizon].mean(axis=0) if (gap_rows >= horizon).any() else base[-1]
    x = int(grid_cols[0]) if grid_cols.size else 0
    dv = np.array([ref[y, x] - ref[y, max(0, x - 2)] for y in range(height)])
    return {"size": (width, height), "stops_y": gap_rows.astype(np.float32), "stops_c": base,
            "flat": flat, "horizon": horizon, "pitch": pitch, "offset": offset, "dh": dh, "dv": dv}


def paint_wallpaper(model):
    width, height = model["size"]
    pitch, offset = model["pitch"], model["offset"]
    horizon = model["horizon"]
    ys = np.arange(height, dtype=np.float32)
    img = np.zeros((height, width, 3), np.float32)
    for c in range(3):
        img[:, :, c] = np.interp(ys, model["stops_y"], model["stops_c"][:, c], right=model["flat"][c])[:, None]
    dh = np.repeat(model["dh"], pitch, axis=0)[:height] if model["dh"].size else None
    if dh is not None and dh.shape[0] < height:
        dh = np.vstack([dh, np.zeros((height - dh.shape[0], 3), np.float32)])
    for y in np.arange(offset, height, pitch):
        if y >= horizon:
            break
        img[y] += dh[min(y, dh.shape[0] - 1)]
    dv = model["dv"]
    for x in np.arange(offset, width, pitch):
        end = min(int(horizon), height)
        img[:end, x] += dv[:end]
    return np.clip(img, 0, 255)


def recolor_model(model, hue, target_hex):
    """Hue-shift and tone-match the wallpaper's *stops*, not its pixels.

    The picture is a vertical ramp plus thin grid deltas, so all of its colour sits in a few thousand
    stop values: converting those instead of 3.7 M pixels is what keeps a song change under a second
    (the per-pixel version took 4.5 s). The grid's deltas are additive brightness measured off the
    base wallpaper, and stay as measured — they carry no hue of their own worth moving.

    The tone: the last 15% of the ramp is the flat band under the grid's horizon, and that band is
    moved to the theme's background lightness, so the wallpaper *is* the background the theme names
    rather than a neighbouring shade. Lightness moves by an offset, not a scale, so the grid keeps
    the contrast it had against its backdrop.
    """
    stops = to_oklab(model["stops_c"] / 255.0)
    L, chroma = stops[..., 0], np.hypot(stops[..., 1], stops[..., 2])
    tail = slice(int(len(L) * 0.85), None)
    flat_l = float(stops[tail, 0].mean())
    flat_c = max(1e-4, float(chroma[tail].mean()))

    target = to_oklab(hex_to_rgb(target_hex))
    target_c = float(np.hypot(target[1], target[2]))
    scale = min(2.0, max(0.2, target_c / flat_c))
    rad = math.radians(hue)

    def turn(lum, chroma_values):
        return to_rgb(np.stack([np.clip(lum + (target[0] - flat_l), 0, 1),
                                chroma_values * scale * math.cos(rad),
                                chroma_values * scale * math.sin(rad)], axis=-1)) * 255.0

    flat = to_oklab(model["flat"] / 255.0)
    flat_colour = turn(np.array(flat[0]), np.array(float(np.hypot(flat[1], flat[2]))))
    return dict(model,
                stops_c=np.clip(turn(L, chroma), 0, 255),
                flat=np.clip(flat_colour, 0, 255))


# ---- entry ------------------------------------------------------------------


def cached_model(ref_path, data_dir):
    """The base wallpaper's fit, computed once and kept: it depends only on that file.

    Fitting is the expensive half (~10 s: per-row scans over 2560x1440); painting and recolouring are
    a fraction of that. A song cannot wait ten seconds, so the measurement is cached under a key
    that changes with the base wallpaper, and a changed base simply refits.
    """
    stat = ref_path.stat()
    key = f"model-{stat.st_size}-{int(stat.st_mtime)}.npz"
    path = Path(data_dir) / key
    if path.exists():
        try:
            with np.load(path) as z:
                return {"size": tuple(int(v) for v in z["size"]), "stops_y": z["stops_y"],
                        "stops_c": z["stops_c"], "flat": z["flat"], "horizon": float(z["horizon"]),
                        "pitch": int(z["pitch"]), "offset": int(z["offset"]), "dh": z["dh"], "dv": z["dv"]}
        except Exception as error:  # a truncated or older cache must not break playback
            print(f"pywal: cache unreadable ({error}), refitting", file=sys.stderr)
    model = fit_wallpaper(load_wallpaper(ref_path))
    Path(data_dir).mkdir(parents=True, exist_ok=True)
    np.savez(path, size=np.array(model["size"]), stops_y=model["stops_y"], stops_c=model["stops_c"],
             flat=model["flat"], horizon=np.array(model["horizon"]), pitch=np.array(model["pitch"]),
             offset=np.array(model["offset"]), dh=model["dh"], dv=model["dv"])
    for old in Path(data_dir).glob("model-*.npz"):
        if old != path:
            old.unlink()
    return model


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cover", required=True, help="artwork to read")
    ap.add_argument("--app-home", required=True)
    ap.add_argument("--size", default="2560x1440", help="wallpaper size, WxH")
    ap.add_argument("--data-dir", help="where the cached fit lives; default beside the app home")
    ap.add_argument("--title", default="", help="what to call the track in the report")
    args = ap.parse_args(argv)

    home = Path(args.app_home)
    cover = Path(args.cover)
    if not cover.exists():
        print(json.dumps({"ok": False, "error": f"no cover at {cover}"}))
        return 1
    ref_path = home / "backgrounds" / BASE_WALLPAPER
    if not ref_path.exists():
        print(json.dumps({"ok": False, "error": f"no base wallpaper at {ref_path}"}))
        return 1

    base_path = home / "themes" / f"{BASE_THEME}.json"
    base = json.loads(base_path.read_text(encoding="utf-8")) if base_path.exists() else None

    # The art, and the roles its clusters take.
    cl = clusters(cover)
    r = roles(cl)
    theme = build_theme(r, base)

    # The wallpaper: the base's grid, re-hued, then toned so its flat band is the theme background.
    width, height = (int(v) for v in args.size.lower().split("x"))
    model = cached_model(ref_path, args.data_dir or (home / "data" / "herdr-van" / "herdr-media-pywal"))
    scale = height / model["size"][1]
    if abs(scale - 1.0) > 0.01:
        model = dict(model, size=(width, height), pitch=max(2, int(round(model["pitch"] * scale))),
                     offset=int(round(model["offset"] * scale)), horizon=model["horizon"] * scale)
    art = paint_wallpaper(recolor_model(model, r["hue_dark"], theme["background"]))
    flat_hex = as_hex(art[height - 40:].reshape(-1, 3).mean(axis=0) / 255.0)

    digest = hashlib.sha1(cover.read_bytes()).hexdigest()[:12]
    wall_path = home / "backgrounds" / f"pywal-{digest}.png"
    Image.fromarray(art.round().astype(np.uint8)).save(wall_path)

    theme_path = home / "themes" / f"{THEME_NAME}.json"
    theme_path.write_text(json.dumps(theme, indent=2) + "\n", encoding="utf-8")

    # Older generations are retired: the layout can only point at one, and a name never reused means
    # the app's image cache cannot serve a stale picture for a new name.
    for old in (home / "backgrounds").glob("pywal-*.png"):
        if old != wall_path:
            old.unlink()

    print(json.dumps({
        "ok": True,
        "theme": THEME_NAME,
        "theme_path": str(theme_path),
        "wallpaper": f"backgrounds/{wall_path.name}",
        "wallpaper_path": str(wall_path),
        "digest": digest,
        "title": args.title,
        "hues": {
            "backdrop": round(r["hue_dark"]),
            "accent": round(r["hue_accent"]),
            "blocked": round(r["hue_blocked"]),
            "working": round(r["hue_working"]),
            "done": round(r["hue_done"]),
        },
        "roles": report(theme, base),
        "flat": flat_hex,
        "background": theme["background"],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
