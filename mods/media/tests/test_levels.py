"""The spectrum's shape: what this analyser promises.

Two properties pulled in opposite directions, so each is tested where it belongs:

- *Calibration* — pink noise (equal energy per octave) must draw flat, because that is the only way a
  slope in the picture is the mix and not the analyser.
- *Content* — a mix must stay shaped and keep its contrast. Per-band scaling was built to flatten
  calibration and destroyed this (spectral contrast 0.41 -> 0.11: a wall of equal bars), so the picture
  is scaled by one gain and these tests hold that line.

Plus the geometry: a tone reads in the band that holds its frequency, and silence stays silent.
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
WINDOW = np.hanning(levels.BLOCK).astype(np.float32)


def run(signal, blocks=40):
    """The pipeline the helper runs, returning the drawn bands of the last frames."""
    prev = [0.0] * levels.BANDS
    peak = 1.0
    out = []
    for start in range(0, len(signal) - levels.BLOCK, levels.BLOCK):
        chunk = signal[start : start + levels.BLOCK]
        if len(chunk) < levels.BLOCK:
            break
        power = np.abs(np.fft.rfft(chunk * WINDOW, n=levels.FFT_SIZE)) ** 2
        energy = np.add.reduceat(power, levels.BAND_EDGES[:-1])
        fresh = [levels.band_level(float(e)) for e in energy]
        prev = levels.envelope(levels.smooth(fresh), prev, DT)
        drawn, peak = levels.gain(prev, peak, DT)
        out.append(drawn)
    return np.array(out[-blocks:])


def pink(seconds=3.0, seed=3):
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


def bass_and_air(seconds=2.0):
    """A mix's shape in miniature: a loud low band and a much quieter high one."""
    t = np.arange(int(seconds * levels.RATE)) / levels.RATE
    rng = np.random.default_rng(5)
    air = rng.standard_normal(len(t)) * 0.01
    air = np.convolve(air, np.ones(8) / 8, mode="same")  # roll off the very top a little
    return (0.5 * np.sin(2 * math.pi * 80 * t) + air).astype(np.float32)


def band_with(hz):
    for i, (a, b) in enumerate(levels.BAND_RANGES):
        low = a * levels.RATE / levels.FFT_SIZE
        high = b * levels.RATE / levels.FFT_SIZE
        if low <= hz < high:
            return i
    return levels.BANDS - 1


def test_pink_noise_reads_flat():
    """Calibration: equal energy per octave draws flat, or the analyser has a tilt of its own."""
    row = np.percentile(run(pink()), 50, axis=0)
    assert row.max() - row.min() < 0.33, f"pink noise slopes by {row.max() - row.min():.2f}"


def test_a_mix_keeps_its_shape():
    """Content: a loud band stays loud and a quiet one stays quiet — the wall is a regression."""
    row = np.percentile(run(bass_and_air()), 50, axis=0)
    low = row[band_with(80)]
    high = row[band_with(12000)]
    assert low - high > 0.25, f"80 Hz ({low:.2f}) and 12 kHz ({high:.2f}) are the same height"


def test_one_gain_keeps_the_bands_apart():
    """The normaliser must not touch ratios: halving every band halves the picture, not its shape."""
    bands = [1.0, 0.6, 0.3, 0.1] + [0.05] * (levels.BANDS - 4)
    drawn, _ = levels.gain(bands, 1.0, DT)
    ratios_before = [bands[i + 1] / bands[i] for i in range(3)]
    ratios_after = [drawn[i + 1] / drawn[i] for i in range(3)]
    assert all(abs(a - b) < 1e-6 for a, b in zip(ratios_before, ratios_after)), (
        f"ratios changed: {ratios_before} -> {ratios_after}"
    )


def test_the_loudest_band_does_not_clip_flat():
    """Headroom: a transient has somewhere to go instead of being cut against the roof."""
    drawn, _ = levels.gain([1.0] + [0.2] * (levels.BANDS - 1), 1.0, DT)
    assert drawn[0] < 1.0, "the loudest band was pinned to the ceiling"
    assert drawn[0] > 0.8, "headroom took too much of the height"


def test_a_tone_lands_in_its_own_band():
    """A pure tone reads in the band that holds its frequency, not beside it.

    Below a few hundred hertz a 1/3-octave band is only just wider than the window's main lobe, so a
    little spill into the neighbouring band is the transform's resolution, not a bug. What must hold is
    that the tone is the tallest bar, and that nothing leaks far away.
    """
    for hz in (60, 250, 1000, 6000):
        row = np.percentile(run(tone(hz)), 50, axis=0)
        expected = band_with(hz)
        assert abs(row[expected] - row.max()) < 0.08, (
            f"{hz} Hz peaked at band {int(row.argmax())}, expected {expected}"
        )
        far = [band for band in range(levels.BANDS) if abs(band - expected) > 2]
        assert max(row[far]) < 0.35 * row[expected], f"{hz} Hz leaks {max(row[far]):.2f} three bands away"


def test_silence_stays_silent():
    """No signal is no bars: the floor must not be amplified into a wall of noise."""
    row = run(np.zeros(levels.BLOCK * 8, dtype=np.float32))
    assert max(row.max(axis=1)) == 0.0, "silence was drawn as a bar"


def test_no_band_is_narrower_than_the_window():
    """The width floor holds: every band is at least MIN_BAND_BINS wide."""
    widths = [b - a for a, b in levels.BAND_RANGES]
    assert min(widths) >= levels.MIN_BAND_BINS - 1, f"a band is {min(widths)} bins wide"
    assert all(b > a for a, b in levels.BAND_RANGES), "bands must not be empty"


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
