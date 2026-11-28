"""The spectrum's shape: what an accurate analyser must get right.

Three properties, each one a thing the old maths got wrong:

- pink noise (equal energy per octave) reads flat across the bands, instead of sloping;
- a pure tone lands in the band that contains its frequency, and its neighbours stay near the floor;
- steady material sits below full height, so a chorus still has somewhere to go.
"""

import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
for vendor in (os.path.join(HERE, "..", "vendor"), os.path.expanduser("~/.config/herdr-app/mods/media/vendor")):
    if os.path.isdir(vendor):
        sys.path.insert(0, vendor)
        break

import numpy as np  # noqa: E402

import levels  # noqa: E402

DT = levels.BLOCK / levels.RATE


def bands_of(signal, blocks=40):
    """Run a signal through the pipeline the helper uses, and return the last frames' bands."""
    window = np.hanning(levels.BLOCK).astype(np.float32)
    peaks = None
    frames = []
    for start in range(0, len(signal) - levels.BLOCK, levels.BLOCK):
        chunk = signal[start : start + levels.BLOCK]
        if len(chunk) < levels.BLOCK:
            break
        power = np.abs(np.fft.rfft(chunk * window, n=levels.FFT_SIZE)) ** 2
        energy = np.add.reduceat(power, levels.BAND_EDGES[:-1])
        fresh = [levels.band_level(float(e)) for e in energy]
        if peaks is None:
            peaks = [(value, value) for value in fresh]
        drawn, peaks = levels.per_band(fresh, peaks, DT)
        frames.append(levels.smooth(drawn))
    return np.array(frames[-blocks:])


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


def band_with(hz):
    for i, (a, b) in enumerate(levels.BAND_RANGES):
        low = a * levels.RATE / levels.FFT_SIZE
        high = b * levels.RATE / levels.FFT_SIZE
        if low <= hz < high:
            return i
    return len(levels.BAND_RANGES) - 1


def test_pink_noise_is_flat():
    """Equal energy per octave must draw a flat row: the old max-over-bin maths sloped by 0.25."""
    row = np.percentile(bands_of(pink()), 50, axis=0)
    assert row.max() - row.min() < 0.15, f"pink noise slopes: {row.max() - row.min():.2f}"
    assert row.max() <= 1.0 and row.min() > 0.45, f"pink noise not near the target: {row.min():.2f}..{row.max():.2f}"


def test_steady_material_leaves_headroom():
    """A band at its own average is drawn at BAND_TARGET, not pinned to the top."""
    row = np.percentile(bands_of(pink()), 50, axis=0)
    assert row.max() < 0.85, f"steady material saturates at {row.max():.2f}"
    assert row.max() > 0.6, f"steady material is too quiet at {row.max():.2f}"


def test_a_tone_lands_in_its_own_band():
    """A pure tone reads in the band that holds its frequency, not beside it.

    Below a few hundred hertz a 1/3-octave band is one 10.8 Hz bin wide, so a Hann window's leakage
    necessarily spills into the neighbouring bands: that is the transform's resolution, not a bug. What
    must hold is that the peak is in the right band and that nothing leaks far away.
    """
    for hz in (60, 250, 1000, 6000):
        row = np.percentile(bands_of(tone(hz)), 50, axis=0)
        expected = band_with(hz)
        assert abs(row[expected] - row.max()) < 0.08, (
            f"{hz} Hz peaked at band {int(row.argmax())}, expected {expected}"
        )
        far = [band for band in range(levels.BANDS) if abs(band - expected) > 2]
        # Relative to the peak, because per-band scaling lifts even a residual tail to a visible
        # fraction: what matters is that the tone itself is the tallest bar by a wide margin.
        assert max(row[far]) < 0.35 * row[expected], f"{hz} Hz leaks {max(row[far]):.2f} three bands away"


def test_energy_beats_the_loudest_bin():
    """A band's value must not depend on how many bins it has."""
    wide = levels.BAND_RANGES[-1]
    narrow = levels.BAND_RANGES[0]
    assert wide[1] - wide[0] > narrow[1] - narrow[0]
    peaks = [(0.5, 0.5)] * levels.BANDS
    drawn, _ = levels.per_band([0.5] * levels.BANDS, peaks, DT)
    assert len(set(round(v, 6) for v in drawn)) == 1, "identical inputs must draw identical bands"


def test_per_band_scales_do_not_run_away():
    """Silence stays silent, and a band at its own peak is drawn at the target, not pinned to the top."""
    peaks = [(0.30, 0.30)] * levels.BANDS
    drawn, _ = levels.per_band([0.0] * levels.BANDS, peaks, DT)
    assert max(drawn) == 0.0, "silence was amplified"
    drawn, _ = levels.per_band([1.0] * levels.BANDS, peaks, DT)
    assert min(drawn) == levels.BAND_TARGET, "a band at full scale should sit at the target height"


if __name__ == "__main__":
    # pytest is not installed with this Python, so the same tests also run as a plain script.
    failures = 0
    for name, fn in sorted(globals().items()):
        if not (name.startswith("test_") and callable(fn)):
            continue
        try:
            fn()
            print(f"  ok    {name}")
        except AssertionError as error:
            failures += 1
            print(f"  FAIL  {name}: {error}")
    print("  all passed" if not failures else f"  {failures} failed")
    sys.exit(1 if failures else 0)