"""The files this mod publishes, and the one command it takes back: the transport clicks."""

import hashlib
import json
import os
import time

BEAT_STALE_S = 90.0  # the mod beats every 10 s
PROTOCOL_V = 1  # state.json's shape; bump when a field is renamed or removed
LEVELS_EVERY_S = 0.030  # the publish floor: longer than the 23.2 ms hop on purpose, so one write per two analyses (21.5 Hz). Measured interleaved against 0.018: 20.1 % against 22.5 % of a core, and no picture anyone can tell apart at eight rows of dots.
COMMANDS = {"prev", "toggle", "next"}
REPLACE_TRIES = 5  # a rename can lose to a reader on Windows; 4 waits of 20 ms ride it out
COVER_SETTLE_S = 6.0  # how long after a track change the artwork may still be on its way
MAX_ART_PX = 512  # the row never draws the art bigger than this
MIN_ART_PX = 64
TOP_FADE_SHARE = 0.06  # the blend under the header, as a share of the art's own height
# The two downward veils the row used to paint, now baked into the alpha instead: from this share of
# the poster the art dissolves out, and under the skyline band it steps back further. Painted, they
# ended on a colour (#0a0a19) that only matched the tokyo wallpaper; as alpha they end on nothing,
# so whatever the row stands on shows through.
FADE_FROM = 0.30  # where the art starts dissolving out, as a share of the poster's height
SKY_FROM = 0.70  # where the skyline band begins
SKY_VEIL = 0.94  # how far the art steps back under it


def fade_bottom(picture, cut, span):
    """Bake the row's two downward veils into the art's alpha, in the poster's own coordinates.

    `cut` and `span` describe where the poster's clip meets the art: the art is drawn as a square
    centred in the poster, so only the rows between `cut` and `cut + span` are ever seen. The ramps
    are placed on that visible band, not on the square, or they would land off the poster's foot.
    """
    from PIL import Image, ImageChops

    width, height = picture.size
    span = max(0.01, min(1.0, span))
    ramp = Image.new("L", (1, height))
    for y in range(height):
        poster = (y / height - cut) / span  # 0 at the poster's top, 1 at its foot
        level = 1.0
        if poster > FADE_FROM:
            level *= 1 - min(1.0, (poster - FADE_FROM) / (1 - FADE_FROM))
        if poster > SKY_FROM:
            level *= 1 - SKY_VEIL * min(1.0, (poster - SKY_FROM) / (1 - SKY_FROM))
        ramp.putpixel((0, y), max(0, min(255, round(level * 255))))
    mask = ramp.resize((width, height), Image.NEAREST)
    picture.putalpha(ImageChops.multiply(picture.getchannel("A"), mask))


def fade_top(picture, cut, share):
    """Take the art's top edge to transparent over `share` of its height, starting past `cut`.

    A real alpha ramp, not a scrim: the poster dissolves into whatever it stands on — the wallpaper
    of the moment, grid and all — so no backdrop colour has to be guessed here and nothing goes
    stale when the wallpaper follows the cover. The kit's own way of doing this would be a band of
    clipped copies, but an image whose top leaves its clip parent is culled, so the ramp is baked in
    once, here, and the row draws a single translucent image.

    `cut` is the share of the square the poster's edge hides (a cover wider than the poster is
    centred, so its first rows sit above the clip): the ramp starts there, where it can be seen.
    """
    from PIL import Image, ImageChops

    width, height = picture.size
    skip = max(0, min(height - 1, round(height * max(0.0, cut))))
    rows = max(1, min(height - skip, round(height * share)))
    # A vertical ramp for those rows only: 0 at the very top of the visible art, 255 where it ends.
    ramp = Image.linear_gradient("L").resize((width, rows), Image.BILINEAR)
    strip = picture.crop((0, skip, width, skip + rows))
    strip.putalpha(ImageChops.multiply(strip.getchannel("A"), ramp))
    picture.paste(strip, (0, skip))


def shrink_cover(data, px, cut=0.0, span=1.0):
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
            fade_top(picture, cut, TOP_FADE_SHARE)
            fade_bottom(picture, cut, span)
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
        self.art_cut = 0.0  # how much of the art's top that encode was told the poster hides
        self.art_span = 1.0  # how much of the art's height that encode was told the poster shows
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

    def _stream(self, name, body):
        """Write a fast stream file in place, retried, with the atomic path as the fallback.

        The temp-and-rename path is what makes `state.json`, `tick` and `beat` safe to lose a race
        with, but it costs a file creation and a rename for every write, and this file is written
        forty times a second: measured on this machine, 9.0 % of a core against 4.3 % in place. The
        trade is safe for this one file — the mod treats a body it cannot parse as "keep the last good
        reading" — and a body cut short is never valid JSON, because the shape always ends in `}`.
        """
        path = os.path.join(self.dir, name)
        for attempt in range(REPLACE_TRIES):
            try:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(body)
                return
            except PermissionError:  # the mod has the file open: retry, as the rename path does
                if attempt == REPLACE_TRIES - 1:
                    self._atomic(name, body)
                    return
                time.sleep(0.005)

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
        self._stream("levels.json", body)

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
        """The pixel size, top cut and visible span the row draws, written by the mod from the layout."""
        px, cut, span = 0, 0.0, 1.0
        try:
            with open(os.path.join(self.dir, "art.json"), "r", encoding="utf-8") as fh:
                body = json.load(fh)
            px = int(body.get("px") or 0)
            cut = float(body.get("cut") or 0.0)
            span = float(body.get("span") or 1.0)
        except Exception:
            return 0, 0.0, 1.0
        return (
            max(MIN_ART_PX, min(MAX_ART_PX, px)),
            max(0.0, min(0.5, cut)),
            max(0.05, min(1.0, span)),
        )

    def sync_art(self):
        """Re-encode when that size or that geometry changes; True when the cover path changed."""
        px, cut, span = self.art_wanted()
        if not px or self.raw_cover is None:
            return False
        if px == self.art_px and cut == self.art_cut and span == self.art_span:
            return False
        self.art_px = px
        self.art_cut = cut
        self.art_span = span
        self.cover = self.save_cover(self.raw_cover)
        return True

    def save_cover(self, data):
        """Store cover art under a content-addressed name, encoded at the size the row draws."""
        if data is None:
            return None
        px, cut, span = self.art_wanted()
        self.art_px = px
        self.art_cut = cut
        self.art_span = span
        body = shrink_cover(data, px, cut, span)
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
