"""The files this mod publishes, and the one command it takes back: the transport clicks."""

import hashlib
import json
import os
import time

BEAT_STALE_S = 90.0  # the mod beats every 10 s
PROTOCOL_V = 1  # state.json's shape; bump when a field is renamed or removed
LEVELS_EVERY_S = 0.08  # the spectrum, published at the rate the row reads it
COMMANDS = {"prev", "toggle", "next"}
REPLACE_TRIES = 5  # a rename can lose to a reader on Windows; 4 waits of 20 ms ride it out
COVER_SETTLE_S = 6.0  # how long after a track change the artwork may still be on its way
MAX_ART_PX = 512  # the row never draws the art bigger than this
MIN_ART_PX = 64


def shrink_cover(data, px):
    """Re-encode the artwork at `px` on its longer side: the size the row draws it at."""
    if not data or not px:
        return data
    try:
        from io import BytesIO

        from PIL import Image

        with Image.open(BytesIO(data)) as image:
            picture = image.convert("RGBA")
            if max(picture.size) > px:
                picture.thumbnail((px, px), Image.LANCZOS)
            out = BytesIO()
            picture.save(out, format="PNG", optimize=True)
            return out.getvalue()
    except Exception:
        return data  # art the decoder refuses is still better than none


class Writer:
    def __init__(self, home):
        self.dir = os.path.join(home, "data", "media")
        os.makedirs(self.dir, exist_ok=True)
        self.beat_path = os.path.join(self.dir, "beat")
        self.cmd_path = os.path.join(self.dir, "cmd")
        # A click made before this process started is history, not a request: adopt it as seen so
        # a helper restart cannot replay the last one.
        self.seen_command = self._command()[0]
        self.state = None  # the last body written, to skip identical writes
        self.levels = None
        self.levels_at = 0.0
        self.playing = False
        self.cover = None  # last cover path published for this track
        self.cover_key = None  # the track that path belongs to
        self.cover_digest = None  # the bytes behind self.cover, so a re-read of the same art writes nothing
        self.cover_fresh = False  # whether this track has supplied art yet
        self.cover_settle = 0.0  # monotonic deadline while late art is still worth re-reading
        self.raw_cover = None  # the bytes the player gave us, kept so a resize needs no re-read
        self.art_px = 0  # the pixel size the current cover file was encoded at
        self.audio_note = None  # why the audio path last failed, or None

    def stopping(self):
        # Written by the mod, never by this process.
        try:
            age = time.time() - os.path.getmtime(self.beat_path)
        except OSError:
            return False  # the mod has not written one yet
        return age > BEAT_STALE_S

    def wanted(self):
        """Whether the mod is drawing the bars, from the beat's second field.

        A beat with no second field means yes, as does one that is not there yet: the mod writes
        its width on a timer, and an old mod cannot say otherwise.
        """
        try:
            with open(self.beat_path, encoding="utf-8") as fh:
                fields = fh.read().split()
        except OSError:
            return True
        return len(fields) < 2 or fields[1] != "0"

    def _command(self):
        """The click in `cmd`, as (stamp, action); (0, None) when there is nothing to read."""
        try:
            with open(self.cmd_path, encoding="utf-8") as fh:
                body = json.load(fh)
            return int(body["n"]), body["do"]
        except (OSError, ValueError, TypeError, KeyError):
            return 0, None

    def take_command(self):
        """The mod's last transport click, once.

        A click is identified by its stamp rather than a counter, so a number is
        never reused across a restart of either side.
        """
        stamp, action = self._command()
        if action not in COMMANDS or stamp <= self.seen_command:
            return None
        self.seen_command = stamp
        return action

    def _atomic(self, name, body):
        """Write text through a temp file, so the mod never reads a partial body.

        The rename can lose a race with the mod reading the old file, which Windows reports as a
        sharing violation. A few retries ride that out: an exception here would kill the thread
        that keeps this file fresh, and nothing else would ever rewrite it.
        """
        path = os.path.join(self.dir, name)
        with open(path + ".tmp", "w", encoding="utf-8") as fh:
            fh.write(body)
        for attempt in range(REPLACE_TRIES):
            try:
                os.replace(path + ".tmp", path)
                return
            except PermissionError:
                if attempt == REPLACE_TRIES - 1:
                    raise
                time.sleep(0.02)

    def tick(self):
        """Proof of life for the mod: an unchanged track writes nothing else."""
        self._atomic("tick", str(int(time.time())))

    def publish(self, record):
        """Write the whole state body, with the audio thread's verdict riding along.

        The audio thread never writes state.json itself: two writers would each overwrite the
        other's body, blanking the row every time one of them fired. Adding a field is backward
        compatible, so PROTOCOL_V stays 1.
        """
        # One field every body carries, so the mod can tell an older helper's payload from its own.
        body = json.dumps({**record, "v": PROTOCOL_V, "audio": self.audio_note}, ensure_ascii=False)
        if body == self.state:
            return
        self.state = body
        self._atomic("state.json", body)

    def publish_audio_error(self, note):
        """Record why the audio path failed, or None once it works again."""
        self.audio_note = note

    def publish_levels(self, levels, voice=0.0):
        # One shape every time: the mod reads `v` for the art's breath and treating an absent field as
        # a middle value would make silence breathe.
        body = json.dumps({"l": levels, "v": round(voice, 2)}, separators=(",", ":"))
        now = time.time()
        if body == self.levels:
            return
        if self.levels is not None and now - self.levels_at < LEVELS_EVERY_S:
            return
        self.levels, self.levels_at = body, now
        self._atomic("levels.json", body)

    def note_track(self, key, settle_s=COVER_SETTLE_S):
        """Adopt the track the player reports, and open its window for late art.

        A player publishes the picture a moment after the metadata, and the first read after a
        change can still hand back the previous track's: so the art stays worth re-reading for a
        short while, rather than being settled for the whole track off one early read.
        """
        if key == self.cover_key:
            return False
        self.cover_key = key
        self.cover_fresh = False
        self.cover_settle = time.monotonic() + settle_s
        return True

    def cover_due(self):
        """Whether the artwork is worth reading now: none yet for this track, or it may still arrive."""
        return not self.cover_fresh or time.monotonic() < self.cover_settle

    def take_cover(self, data):
        """Store the bytes the player just handed over; the path changes only when the bytes do."""
        if data is not None:
            digest = hashlib.sha1(data).hexdigest()[:8]
            if digest != self.cover_digest:
                self.cover_digest = digest
                self.raw_cover = data
                self.art_px = 0
                self.cover = self.save_cover(data)
            self.cover_fresh = True
        return self.cover

    def art_wanted(self):
        """The pixel size the row says it draws, written by the mod from the layout."""
        try:
            with open(os.path.join(self.dir, "art.json"), "r", encoding="utf-8") as fh:
                px = int(json.load(fh).get("px") or 0)
        except Exception:
            return 0
        return max(MIN_ART_PX, min(MAX_ART_PX, px))

    def sync_art(self):
        """Re-encode when that size changes; True when the published cover path changed."""
        px = self.art_wanted()
        if not px or px == self.art_px or self.raw_cover is None:
            return False
        self.art_px = px
        self.cover = self.save_cover(self.raw_cover)
        return True

    def save_cover(self, data):
        """Store cover art under a content-addressed name, encoded at the size the row draws."""
        if data is None:
            return None
        px = self.art_px or self.art_wanted() or 0
        self.art_px = px
        body = shrink_cover(data, px)
        digest = hashlib.sha1(body).hexdigest()[:8]
        # The drawn size belongs in the name: a resize then lands on a new path, which is how the
        # view learns to reload it. With no known size it keeps the plain content-addressed name.
        name = "cover-%s-%d.png" % (digest, px) if px else "cover-%s.png" % digest
        path = os.path.join(self.dir, name)
        if not os.path.exists(path):
            with open(path + ".tmp", "wb") as fh:
                fh.write(body)
            os.replace(path + ".tmp", path)
            for old in os.listdir(self.dir):
                if old.startswith("cover-") and old != name:
                    os.unlink(os.path.join(self.dir, old))
        # A fresh path per track and per drawn size, so the host never shows a stale decoded image.
        return "data/media/" + name
