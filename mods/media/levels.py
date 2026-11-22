"""The spectrum's shape: log-spaced bands and the level curve.

Only `math` is imported, so this module can be imported and tested on a machine without the vendored
Windows dependencies.
"""

import math

# Spectrum: log-spaced bands from 40 Hz to 16 kHz.
BANDS = 28
RATE = 44100
BLOCK = 2048
LOW_HZ = 40.0
HIGH_HZ = 16000.0
FLOOR_DB = -55.0  # a band quieter than this reads as empty
TAU_RELEASE = 0.25  # s, the bar fall; time-based, because the block rate varies by device
LOUDNESS = BLOCK * 0.25  # FFT peak that counts as full scale


def band_ranges():
    """Log-spaced FFT bin ranges, one (low, high) per band."""
    step = math.log(HIGH_HZ / LOW_HZ) / BANDS
    edges = [
        min(max(1, round(LOW_HZ * math.exp(step * i) / (RATE / BLOCK))), BLOCK // 2)
        for i in range(BANDS + 1)
    ]
    return [(a, max(a + 1, b)) for a, b in zip(edges, edges[1:])]


BAND_RANGES = band_ranges()


def level(peak):
    """An FFT peak as 0..1 between FLOOR_DB and full scale."""
    db = 20.0 * math.log10(peak) if peak > 1e-9 else -120.0
    return max(0.0, min(1.0, (db - FLOOR_DB) / -FLOOR_DB))


def release(fresh, prev, dt):
    """Fall toward `fresh` over `dt` seconds of real time; a rise lands at once.

    A clock keeps the fall honest when blocks are dropped, and independent of the sample rate: a
    per-block factor made the same track fall faster on a 48 kHz device than on a 44.1 kHz one.
    """
    if dt <= 0:
        return list(prev)
    fall = 1.0 - math.exp(-dt / TAU_RELEASE)
    return [max(f, p + (f - p) * fall) for f, p in zip(fresh, prev)]
