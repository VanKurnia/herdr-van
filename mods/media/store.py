"""The files this mod publishes: one writer per file, atomic bodies, a throttle on the spectrum."""

import hashlib
import json
import os
import time

BEAT_STALE_S = 90.0  # the mod beats every 10 s
PROTOCOL_V = 1  # state.json's shape; bump when a field is renamed or removed
LEVELS_EVERY_S = 0.1  # the spectrum, published ~10 times a second


class Writer:
    def __init__(self, home):
        self.dir = os.path.join(home, "data", "media")
        os.makedirs(self.dir, exist_ok=True)
        self.beat_path = os.path.join(self.dir, "beat")
        self.state = None  # the last body written, to skip identical writes
        self.levels = None
        self.levels_at = 0.0
        self.playing = False
        self.cover = None  # last cover path published for this track
        self.cover_key = None  # the track that path belongs to

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
        # One field every body carries, so the mod can tell an older helper's payload from its own.
        body = json.dumps({**record, "v": PROTOCOL_V}, ensure_ascii=False)
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
