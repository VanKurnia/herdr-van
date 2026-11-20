"""Live track and spectrum for mods/media.

One long-lived process with two jobs: an asyncio loop polls the Windows media
session (title, artist, clock, playback state, cover art) and applies the mod's
transport clicks, and a thread reads WASAPI loopback audio for the spectrum bars.
It owns state.json, levels.json, tick and the cover files; the mod owns `beat` and
the clicks in `cmd`, and only reads the rest. A beat older than
the store's staleness window means the window is gone, so this exits.

PowerShell 5.1 exposes the session metadata but cannot drain the artwork stream
(no WinRT projection, so AsStreamForRead and DataReader are unreachable), and
pwsh 7 does not project the types at all; winrt-runtime, vendored here, is what
yields real PNG bytes. The spectrum needs loopback capture, which only
soundcard/numpy provide on this platform.

    python helper.py --home "<appHome>"
"""

import argparse
import asyncio
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
from levels import BAND_RANGES, BANDS, BLOCK, DECAY, LOUDNESS, RATE, level  # noqa: E402
from store import Writer  # noqa: E402

POLL_S = 1.0
CMD_POLL_S = 0.15  # how soon a transport click reaches the player
PLAYBACK = {
    0: "closed",
    1: "opened",
    2: "changing",
    3: "stopped",
    4: "playing",
    5: "paused",
}


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


async def sample(writer, manager):
    session = manager.get_current_session()
    if session is None:
        writer.playing = False
        writer.publish({"session": False})
        return
    props = await session.try_get_media_properties_async()
    status = PLAYBACK.get(int(session.get_playback_info().playback_status), "unknown")
    timeline = session.get_timeline_properties()
    writer.playing = status == "playing"
    # The artwork stream is only worth opening when the track changed, or when this track has no
    # art yet (players publish the picture a moment after the metadata, so keep trying while it
    # is missing). Reading and hashing it on every poll cost a stream read and a sha1 per second.
    key = (
        (props.title or "").strip(),
        (props.artist or "").strip(),
        (props.album_title or "").strip(),
        session.source_app_user_model_id,
    )
    if key != writer.cover_key or writer.cover is None:
        writer.cover = writer.save_cover(await read_thumbnail(props.thumbnail))
        writer.cover_key = key
    writer.publish(
        {
            "session": True,
            "title": (props.title or "").strip(),
            "artist": (props.artist or "").strip(),
            "album": (props.album_title or "").strip(),
            "status": status,
            "playing": writer.playing,
            "app": session.source_app_user_model_id or "",
            "cover": writer.cover,
            # Zeros when the player reports no timeline, which is the row's cue to hide the clock.
            "pos": int(timeline.position.total_seconds()),
            "dur": int(timeline.end_time.total_seconds()),
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


def watch_beat(writer):
    """Exit when the window stops beating.

    The poll loop below stops itself too, but a media call that never returns
    never reaches that check; this thread keeps beating regardless.
    """
    while not writer.stopping():
        time.sleep(POLL_S)
    os._exit(0)


async def apply(session, action):
    """One transport click, in the session's own vocabulary."""
    if action == "toggle":
        await session.try_toggle_play_pause_async()
    elif action == "next":
        await session.try_skip_next_async()
    else:
        await session.try_skip_previous_async()


async def commands(writer, manager):
    """The mod's transport clicks, applied as they land, then published at once.

    A player accepts or ignores each one; the state that follows is what the row
    shows, so nothing here is remembered.
    """
    while not writer.stopping():
        action = writer.take_command()
        if action:
            session = manager.get_current_session()
            if session is not None:
                try:
                    await apply(session, action)
                    await sample(writer, manager)
                except Exception as exc:
                    print("command %s failed: %r" % (action, exc), file=sys.stderr, flush=True)
        await asyncio.sleep(CMD_POLL_S)


async def poll(writer, manager):
    """The media state, sampled once a second."""
    while not writer.stopping():
        try:
            await sample(writer, manager)
            writer.tick()
        except Exception as exc:  # a player can vanish mid-call; keep the last good state
            print("sample failed: %r" % (exc,), file=sys.stderr, flush=True)
        await asyncio.sleep(POLL_S)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True)
    writer = Writer(parser.parse_args().home)
    manager = await SessionManager.request_async()
    threading.Thread(target=audio_loop, args=(writer,), daemon=True).start()
    threading.Thread(target=watch_beat, args=(writer,), daemon=True).start()
    await asyncio.gather(commands(writer, manager), poll(writer, manager))


if __name__ == "__main__":
    asyncio.run(main())
