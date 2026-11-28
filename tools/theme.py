"""Build a theme file from a cover: the art's hues, tokyo-night's proportions.

The point is not to sample colours straight out of the picture — a cover's own pixels are mostly
mid-tones, and a theme made of them is unreadable. It is to keep the *architecture* that is known to
work (background near L 0.22, foreground near 0.85, accent near 0.72, all at low chroma) and let the
picture decide the **hue** of each role, plus which cluster becomes the accent.

    python theme.py                       # report only: the palette and what each role would get
    python theme.py --write art           # write themes/art.json, printing the validation

Roles with no counterpart in the art keep tokyo-night's hue: a terminal needs a green and a magenta
whether the picture has them or not, and inventing a hue the picture never shows is worse than
keeping one that reads correctly.
"""

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

APP_HOME = Path.home() / ".config" / "herdr-app"
VENDOR = APP_HOME / "mods" / "media" / "vendor"
COVER = APP_HOME / "data" / "media"  # the newest cover-*.png is the current art
THEMES = APP_HOME / "themes"
BASE_THEME = THEMES / "tokyo-night.json"


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
    """A colour from OKLCH: lightness, chroma, hue in degrees."""
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
    la, lb = luminance(a), luminance(b)
    lo, hi = sorted((la, lb))
    return (hi + 0.05) / (lo + 0.05)


# ---- the art ----------------------------------------------------------------


def clusters(path, k=10, iterations=30, seed=7):
    px = np.asarray(Image.open(path).convert("RGB")).astype(np.float32) / 255.0
    lab = to_oklab(px).reshape(-1, 3)
    sample = lab[::3]
    rng = np.random.default_rng(seed)
    cent = sample[rng.choice(len(sample), k, replace=False)].copy()
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
        out.append({
            "share": float(share[i]),
            "L": L,
            "C": math.hypot(a, b),
            "hue": math.degrees(math.atan2(b, a)) % 360,
            "hex": as_hex(to_rgb(cent[i])),
        })
    return out, len(lab)


def roles(cl):
    """The hues the art contributes, chosen so each comes from a different part of the picture."""
    dark = [c for c in cl if c["L"] < 0.38]
    # The backdrop's hue: the dark clusters, weighted by how much of the picture they cover.
    weight = sum(c["share"] * max(c["C"], 0.01) for c in dark) or 1.0
    hue_dark = sum(c["hue"] * c["share"] * max(c["C"], 0.01) for c in dark) / weight
    mids = [c for c in cl if 0.45 < c["L"] < 0.9 and c["C"] > 0.05]
    accent = max(mids, key=lambda c: c["share"] * c["C"]) if mids else max(cl, key=lambda c: c["C"])
    others = sorted((c for c in mids if c is not accent), key=lambda c: -c["share"] * c["C"])
    second = others[0] if others else accent
    # `working` wants a warm hue, but the picture's red is already `blocked`: take the warm cluster
    # that is not that one, or the two roles would paint the same colour.
    warms = [c for c in cl if 40 <= c["hue"] <= 100 and c is not second]
    warm = max(warms, key=lambda c: c["share"] * c["L"]) if warms else second
    light = max(cl, key=lambda c: c["L"])
    return {
        "hue_dark": hue_dark % 360,
        "hue_accent": accent["hue"],
        "accent_cluster": accent,
        "hue_second": second["hue"],
        "second_cluster": second,
        "hue_warm": warm["hue"],
        "warm_cluster": warm,
        "hue_light": light["hue"],
    }


def floors(base):
    """The contrast each role must reach: what the theme being replaced already achieves, plus a
    little headroom. A brightness the art does not supply is lifted until it clears its own floor,
    which is what keeps an adaptive theme from ever being harder to read than the fixed one."""
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
    level = lum
    colour = as_hex(lch(level, chroma, hue))
    while contrast(colour, bg) < floor and level < 0.95:
        level = min(0.95, level + 0.01)
        colour = as_hex(lch(level, chroma, hue))
    return colour


def build(r, base):
    """The theme: tokyo-night's lightness and chroma per role, the art's hues."""
    need = floors(base)
    hue = r["hue_dark"]
    accent_cluster = r["accent_cluster"]
    # The accent keeps the art's own lightness and chroma, clamped into the band an accent can live
    # in: the picture's colour, at a weight that reads as a control rather than a highlight.
    accent_l = min(0.80, max(0.62, accent_cluster["L"]))
    accent_c = min(0.16, max(0.10, accent_cluster["C"]))
    accent = r["hue_accent"]
    second = r["hue_second"]
    warm = r["hue_warm"]
    bg = as_hex(lch(0.225, 0.025, hue))
    bp = {
        "background": bg,
        "surface": as_hex(lch(0.205, 0.020, hue)),
        "popover": as_hex(lch(0.205, 0.020, hue)),
        "raised": as_hex(lch(0.265, 0.030, hue)),
        "hover": as_hex(lch(0.265, 0.030, hue)),
        "border": as_hex(lch(0.265, 0.030, hue)),
        "input": as_hex(lch(0.320, 0.035, hue)),
        "foreground": fitted(0.850, 0.055, hue, need["foreground"], bg),
        "muted": fitted(0.560, 0.065, hue, need["muted"], bg),
        "accent": fitted(accent_l, accent_c, accent, need["accent"], bg),
        "selection": as_hex(lch(0.320, 0.060, accent)),
        "working": fitted(0.780, 0.135, warm, need["working"], bg),
        "blocked": fitted(0.660, 0.170, second, need["blocked"], bg),
        # The art here has no green, so `done` borrows the hue a green needs; see the note above.
        "done": fitted(0.760, 0.120, 140, need["done"], bg),
    }
    bp["dim"] = bp["muted"]
    bp["idle"] = bp["muted"]
    bp["unknown"] = bp["muted"]
    bp["accent_foreground"] = bp["background"]

    # The terminal's 16: the art's own chromatic set where it has one, tokyo's hues for the slots a
    # picture almost never shows (green, magenta), so program output stays readable.
    ansi_hues = {
        0: hue, 1: second, 2: 140, 3: warm, 4: accent, 5: 330, 6: 200, 7: 0.850,
        8: hue, 9: second, 10: 140, 11: warm, 12: accent, 13: 330, 14: 200, 15: 0.900,
    }
    ansi = []
    for slot in range(16):
        value = ansi_hues[slot]
        if slot == 0:
            ansi.append(as_hex(lch(0.180, 0.020, hue)))
        elif slot == 7:
            ansi.append(as_hex(lch(0.780, 0.030, hue)))
        elif slot == 8:
            ansi.append(as_hex(lch(0.330, 0.050, hue)))
        elif slot == 15:
            ansi.append(as_hex(lch(0.900, 0.030, hue)))
        elif slot < 8:
            ansi.append(as_hex(lch(0.680, 0.150, value if value > 2 else 0)))
        else:
            ansi.append(as_hex(lch(0.780, 0.160, value if value > 2 else 0)))

    theme = {
        "background": bp["background"],
        "foreground": bp["foreground"],
        "selection": bp["selection"],
        "cursor": bp["foreground"],
        "ansi": ansi,
        "colors": bp,
    }
    return theme


# ---- checking ---------------------------------------------------------------


def validate(theme, reference=None):
    """The readings that decide whether a theme is usable, not whether it is pretty.

    Floors come from the theme being replaced, not from taste: `reference` is the theme in use, and
    a role may not fall more than 5% below the contrast that theme already achieved, so an adaptive
    theme can never make the window harder to read than what it replaced.
    """
    bg = theme["background"]
    rows = [
        ("foreground", "foreground"),
        ("muted", "muted"),
        ("accent", "accent"),
        ("border", "border"),
        ("blocked", "blocked"),
        ("working", "working"),
        ("done", "done"),
    ]
    out = []
    for name, key in rows:
        colour = theme["colors"][key]
        ratio = contrast(colour, bg)
        floor = 1.0
        if reference:
            ref_colour = reference.get("colors", {}).get(key) or reference.get(key)
            if ref_colour:
                floor = contrast(ref_colour, reference["background"]) * 0.95
                if key == "border":
                    floor = 1.10  # a border is meant to sit just above the backdrop
        out.append((name, colour, ratio, floor, ratio >= floor))
    # Slots 0, 7, 8 and 15 are the blacks and greys: low contrast is their job.
    ansi = [(i, c, contrast(c, bg)) for i, c in enumerate(theme["ansi"]) if i not in (0, 7, 8, 15)]
    return out, ansi


def newest_cover():
    covers = sorted(COVER.glob("cover-*.png"), key=lambda p: p.stat().st_mtime)
    return covers[-1] if covers else None


def main(argv):
    if VENDOR.is_dir():
        sys.path.insert(0, str(VENDOR))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cover", help="artwork to read; default the newest cover the media mod wrote")
    ap.add_argument("--write", metavar="NAME", help="write themes/NAME.json")
    ap.add_argument("--apply", action="store_true", help="switch the app to the theme after writing")
    args = ap.parse_args(argv)

    cover = Path(args.cover) if args.cover else newest_cover()
    if not cover or not cover.exists():
        print("no cover to read: is the media mod playing something?")
        return 1
    base = json.loads(BASE_THEME.read_text(encoding="utf-8")) if BASE_THEME.exists() else {}

    cl, count = clusters(cover)
    r = roles(cl)
    ref = r["accent_cluster"]

    print(f"cover {cover.name}")
    print("\n  share   L      C      hue   colour    role it takes")
    tagged = []
    for c in sorted(cl, key=lambda c: -c["share"]):
        role = []
        if abs(c["hue"] - r["hue_dark"]) < 6 and c["L"] < 0.38:
            role.append("backdrop")
        if c is ref:
            role.append("accent")
        if c is r["second_cluster"]:
            role.append("blocked / red")
        if abs(c["hue"] - r["hue_warm"]) < 6 and 20 <= c["hue"] <= 90:
            role.append("working")
        tagged.append((c, ", ".join(role)))
    for c, role in tagged:
        print("  %.3f  %.3f  %.3f  %5.0f  %s  %s" % (c["share"], c["L"], c["C"], c["hue"], c["hex"], role))

    print("\n  hues taken: backdrop %.0f deg, accent %.0f deg (from %s), second %.0f deg, warm %.0f deg"
          % (r["hue_dark"], r["hue_accent"], ref["hex"], r["hue_second"], r["hue_warm"]))

    theme = build(r, base)
    rows, ansi = validate(theme, base)
    if base:
        print("\n  reference: %s" % BASE_THEME.name)
        ref_rows = [("foreground", base["foreground"]), ("muted", base["colors"]["muted"]),
                    ("accent", base["colors"]["accent"])]
        for name, colour in ref_rows:
            print("    %-11s %s  %.2f:1" % (name, colour, contrast(colour, base["background"])))
    print("\n  role          colour    contrast on background   floor   ok")
    for name, colour, ratio, floor, ok in rows:
        print("  %-12s  %s   %5.2f                  %5.2f   %s" % (name, colour, ratio, floor, "yes" if ok else "NO"))
    weakest = min(ansi, key=lambda a: a[2])
    print("  weakest ansi colour slot %d (%s) at %.2f:1" % (weakest[0], weakest[1], weakest[2]))

    if args.write:
        path = THEMES / f"{args.write}.json"
        path.write_text(json.dumps(theme, indent=2) + "\n", encoding="utf-8")
        print(f"\n  wrote {path}")
    if args.apply and args.write:
        print(f'  apply with: herdr-app do app.theme {args.write}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
