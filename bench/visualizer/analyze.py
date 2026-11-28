"""Before/after for the spectrum: the same audio through the old band maths and the new one.

Old: each band's loudest FFT bin, mapped from dB, one global peak normaliser, no weighting.
New: each band's summed energy, ear-weighted, scaled by its own passage/song peak, smoothed.

Run: python bench/visualizer/analyze.py           (records 8 s of loopback once, then reuses it)
     python bench/visualizer/analyze.py --record  (re-record)
"""

import math
import os
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
MOD = os.path.join(HERE, "..", "..", "mods", "media")
sys.path.insert(0, MOD)
# vendor/ is 73 MB of Python deps and is not in the repo: use the live mod's copy when this checkout
# does not carry one, so the harness runs from either side.
for vendor in (os.path.join(MOD, "vendor"), os.path.expanduser("~/.config/herdr-app/mods/media/vendor")):
    if os.path.isdir(vendor):
        sys.path.insert(0, vendor)
        break

import numpy as np  # noqa: E402

import levels  # noqa: E402

CAPTURE = os.path.join(HERE, "capture.wav")
SECONDS = 8

# The old pipeline's geometry, kept here so the comparison does not depend on levels.py still having it.
OLD_BANDS = 28
OLD_LOW, OLD_HIGH = 40.0, 16000.0


def old_ranges():
    step = math.log(OLD_HIGH / OLD_LOW) / OLD_BANDS
    edges = [
        min(max(1, round(OLD_LOW * math.exp(step * i) / (levels.RATE / levels.BLOCK))), levels.BLOCK // 2)
        for i in range(OLD_BANDS + 1)
    ]
    return [(a, max(a + 1, b)) for a, b in zip(edges, edges[1:])]


OLD_RANGES = old_ranges()


def record():
    import soundcard as sc  # only needed when recording

    speaker = sc.default_speaker()
    mic = sc.get_microphone(id=str(speaker.name), include_loopback=True)
    frames = []
    with mic.recorder(samplerate=levels.RATE, channels=1, blocksize=levels.BLOCK) as rec:
        for _ in range(int(SECONDS * levels.RATE / levels.BLOCK)):
            block = rec.record(numframes=levels.BLOCK)
            frames.append(block[:, 0] if block.ndim > 1 else block)
    audio = np.concatenate(frames).astype(np.float32)
    with wave.open(CAPTURE, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(levels.RATE)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
    return audio


def load(record_it=False):
    if record_it or not os.path.exists(CAPTURE):
        return record()
    with wave.open(CAPTURE, "rb") as w:
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32767.0


def blocks(audio):
    for start in range(0, len(audio) - levels.BLOCK, levels.BLOCK):
        chunk = audio[start : start + levels.BLOCK]
        if len(chunk) == levels.BLOCK:
            yield chunk


def old_drawn(audio, window):
    """The bands as the mod drew them: per-block fresh values, envelope, one global peak."""
    prev = [0.0] * OLD_BANDS
    peak = 1.0
    dt = levels.BLOCK / levels.RATE
    out = []
    for chunk in blocks(audio):
        spec = np.abs(np.fft.rfft(chunk * window))
        fresh = [levels.level(float(spec[a:b].max()) / levels.LOUDNESS) for a, b in OLD_RANGES]
        prev = levels.envelope(fresh, prev, dt)
        drawn, peak = levels.gain(prev, peak, dt)
        out.append(fresh)
    return np.array(out)


def new_drawn(audio, window):
    """The bands as the new pipeline draws them, returned pre-envelope so the raw shape is visible."""
    prev = [0.0] * levels.BANDS
    peak = 1.0
    dt = levels.BLOCK / levels.RATE
    out = []
    for chunk in blocks(audio):
        power = np.abs(np.fft.rfft(chunk * window, n=levels.FFT_SIZE)) ** 2
        energy = np.add.reduceat(power, levels.BAND_EDGES[:-1])
        raw = [levels.band_level(float(e)) for e in energy]
        prev = levels.envelope(levels.smooth(raw), prev, dt)
        drawn, peak = levels.gain(prev, peak, dt)
        out.append(drawn)
    return np.array(out)


def tail(values, fraction=0.4):
    """The last part of the capture: the normalisers need a moment before their numbers mean anything."""
    start = int(len(values) * (1.0 - fraction))
    return values[start:]


def report(name, matrix, centres):
    p50 = np.percentile(matrix, 50, axis=0)
    spread = float(p50.max() - p50.min())
    moving = int((np.std(matrix, axis=0) > 0.02).sum())
    print(f"\n--- {name} ---")
    print(f"  band p50 spread across the spectrum: {spread:.2f}   (lower means the whole row is used)")
    print(f"  bands that move over time (>0.02 sd):  {moving}/{len(p50)}")
    print("  hz      " + " ".join(f"{c:5.0f}" for c in centres))
    print("  p50     " + " ".join(f"{v:5.2f}" for v in p50))
    return spread, moving


def noise(kind, seconds=3.0, seed=7):
    n = int(seconds * levels.RATE)
    rng = np.random.default_rng(seed)
    white = rng.standard_normal(n)
    if kind == "white":
        out = white
    else:  # pink: white shaped by 1/sqrt(f), the spectrum a mix roughly follows
        spec = np.fft.rfft(white)
        freqs = np.fft.rfftfreq(n, 1.0 / levels.RATE)
        freqs[0] = freqs[1]
        spec = spec / np.sqrt(freqs)
        out = np.fft.irfft(spec, n)
    out = out / (np.abs(out).max() * 1.2)
    return out.astype(np.float32)


def tone(hz, seconds=3.0, amp=0.5):
    t = np.arange(int(seconds * levels.RATE)) / levels.RATE
    return (amp * np.sin(2 * math.pi * hz * t)).astype(np.float32)


def main():
    window = np.hanning(levels.BLOCK).astype(np.float32)
    audio = load("--record" in sys.argv)
    centres = levels.band_centres()

    print(f"capture: {len(audio)/levels.RATE:.1f} s of loopback, {os.path.basename(CAPTURE)}")
    print(f"old: max over {OLD_RANGES[0][1]-OLD_RANGES[0][0]}..{max(b for a,b in OLD_RANGES)-min(a for a,b in OLD_RANGES)} bins, "
          f"floor {levels.FLOOR_DB:.0f} dB | new: summed energy, one gain")

    report("real music (raw, pre-envelope)", tail(old_drawn(audio, window)), centres)
    report("new pipeline (raw, pre-envelope)", tail(new_drawn(audio, window)), centres)

    for kind in ("pink", "white"):
        sig = noise(kind)
        print(f"\n=== {kind} noise: a correct analyser draws this flat ===")
        old = tail(old_drawn(sig, window))
        new = tail(new_drawn(sig, window))
        o = np.percentile(old, 50, axis=0)
        n = np.percentile(new, 50, axis=0)
        print(f"  old p50 spread {o.max()-o.min():.2f}   new p50 spread {n.max()-n.min():.2f}")
        print("  old " + " ".join(f"{v:4.2f}" for v in o))
        print("  new " + " ".join(f"{v:4.2f}" for v in n))

    print("\n=== sines: one band tall, the rest at the floor ===")
    for hz in (60, 250, 1000, 6000):
        sig = tone(hz)
        new = tail(new_drawn(sig, window))
        row = np.percentile(new, 50, axis=0)
        loud = np.argsort(row)[::-1][:3]
        print(f"  {hz:5d} Hz -> bands {', '.join(f'{i}={row[i]:.2f}' for i in sorted(loud))}"
              f"   (centre {centres[sorted(loud)[0]]:.0f} Hz)")


if __name__ == "__main__":
    main()
