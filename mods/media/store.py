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
        self._beat = None  # (mtime, size) of the beat the cached answer was read from
        self._wanted = True  # whether the mod is drawing the bars
        self.cover = None  # last cover path published for this track
        self.cover_key = None  # the track that path belongs to

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
        its width on a timer, and an old mod cannot say otherwise. The answer is cached against the
        file's own identity, because the audio loop asks once per block and opening a file costs ten
        times what stating one does.
        """
        try:
            info = os.stat(self.beat_path)
        except OSError:
            return True
        key = (info.st_mtime_ns, info.st_size)
        if key != self._beat:
            try:
                with open(self.beat_path, encoding="utf-8") as fh:
                    fields = fh.read().split()
            except OSError:
                return True
            self._beat = key
            self._wanted = len(fields) < 2 or fields[1] != "0"
        return self._wanted

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
