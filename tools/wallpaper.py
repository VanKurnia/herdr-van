"""Generate the app's wallpaper from a model fitted to a reference image.

The background is simple enough to be a formula: a vertical gradient, and a
20 px grid of 1 px lines that fades out toward a horizon, then flat colour
below it. This reads a reference PNG, measures those pieces, and writes a new
one — at any size, and tinted to any hue.

    python wallpaper.py                      # check the fit against the reference
    python wallpaper.py out.png --hue 330    # same wallpaper, magenta
    python wallpaper.py out.png --from other.png --size 2560x1440

The point is a wallpaper that follows a palette: pywal-style, a cover's hue
becomes the grid's, with luminance and chroma kept so the app stays as dark as
it is now. Fitting from the image rather than hand-typing stops is what keeps
this honest — `--check` prints the error against the reference.

Needs Pillow and numpy, which mods/media vendors already.
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
APP_HOME = Path.home() / ".config" / "herdr-app"
REFERENCE = APP_HOME / "backgrounds" / "tokyo-grid.png"
VENDOR = APP_HOME / "mods" / "media" / "vendor"
GENERATED = ".generated"  # what this tool wrote, so the next wallpaper can retire the last one

PITCH = 20  # the grid's spacing, px at the reference's scale
OFFSET = 10  # first line sits this far in: the grid is on the half-pitch
LINE = 1  # line thickness, px


def load(path):
    return np.asarray(Image.open(path).convert("RGB")).astype(np.float32)


# ---- fitting ---------------------------------------------------------------


def fit(ref):
    """Measure a reference into (base stops, grid deltas, geometry)."""
    height, width, _ = ref.shape
    pitch = PITCH
    offset = OFFSET
    # Grid lines: rows and columns whose mean is far above the row above them.
    luma = ref @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    rows = np.flatnonzero((luma > 13).mean(axis=1) > 0.5)
    cols = np.flatnonzero((luma > 13).mean(axis=0) > 0.2)
    if rows.size > 1:
        pitch = int(np.median(np.diff(rows)))
        offset = int(rows[0])
    grid_rows = np.arange(offset, height, pitch)
    grid_cols = np.arange(offset, width, pitch)

    # The backdrop: every row that is not a line, and every column that is not
    # one, so the lines cannot pull the ramp.
    gap_rows = np.array([y for y in range(height) if (y - offset) % pitch != 0])
    base = ref[gap_rows].mean(axis=1)
    # Where the grid ends: the last row that is still a line.
    # The line deltas also say where the grid stops: below the horizon a line row
    # measures the same as its neighbour.
    dh = np.array([ref[y].reshape(-1, 3).mean(axis=0) - ref[y - 4].reshape(-1, 3).mean(axis=0)
                   for y in grid_rows if y >= 4])
    alive = np.flatnonzero(dh.max(axis=1) > 0.5)
    horizon = (int(grid_rows[4 + alive[-1]]) + pitch) if alive.size else height
    flat = base[gap_rows >= horizon].mean(axis=0) if (gap_rows >= horizon).any() else base[-1]

    # Vertical lines do not fade the same way: measure at the first grid column.
    x = int(grid_cols[0]) if grid_cols.size else 0
    dv = np.array([ref[y, x] - ref[y, max(0, x - 2)] for y in range(height)])

    return {
        "size": (width, height),
        "stops_y": gap_rows.astype(np.float32),
        "stops_c": base,
        "flat": flat,
        "horizon": horizon,
        "pitch": pitch,
        "offset": offset,
        "dh": dh,
        "dv": dv,
    }


# ---- painting --------------------------------------------------------------


def paint(model, size=None):
    width, height = size or model["size"]
    scale = height / model["size"][1]
    pitch = max(2, int(round(model["pitch"] * scale)))
    offset = int(round(model["offset"] * scale))
    horizon = model["horizon"] * scale

    ys = np.arange(height, dtype=np.float32)
    rows_src = model["stops_y"] / model["size"][1] * height
    img = np.zeros((height, width, 3), np.float32)
    for c in range(3):
        img[:, :, c] = np.interp(ys, rows_src, model["stops_c"][:, c], right=model["flat"][c])[:, None]

    # Horizontal lines: the measured delta, resampled onto the new height.
    dh_src = np.repeat(model["dh"], pitch, axis=0)[:height] if model["dh"].size else None
    if dh_src is not None and dh_src.shape[0] < height:
        dh_src = np.vstack([dh_src, np.zeros((height - dh_src.shape[0], 3), np.float32)])
    dv_src = model["dv"]
    for y in np.arange(offset, height, pitch):
        if y >= horizon:
            break
        img[y] += dh_src[min(y, dh_src.shape[0] - 1)]
    dv_col = dv_src[np.minimum((np.arange(height) / scale).astype(int), dv_src.shape[0] - 1)]
    for x in np.arange(offset, width, pitch):
        end = min(int(horizon), height)
        img[:end, x] += dv_col[:end]
    return np.clip(img, 0, 255)


# ---- tinting ---------------------------------------------------------------

def _srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * c ** (1 / 2.4) - 0.055)


def to_oklab(rgb):
    r, g, b = (_srgb_to_lin(rgb[..., i] / 255.0) for i in range(3))
    l = np.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    m = np.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    s = np.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)


def to_rgb(L, a, b):
    l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return np.stack([
        _lin_to_srgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        _lin_to_srgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        _lin_to_srgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
    ], axis=-1) * 255.0


def hue_of(img):
    """The image's hue in OKLab degrees: one number to ask a wallpaper for."""
    L, a, b = to_oklab(img)
    weight = np.maximum(L - 0.02, 0)  # the darkest pixels carry no hue worth naming
    return float(np.degrees(np.arctan2((b * weight).sum(), (a * weight).sum())) % 360)


def tint(img, hue, chroma_scale=1.0):
    """Rotate every colour to `hue`, keeping lightness and chroma (a hue shift, not a repaint)."""
    L, a, b = to_oklab(img)
    C = np.hypot(a, b) * chroma_scale
    h = np.radians(hue)
    return np.clip(to_rgb(L, C * np.cos(h), C * np.sin(h)), 0, 255)


# ---- pruning ----------------------------------------------------------------


def prune(folder, keep, reference):
    """Retire the wallpapers this tool wrote before: the new one replaces them, the base always stays.

    The base wallpaper is the colour source, not one of the themes: it is never removed. What counts
    as generated is the recorded log, plus anything following the base's own name pattern
    (`<colour>-grid.png`, as `tokyo-grid.png` does) so variants written before the log existed are
    retired too. A hand-made wallpaper should therefore not copy that pattern.
    """
    log = folder / GENERATED
    try:
        names = {line.strip() for line in log.read_text(encoding="utf-8").splitlines() if line.strip()}
    except OSError:
        names = set()
    tail = "-" + reference.stem.split("-", 1)[1] if "-" in reference.stem else ""
    if tail:
        names |= {p.name for p in folder.glob(f"*{tail}.png")}
    removed = []
    for name in sorted(names):
        if name in (keep.name, reference.name):
            continue
        path = folder / name
        if path.exists():
            path.unlink()
            removed.append(name)
    log.write_text("".join(f"{n}\n" for n in sorted({keep.name})), encoding="utf-8")
    return removed


# ---- cli -------------------------------------------------------------------


def main(argv):
    if VENDOR.is_dir():
        sys.path.insert(0, str(VENDOR))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out", nargs="?", help="where to write the PNG; omit to only report the fit")
    ap.add_argument("--from", dest="ref", default=str(REFERENCE), help="reference PNG to fit")
    ap.add_argument("--hue", type=float, help="rotate the wallpaper to this OKLab hue (degrees)")
    ap.add_argument("--chroma", type=float, default=1.0, help="scale chroma (1 keeps the reference's)")
    ap.add_argument("--size", help="WxH; default the reference's")
    ap.add_argument("--check", action="store_true", help="print the error against the reference")
    args = ap.parse_args(argv)

    ref = load(args.ref)
    model = fit(ref)
    size = None
    if args.size:
        w, h = (int(v) for v in args.size.lower().split("x"))
        size = (w, h)
    img = paint(model, size)

    print(f"reference {args.ref}")
    print(f"  size {model['size'][0]}x{model['size'][1]}  grid pitch {model['pitch']}px offset {model['offset']}  horizon {model['horizon']}px")
    print(f"  backdrop {model['stops_c'][0].round(1)} -> {model['flat'].round(1)}  hue {hue_of(img):.0f}deg")
    if not size:
        err = np.abs(img - ref)
        print(f"  fit: mean abs {err.mean():.2f}/255  p99 {np.percentile(err, 99):.1f}  max {err.max():.1f}")
    if args.hue is not None:
        img = tint(img, args.hue, args.chroma)
        print(f"  tinted to hue {args.hue:.0f}deg (chroma x{args.chroma:g})")
    if args.out:
        out = Path(args.out)
        Image.fromarray(img.round().astype(np.uint8)).save(out)
        print(f"  wrote {out}")
        # A new wallpaper retires the one it replaces, beside the base it was tinted from.
        if out.parent.resolve() == Path(args.ref).parent.resolve():
            retired = prune(out.parent, out, Path(args.ref))
            for name in retired:
                print(f"  retired {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
