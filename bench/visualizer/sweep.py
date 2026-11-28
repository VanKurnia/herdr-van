"""Pick FLOOR_DB and BAND_FLOOR from measurements, not from taste.

The two constants trade three things against each other:

- a tone must not light the bands its leakage lands in (the low end has one bin per band);
- pink noise must stay flat (a band's value must not depend on its width);
- music must use the row's height (the whole point of per-band scaling).

Run: python bench/visualizer/sweep.py
"""

import math
import os
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
MOD = os.path.join(HERE, "..", "..", "mods", "media")
sys.path.insert(0, MOD)
for vendor in (os.path.join(MOD, "vendor"), os.path.expanduser("~/.config/herdr-app/mods/media/vendor")):
    if os.path.isdir(vendor):
        sys.path.insert(0, vendor)
        break

import numpy as np  # noqa: E402

import levels  # noqa: E402

DT = levels.BLOCK / levels.RATE
window = np.hanning(levels.BLOCK).astype(np.float32)


def frames(signal, floor_db, band_floor):
    """Run a signal through the pipeline under a given pair of constants."""
    levels.FLOOR_DB = floor_db
    levels.BAND_FLOOR = band_floor
    peaks = None
    prev = [0.0] * levels.BANDS
    peak = 1.0
    out = []
    for start in range(0, len(signal) - levels.BLOCK, levels.BLOCK):
        chunk = signal[start : start + levels.BLOCK]
        if len(chunk) < levels.BLOCK:
            break
        power = np.abs(np.fft.rfft(chunk * window, n=levels.FFT_SIZE)) ** 2
        energy = np.add.reduceat(power, levels.BAND_EDGES[:-1])
        fresh = [levels.band_level(float(e)) for e in energy]
        if peaks is None:
            peaks = [(v, v) for v in fresh]
        drawn, peaks = levels.per_band(fresh, peaks, DT)
        out.append(levels.smooth(drawn))
    return np.array(out)


def pink(seconds=2.0, seed=3):
    rng = np.random.default_rng(seed)
    n = int(seconds * levels.RATE)
    white = rng.standard_normal(n)
    spec = np.fft.rfft(white)
    freqs = np.fft.rfftfreq(n, 1.0 / levels.RATE)
    freqs[0] = freqs[1]
    out = np.fft.irfft(spec / np.sqrt(freqs), n)
    return (out / (np.abs(out).max() * 1.2)).astype(np.float32)


def tone(hz, seconds=2.0, amp=0.5):
    t = np.arange(int(seconds * levels.RATE)) / levels.RATE
    return (amp * np.sin(2 * math.pi * hz * t)).astype(np.float32)


def capture():
    path = os.path.join(HERE, "capture.wav")
    if not os.path.exists(path):
        return pink(4.0)
    with wave.open(path, "rb") as w:
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32767.0


def main():
    music = capture()
    p = pink()
    t60 = tone(60)
    t1k = tone(1000)
    fl = levels.FLOOR_DB
    bf = levels.BAND_FLOOR
    print(f"  {'floor_db':>8} {'band_floor':>10} | {'pink spread':>11} {'pink p50':>8} | "
          f"{'60Hz far leak':>13} {'1kHz far leak':>13} | {'music spread':>12} {'music p50':>9}")
    best = None
    for floor_db in (-66.0, -62.0, -58.0, -55.0, -50.0):
        for band_floor in (0.30, 0.40, 0.50, 0.60, 0.70):
            pk = np.percentile(frames(p, floor_db, band_floor), 50, axis=0)
            mu = np.percentile(frames(music, floor_db, band_floor), 50, axis=0)
            r60 = np.percentile(frames(t60, floor_db, band_floor), 50, axis=0)
            r1k = np.percentile(frames(t1k, floor_db, band_floor), 50, axis=0)
            # "far" = three bands or more from the tone's own band
            i60 = next(i for i, (a, b) in enumerate(levels.BAND_RANGES) if a * levels.RATE / levels.FFT_SIZE <= 60 < b * levels.RATE / levels.FFT_SIZE)
            i1k = next(i for i, (a, b) in enumerate(levels.BAND_RANGES) if a * levels.RATE / levels.FFT_SIZE <= 1000 < b * levels.RATE / levels.FFT_SIZE)
            far60 = max(v for i, v in enumerate(r60) if abs(i - i60) > 2)
            far1k = max(v for i, v in enumerate(r1k) if abs(i - i1k) > 2)
            print(f"  {floor_db:8.0f} {band_floor:10.2f} | {pk.max()-pk.min():11.2f} {pk.mean():8.2f} | "
                  f"{far60:13.2f} {far1k:13.2f} | {mu.max()-mu.min():12.2f} {mu.mean():9.2f}")
    levels.FLOOR_DB, levels.BAND_FLOOR = fl, bf


if __name__ == "__main__":
    main()
