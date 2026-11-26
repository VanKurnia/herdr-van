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

# Voice is not a band. 250-2000 Hz holds guitars, synths and snares as readily as a singer, so the band
# alone lights up for a solo. Two cues the singing-voice-detection literature leans on separate more of
# it and cost almost nothing: how much of the mix the vocal band owns, and the 2-8 Hz syllabic wobble
# its envelope carries, which a held pad does not and a drum kit does only in transients.
VOICE_LOW_HZ = 250.0
VOICE_HIGH_HZ = 2000.0
VOICE_FRAMES = 24  # envelope history, about a second at the block rate
FLUCT_LOW_HZ = 2.0  # the syllable fluctuation band: singing moves its envelope at a few hertz
FLUCT_HIGH_HZ = 8.0


def voice_slice():
    """The band indices whose centre frequency lands inside the voice's range."""
    centres = [LOW_HZ * (HIGH_HZ / LOW_HZ) ** ((i + 0.5) / BANDS) for i in range(BANDS)]
    inside = [i for i, hz in enumerate(centres) if VOICE_LOW_HZ <= hz <= VOICE_HIGH_HZ]
    return (inside[0], inside[-1])


VOICE_RANGE = voice_slice()
# The FFT bins those bands cover, so a caller measuring flatness does not re-derive the geometry.
VOICE_BINS = (BAND_RANGES[VOICE_RANGE[0]][0], BAND_RANGES[VOICE_RANGE[1]][1])


def fluctuation(history, frame_hz):
    """How much of the vocal envelope's motion sits in the syllable band, 0..1.

    The classic fluctogram, in miniature: a sung line wavers at a few hertz, a held pad barely moves at
    all, and a drum kit's motion is faster and broadband. A small DFT over the history answers it — 24
    samples, a dozen bins, nothing at twenty frames a second.
    """
    n = len(history)
    if n < 8:
        return 0.0
    mean = sum(history) / n
    centred = [value - mean for value in history]
    in_band = 0.0
    total = 0.0
    for k in range(1, n // 2 + 1):
        hz = k * frame_hz / n
        weight = 2.0 * math.pi * k / n
        real = 0.0
        imaginary = 0.0
        for i, value in enumerate(centred):
            real += value * math.cos(weight * i)
            imaginary -= value * math.sin(weight * i)
        power = real * real + imaginary * imaginary
        total += power
        if FLUCT_LOW_HZ <= hz <= FLUCT_HIGH_HZ:
            in_band += power
    return in_band / total if total > 0.0 else 0.0


def voice_activity(levels, history, flatness=None, frame_hz=RATE / BLOCK):
    """0..1 for 'a voice is carrying this', from the cues the singing-voice literature uses.

    Three of the classic features, cheaply: the vocal band's share against the bands a voice is not
    in, the syllable fluctuation of its envelope (the fluctogram), and spectral flatness, which is
    low for anything pitched and high for noise and cymbals. `flatness` is measured by the caller on
    the FFT bins, because only it has the spectrum.

    `history` is a list this function appends the vocal band's level to and trims; pass the same list
    every block. Shorter histories return a share-only guess rather than nothing.
    """
    low, high = VOICE_RANGE
    vocal = sum(levels[low : high + 1]) / max(1, high - low + 1)
    if not any(levels):
        # Silence is not a quiet voice: no cues, no score.
        history.append(0.0)
        del history[:-VOICE_FRAMES]
        return 0.0
    # Against the bands a voice is not in, not against the whole mix: a bass-heavy track drags a
    # whole-mix average up and the share then never fires for a mix that is genuinely sung.
    rest = [v for i, v in enumerate(levels) if not low <= i <= high]
    other = sum(rest) / max(1, len(rest))
    ratio = vocal / max(other, 1e-6)
    share = max(0.0, min(1.0, (ratio - 0.98) / 0.30))
    history.append(vocal)
    del history[:-VOICE_FRAMES]
    wobble = fluctuation(history, frame_hz)
    syllables = max(0.0, min(1.0, (wobble - 0.30) / 0.40))
    # Low flatness is a pitched sound: the voice, or at least not a cymbal. Without a spectrum, assume
    # neither and let the other two cues decide.
    tone = 0.5 if flatness is None else max(0.0, min(1.0, (0.45 - flatness) / 0.35))
    return max(0.0, min(1.0, (0.35 * share + 0.35 * syllables + 0.30 * tone) * (1.0 if len(history) >= 8 else 0.6)))


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
