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
import atexit
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
from levels import (  # noqa: E402
    BAND_RANGES,
    BANDS,
    BLOCK,
    LOUDNESS,
    RATE,
    VOICE_BINS,
    level,
    release,
    voice_activity,
)
from store import Writer  # noqa: E402

POLL_S = 1.0
CMD_POLL_S = 0.15  # how soon a transport click reaches the player
LOCK_STALE_S = 15.0  # a lock older than this with no living owner may be taken over
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
    filled = await stream.read_async(buffer, size, InputStreamOptions.NONE)
    # The buffer is allocated at `size`, so a short read is padded with zeros: bound it by the
    # length the stream reports, or a truncated PNG is hashed and cached as a cover.
    return bytes(filled)[: filled.length]


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
    # The artwork is only worth opening while the track changed, has no art yet, or is still inside
    # the short window after a change in which the player hands over a late picture. Reading and
    # hashing it on every poll cost a stream read and a sha1 per second, and identical bytes write
    # nothing, so the window costs a handful of reads per track.
    key = (
        (props.title or "").strip(),
        (props.artist or "").strip(),
        (props.album_title or "").strip(),
        session.source_app_user_model_id,
    )
    writer.note_track(key)
    if writer.cover_due():
        writer.take_cover(await read_thumbnail(props.thumbnail))
    # The row publishes the size it draws the art at; when that changes, re-encode from the bytes
    # already in hand rather than shipping one fixed size for every sidebar width and zoom.
    writer.sync_art()
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
    voice_hist = []  # the vocal band's recent levels, for the syllabic cue
    score_hist = []  # the recent voice scores, for the median outlier filter
    last = time.monotonic()

    while not writer.stopping():
        try:
            speaker = sc.default_speaker()
            mic = sc.get_microphone(id=str(speaker.name), include_loopback=True)
            with mic.recorder(samplerate=RATE, channels=1, blocksize=BLOCK) as rec:
                resumed = False
                while not writer.stopping():
                    # Nothing to publish while the track is paused or nobody is drawing the bars:
                    # the recorder stays open (a loopback nobody drains costs nothing), so a resume
                    # or a widened sidebar costs no device setup.
                    if not (writer.playing and writer.wanted()):
                        levels = [0.0] * BANDS  # drop the fall, so a resume starts clean
                        writer.publish_levels(levels)  # deduped: a silent body writes nothing
                        resumed = True
                        time.sleep(0.05)  # still notices a resume within a frame
                        continue
                    block = rec.record(numframes=BLOCK)
                    now = time.monotonic()
                    dt, last = now - last, now
                    if resumed:
                        # A paused loopback buffer still holds pre-pause audio: drop it.
                        resumed = False
                        continue
                    mono = block[:, 0] if block.ndim > 1 else block
                    if len(mono) < BLOCK:
                        continue  # a device can hand back a short first block
                    spec = np.abs(np.fft.rfft(mono * window))
                    fresh = [level(float(spec[a:b].max()) / LOUDNESS) for a, b in BAND_RANGES]
                    levels = release(fresh, levels, dt)
                    # Spectral flatness over the voice's own bins: low for anything pitched, high for
                    # noise and cymbals. Cheap here, and it is the one cue the band levels cannot give.
                    power = spec[VOICE_BINS[0] : VOICE_BINS[1]] ** 2 + 1e-12
                    flatness = float(np.exp(np.mean(np.log(power))) / np.mean(power))
                    score = voice_activity(levels, voice_hist, flatness, RATE / BLOCK)
                    # The outlier filter the literature uses: a median over a handful of frames, so a
                    # single loud consonant does not read as a change of section.
                    score_hist.append(score)
                    del score_hist[:-5]
                    voice = float(np.median(score_hist))
                    writer.publish_levels([round(v, 2) for v in levels], voice)
        except Exception as exc:  # no device yet, or the output device changed
            print("audio failed: %r" % (exc,), file=sys.stderr, flush=True)
            writer.publish_levels([0] * BANDS)
            time.sleep(2.0)


def watch_beat(writer):
    """The process's own heartbeat, and the door out when the window stops beating.

    `tick` is written here, not beside the media sample, so it proves the *process* is alive: a
    player call that never returns would otherwise stop the tick while this thread kept the process
    up, freezing the row and making the mod relaunch a helper that was still running.
    """
    while not writer.stopping():
        writer.tick()
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
        except Exception as exc:  # a player can vanish mid-call; keep the last good state
            print("sample failed: %r" % (exc,), file=sys.stderr, flush=True)
        await asyncio.sleep(POLL_S)


def acquire_lock(home):
    """One helper per app home, held for the whole life of the process.

    The lock file is created exclusively and its handle is kept open, so a
    second helper for the same home cannot take it while this process lives: on
    Windows an open handle also refuses deletion, which is how a live owner is
    told from a lock a dead process left behind. A stale lock with no owner is
    taken over after LOCK_STALE_S.
    """
    path = os.path.join(home, "data", "media", "helper.lock")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # O_TEMPORARY makes the OS delete the file when the handle closes, which a crash does too, so a
    # lock can never be left behind and there is no window between closing and unlinking for a
    # competitor to take it. Closing first and unlinking after left that window open.
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_TEMPORARY", 0)
    temporary = bool(getattr(os, "O_TEMPORARY", 0))

    def release(fd):
        os.close(fd)
        if temporary:
            return  # the OS removed it with the handle
        try:
            os.unlink(path)
        except OSError:
            pass  # already gone: a takeover removed it

    def take():
        try:
            fd = os.open(path, flags)
        except FileExistsError:
            return False
        os.write(fd, str(os.getpid()).encode("ascii"))
        atexit.register(release, fd)
        return True

    if take():
        return True
    try:
        if time.time() - os.path.getmtime(path) <= LOCK_STALE_S:
            return False  # a live owner
        os.unlink(path)
    except OSError:
        return False  # the owner still holds its handle, so the file cannot be removed
    return take()


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True)
    home = parser.parse_args().home
    if not acquire_lock(home):
        print("already running", file=sys.stderr, flush=True)
        sys.exit(3)  # another helper owns this home; the supervisor reads its pid from the lock
    writer = Writer(home)
    manager = await SessionManager.request_async()
    threading.Thread(target=audio_loop, args=(writer,), daemon=True).start()
    threading.Thread(target=watch_beat, args=(writer,), daemon=True).start()
    await asyncio.gather(commands(writer, manager), poll(writer, manager))


if __name__ == "__main__":
    asyncio.run(main())
