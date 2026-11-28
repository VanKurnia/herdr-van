"""The spectrum's shape: log-spaced bands and the level curve.

Only `math` is imported, so this module can be imported and tested on a machine without the vendored
Windows dependencies.
"""

import math

# Spectrum: log-spaced bands from 40 Hz to 16 kHz.
BANDS = 28
RATE = 44100
BLOCK = 2048
# The transform is zero-padded to this: a 2048-sample window at 44.1 kHz has 21.5 Hz bins, so the
# lowest bands (40-170 Hz) are one bin wide each and the log edges land wherever rounding puts them.
# Twice the length halves the bin and costs one longer FFT per block, which is microseconds.
FFT_SIZE = 4096
LOW_HZ = 40.0
HIGH_HZ = 16000.0
FLOOR_DB = -55.0  # a band quieter than this reads as empty
TAU_ATTACK = 0.045  # s, the bar rise
TAU_RELEASE = 0.25  # s, the bar fall; both time-based, because the block rate varies by device
TAU_GAIN = 3.0  # s, how fast the full scale forgets a peak
HEADROOM = 1.12  # the loudest band is normalised to 1/HEADROOM, so a transient is not clipped flat
# One gain for the whole spectrum, deliberately. Per-band scaling was built, measured and thrown out:
# it turned a mix into a wall of equal bars (spectral contrast 0.41 -> 0.11, each band's movement over
# time 0.10 -> 0.06) because a band scaled to its own peak can no longer be louder than itself. What
# it was meant to fix — the analyser's own frequency tilt — the energy sum and the width floor already
# fix. Flatness is a calibration property here, measured on pink noise; music is supposed to be shaped.
LOUDNESS = BLOCK * 0.25  # a full-scale sine's peak bin through a Hann window (sum(w) / 2)
WINDOW_GAIN = 0.5
# No band may be narrower than the transform can resolve. A Hann window's main lobe is four bins wide,
# so at 44.1 kHz a band thinner than ~43 Hz is not a measurement: a 60 Hz tone's lobe spanned six
# 10-25 Hz bands, and per-band scaling drew every one of them at full height. Merging the bottom bands
# up to this width keeps a tone in the one band it belongs to, at the price of coarser sub-bass bars —
# which is honest, because the resolution is not there to be had at this block length.
MIN_BAND_BINS = 4
# A band's own scale, so the spectral tilt of a mix stops being the picture. Two references: one that
# follows a passage (the dynamics the eye reads) and one that remembers the song (the absolute scale),
# because a quiet intro must not be drawn at full height just because the chorus was loud.
# (Removed: see the note on TAU_GAIN above. Kept here as the record of what was tried.)


def band_ranges():
    """Log-spaced FFT bin ranges, one (low, high) per band, over the zero-padded transform.

    Log spacing, then a floor on the width: a band below MIN_BAND_BINS would be narrower than the
    window's main lobe, so the edges are pushed out until every band can resolve what it claims.
    """
    bin_hz = RATE / FFT_SIZE
    step = math.log(HIGH_HZ / LOW_HZ) / BANDS
    edges = [min(max(1, round(LOW_HZ * math.exp(step * i) / bin_hz)), FFT_SIZE // 2) for i in range(BANDS + 1)]
    for i in range(1, len(edges)):
        edges[i] = max(edges[i], edges[i - 1] + MIN_BAND_BINS)
    # The width floor pushes the top out; clamp it back inside the spectrum and thin the last bands
    # rather than reporting a band that is not there.
    edges = [min(edge, FFT_SIZE // 2) for edge in edges]
    ranges = [(a, max(a + 1, b)) for a, b in zip(edges, edges[1:])]
    return ranges


BAND_RANGES = band_ranges()
# The edges as one flat list, so the spectrum is reduced band by band in a single call
# (numpy.add.reduceat) instead of a Python loop over 28 slices per block.
BAND_EDGES = [band[0] for band in BAND_RANGES] + [BAND_RANGES[-1][1]]


def band_centres():
    """The geometric centre of each band, Hz."""
    return [math.sqrt(BAND_RANGES[i][0] * BAND_RANGES[i][1]) * RATE / FFT_SIZE for i in range(BANDS)]


# No weighting curve. A-weighting belongs to loudness meters, not to a spectrum: it would tilt a
# display that is meant to show what the mix contains, and it made pink noise — which is flat by
# nature, an equal share of energy per octave — read as a slope. The bands are normalised one by one
# further down, which is what gives the quiet end of the spectrum its height back.

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


# The band's cosines and sines, built once per (history length, frame rate) rather than per call: the key
# space is one entry per length the envelope can have (VOICE_FRAMES) at the caller's one frame rate.
_FLUCT_TABLES = {}


def _band_tables(n, frame_hz):
    """The (cosines, sines) of each bin inside the syllable band, for a history of `n` samples."""
    key = (n, frame_hz)
    tables = _FLUCT_TABLES.get(key)
    if tables is None:
        tables = []
        for k in range(1, n // 2 + 1):
            if FLUCT_LOW_HZ <= k * frame_hz / n <= FLUCT_HIGH_HZ:
                weight = 2.0 * math.pi * k / n
                tables.append(
                    (
                        [math.cos(weight * i) for i in range(n)],
                        [math.sin(weight * i) for i in range(n)],
                    )
                )
        _FLUCT_TABLES[key] = tables
    return tables


def fluctuation(history, frame_hz):
    """How much of the vocal envelope's motion sits in the syllable band, 0..1.

    The classic fluctogram, in miniature: a sung line wavers at a few hertz, a held pad barely moves at
    all, and a drum kit's motion is faster and broadband. Not a general DFT: only the bins inside the
    syllable band are transformed, and their trig is tabulated once per history length, so twenty
    frames a second cost no trigonometry at all. The denominator is not a sum of bins either — see
    below.
    """
    n = len(history)
    if n < 8:
        return 0.0
    mean = sum(history) / n
    centred = [value - mean for value in history]
    in_band = 0.0
    for cosines, sines in _band_tables(n, frame_hz):
        real = 0.0
        imaginary = 0.0
        for i, value in enumerate(centred):
            real += value * cosines[i]
            imaginary -= value * sines[i]
        in_band += real * real + imaginary * imaginary
    # Parseval, instead of transforming the bins nobody looks at: the energies of all n bins sum to
    # n·Σx², which counts every bin above Nyquist twice. The history is centred (X_0 = 0); when n is
    # even the top bin is its own conjugate, real because sin(pi·i) = 0, and counted once.
    total = n * sum(value * value for value in centred) / 2.0
    if n % 2 == 0:
        nyquist = sum(value if i % 2 == 0 else -value for i, value in enumerate(centred))
        total += nyquist * nyquist / 2.0
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


def gain(bands, peak, dt):
    """Scale the whole spectrum by one recent-peak normaliser, so a quiet master still fills the row.

    One gain for the whole spectrum, because the bands' relative heights are the picture. The peak
    rises at once and forgets over TAU_GAIN, and it is normalised with HEADROOM so the loudest band
    sits just under the top: without that, every kick clipped the tallest bar flat against the roof and
    the transient had nowhere to show. Returns the scaled levels and the peak to pass back in.
    """
    peak = max(max(bands, default=0.0), peak * math.exp(-dt / TAU_GAIN))
    if peak <= 1e-6:
        return list(bands), peak
    return [min(1.0, v / (peak * HEADROOM)) for v in bands], peak


def level(peak):
    """An FFT peak as 0..1 between FLOOR_DB and full scale."""
    db = 20.0 * math.log10(peak) if peak > 1e-9 else -120.0
    return max(0.0, min(1.0, (db - FLOOR_DB) / -FLOOR_DB))


def band_level(energy):
    """A band's summed energy as 0..1.

    Energy rather than the band's loudest bin: a maximum over a band is one bin's noise and depends on
    how wide the band is, which is why the same mix drew taller bars at the top of the spectrum. A sum
    over the band is what the band contains, and it does not flicker between frames.
    """
    scaled = energy / (LOUDNESS * LOUDNESS)
    db = 10.0 * math.log10(scaled) if scaled > 1e-12 else -120.0
    return max(0.0, min(1.0, (db - FLOOR_DB) / -FLOOR_DB))


def smooth(bands, share=0.25):
    """Blend each band with its neighbours (1-2-1), so one bin's spike cannot flicker a bar alone."""
    n = len(bands)
    if n < 3:
        return list(bands)
    out = [bands[0]]
    for i in range(1, n - 1):
        out.append((bands[i - 1] + 2.0 * bands[i] + bands[i + 1]) / 4.0)
    out.append(bands[-1])
    return [value + (blended - value) * share for value, blended in zip(bands, out)]


def envelope(fresh, prev, dt):
    """Rise toward `fresh` quickly and fall slowly, over `dt` seconds of real time.

    Both directions are clocked rather than per-block, because the block rate varies by device: a
    per-block factor made the same track fall faster on a 48 kHz device than on a 44.1 kHz one. A rise
    is smoothed too, by the short TAU_ATTACK, so a transient is drawn as an attack rather than snapped
    to full height.
    """
    if dt <= 0:
        return list(prev)
    rise = 1.0 - math.exp(-dt / TAU_ATTACK)
    fall = 1.0 - math.exp(-dt / TAU_RELEASE)
    return [p + (f - p) * (rise if f > p else fall) for f, p in zip(fresh, prev)]
