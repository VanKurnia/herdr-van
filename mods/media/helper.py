"""Live track and spectrum for mods/media.

One long-lived process with two jobs: an asyncio loop polls the Windows media
session (title, artist, playback state, cover art), and a thread reads WASAPI
loopback audio for the spectrum bars. It owns state.json, levels.json, tick and
the cover files; the mod owns `beat` and only reads the rest. A beat older than
BEAT_STALE_S means the window is gone, so this exits.

PowerShell 5.1 exposes the session metadata but cannot drain the artwork stream
(no WinRT projection, so AsStreamForRead and DataReader are unreachable), and
pwsh 7 does not project the types at all; winrt-runtime, vendored here, is what
yields real PNG bytes. The spectrum needs loopback capture, which only
soundcard/numpy provide on this platform.

    python helper.py --home "<appHome>"
"""

import argparse
import asyncio
import hashlib
import json
import math
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "vendor"))

from winrt.windows.media.control import (  # noqa: E402
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
)
from winrt.windows.storage.streams import Buffer, InputStreamOptions  # noqa: E402

POLL_S = 1.0
BEAT_STALE_S = 90.0  # the mod beats every 10 s

# Spectrum: log-spaced bands from 40 Hz to 16 kHz, published ~20 times a second.
BANDS = 28
RATE = 44100
BLOCK = 2048
LEVELS_EVERY_S = 0.05
LOW_HZ = 40.0
HIGH_HZ = 16000.0
FLOOR_DB = -55.0  # a band quieter than this reads as empty
DECAY = 0.80  # how fast a bar falls between blocks
LOUDNESS = BLOCK * 0.25  # FFT peak that counts as full scale
PLAYBACK = {
    0: "closed",
    1: "opened",
    2: "changing",
    3: "stopped",
    4: "playing",
    5: "paused",
}


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


class Writer:
    def __init__(self, home):
        self.dir = os.path.join(home, "data", "media")
        os.makedirs(self.dir, exist_ok=True)
        self.beat_path = os.path.join(self.dir, "beat")
        self.state = None  # last published bodies, to skip identical writes
        self.levels = None
        self.levels_at = 0.0
        self.playing = False

    def stopping(self):
        # Written by the mod, never by this process.
        try:
            age = time.time() - os.path.getmtime(self.beat_path)
        except OSError:
            return False  # the mod has not written one yet
        return age > BEAT_STALE_S

    def _atomic(self, name, body):
        """Write text through a temp file, so the mod never reads a partial body."""
        path = os.path.join(self.dir, name)
        with open(path + ".tmp", "w", encoding="utf-8") as fh:
            fh.write(body)
        os.replace(path + ".tmp", path)

    def tick(self):
        """Proof of life for the mod: an unchanged track writes nothing else."""
        self._atomic("tick", str(int(time.time())))

    def publish(self, record):
        body = json.dumps(record, ensure_ascii=False)
        if body == self.state:
            return
        self.state = body
        self._atomic("state.json", body)

    def publish_levels(self, levels):
        body = json.dumps({"l": levels}, separators=(",", ":"))
        now = time.time()
        if body == self.levels:
            return
        if self.levels is not None and now - self.levels_at < LEVELS_EVERY_S:
            return
        self.levels, self.levels_at = body, now
        self._atomic("levels.json", body)

    def save_cover(self, data):
        """Store cover art under a content-addressed name; None means no art."""
        if data is None:
            return None
        name = "cover-%s.png" % hashlib.sha1(data).hexdigest()[:8]
        path = os.path.join(self.dir, name)
        if not os.path.exists(path):
            with open(path + ".tmp", "wb") as fh:
                fh.write(data)
            os.replace(path + ".tmp", path)
            for old in os.listdir(self.dir):
                if old.startswith("cover-") and old != name:
                    os.unlink(os.path.join(self.dir, old))
        # A fresh path per track, so the host never shows a decoded stale image.
        return "data/media/" + name


async def read_thumbnail(reference):
    if not reference:
        return None
    stream = await reference.open_read_async()
    size = stream.size
    if not size:
        return None
    buffer = Buffer(size)
    await stream.read_async(buffer, size, InputStreamOptions.NONE)
    return bytes(buffer)


async def sample(writer):
    manager = await SessionManager.request_async()
    session = manager.get_current_session()
    if session is None:
        writer.playing = False
        writer.publish({"session": False})
        return
    props = await session.try_get_media_properties_async()
    status = PLAYBACK.get(int(session.get_playback_info().playback_status), "unknown")
    writer.playing = status == "playing"
    writer.publish(
        {
            "session": True,
            "title": (props.title or "").strip(),
            "artist": (props.artist or "").strip(),
            "album": (props.album_title or "").strip(),
            "status": status,
            "playing": writer.playing,
            "app": session.source_app_user_model_id or "",
            "cover": writer.save_cover(await read_thumbnail(props.thumbnail)),
        }
    )


def audio_loop(writer):
    """WASAPI loopback to spectrum bars, in its own thread.

    Silences are published while nothing plays, so a paused track leaves a flat
    line rather than a frozen one.
    """
    import numpy as np
    import soundcard as sc

    window = np.hanning(BLOCK).astype(np.float32)
    levels = [0.0] * BANDS

    while not writer.stopping():
        try:
            speaker = sc.default_speaker()
            mic = sc.get_microphone(id=str(speaker.name), include_loopback=True)
            with mic.recorder(samplerate=RATE, channels=1, blocksize=BLOCK) as rec:
                while not writer.stopping():
                    block = rec.record(numframes=BLOCK)
                    if not writer.playing:
                        levels = [0.0] * BANDS  # drop the decay, so a resume starts clean
                        writer.publish_levels(levels)
                        continue
                    mono = block[:, 0] if block.ndim > 1 else block
                    if len(mono) < BLOCK:
                        continue  # a device can hand back a short first block
                    spec = np.abs(np.fft.rfft(mono * window))
                    fresh = [level(float(spec[a:b].max()) / LOUDNESS) for a, b in BAND_RANGES]
                    levels = [max(f, p * DECAY) for f, p in zip(fresh, levels)]
                    writer.publish_levels([round(v, 2) for v in levels])
        except Exception as exc:  # no device yet, or the output device changed
            print("audio failed: %r" % (exc,), file=sys.stderr, flush=True)
            writer.publish_levels([0] * BANDS)
            time.sleep(2.0)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True)
    writer = Writer(parser.parse_args().home)
    threading.Thread(target=audio_loop, args=(writer,), daemon=True).start()

    while not writer.stopping():
        try:
            await sample(writer)
            writer.tick()
        except Exception as exc:  # a player can vanish mid-call; keep the last good state
            print("sample failed: %r" % (exc,), file=sys.stderr, flush=True)
        await asyncio.sleep(POLL_S)


if __name__ == "__main__":
    asyncio.run(main())
