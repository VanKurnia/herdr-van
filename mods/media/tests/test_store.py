import json
import os
import re
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import levels
import store


class StoreTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = self._tmp.name
        self.dir = os.path.join(self.home, "data", "media")
        self.writer = store.Writer(self.home)

    def tearDown(self):
        self._tmp.cleanup()

    def read(self, name):
        with open(os.path.join(self.dir, name), encoding="utf-8") as fh:
            return fh.read()

    def test_publish_writes_one_atomic_body(self):
        self.writer.publish({"session": False})
        self.assertEqual(json.loads(self.read("state.json")), {"session": False, "v": store.PROTOCOL_V})
        self.assertEqual([n for n in os.listdir(self.dir) if n.endswith(".tmp")], [])

    def test_publish_skips_identical_body(self):
        self.writer.publish({"session": False})
        path = os.path.join(self.dir, "state.json")
        before = os.stat(path).st_mtime_ns
        time.sleep(0.02)
        self.writer.publish({"session": False})
        self.assertEqual(os.stat(path).st_mtime_ns, before)

    def test_publish_levels_throttles(self):
        self.writer.publish_levels([0.1] * levels.BANDS)
        time.sleep(0.02)
        self.writer.publish_levels([0.2] * levels.BANDS)
        self.assertEqual(json.loads(self.read("levels.json"))["l"], [0.1] * levels.BANDS)
        time.sleep(store.LEVELS_EVERY_S + 0.05)
        self.writer.publish_levels([0.2] * levels.BANDS)
        self.assertEqual(json.loads(self.read("levels.json"))["l"], [0.2] * levels.BANDS)

    def test_publish_levels_writes_once_per_window(self):
        self.writer.publish_levels([0.1] * levels.BANDS)
        path = os.path.join(self.dir, "levels.json")
        before = os.stat(path).st_mtime_ns
        for v in (0.2, 0.3, 0.4, 0.5):
            time.sleep(0.005)
            self.writer.publish_levels([v] * levels.BANDS)
        self.assertEqual(os.stat(path).st_mtime_ns, before)
        time.sleep(store.LEVELS_EVERY_S + 0.05)
        self.writer.publish_levels([0.6] * levels.BANDS)
        self.assertEqual(json.loads(self.read("levels.json"))["l"], [0.6] * levels.BANDS)

    def test_publish_levels_skips_identical_body_after_window(self):
        self.writer.publish_levels([0.1] * levels.BANDS)
        path = os.path.join(self.dir, "levels.json")
        time.sleep(store.LEVELS_EVERY_S + 0.05)
        before = os.stat(path).st_mtime_ns
        self.writer.publish_levels([0.1] * levels.BANDS)
        self.assertEqual(os.stat(path).st_mtime_ns, before)

    def test_save_cover_is_content_addressed_and_prunes(self):
        first = b"\x89PNG-first"
        path = self.writer.save_cover(first)
        self.assertRegex(path, r"^data/media/cover-[0-9a-f]{8}\.png$")
        with open(os.path.join(self.home, path), "rb") as fh:
            self.assertEqual(fh.read(), first)
        second = self.writer.save_cover(b"\x89PNG-second")
        self.assertNotEqual(second, path)
        self.assertFalse(os.path.exists(os.path.join(self.home, path)))
        covers = [n for n in os.listdir(self.dir) if re.match(r"^cover-.*\.png$", n)]
        self.assertEqual(len(covers), 1)

    def test_save_cover_none(self):
        self.assertIsNone(self.writer.save_cover(None))

    def test_a_lost_rename_is_retried(self):
        # The mod reading `tick` while it is replaced is a sharing violation on Windows. Losing the
        # write is not fatal, but letting the exception escape kills the thread that publishes it.
        real = store.os.replace
        calls = []

        def flaky(src, dst):
            calls.append(dst)
            if len(calls) == 1:
                raise PermissionError("sharing violation")
            real(src, dst)

        with mock.patch.object(store.os, "replace", flaky):
            self.writer.tick()
        self.assertEqual(len(calls), 2)
        self.assertTrue(self.read("tick"))

    def beat(self, body):
        with open(os.path.join(self.dir, "beat"), "w", encoding="utf-8") as fh:
            fh.write(body)

    def test_wanted_follows_the_beats_flag(self):
        self.beat("1700000000 1")
        self.assertTrue(self.writer.wanted())
        self.beat("1700000000 0")
        self.assertFalse(self.writer.wanted())
        self.beat("1700000000 1")
        self.assertTrue(self.writer.wanted())

    def test_wanted_defaults_to_yes(self):
        # No beat yet (the mod is starting), or a beat from an older mod with no second field.
        self.assertTrue(self.writer.wanted())
        self.beat("1700000000")
        self.assertTrue(self.writer.wanted())

    def test_wanted_is_cached_until_the_beat_changes(self):
        self.beat("1700000000 0")
        self.assertFalse(self.writer.wanted())
        path = os.path.join(self.dir, "beat")
        stamp = os.stat(path).st_mtime_ns
        os.utime(path, ns=(stamp, stamp))  # same mtime and size: the cached answer stands
        self.assertFalse(self.writer.wanted())
        self.beat("1700000001 1")
        self.assertTrue(self.writer.wanted())

    def test_stopping_reads_the_beats_age(self):
        self.assertFalse(self.writer.stopping())
        beat = os.path.join(self.dir, "beat")
        with open(beat, "w", encoding="utf-8") as fh:
            fh.write("1")
        t = time.time() - store.BEAT_STALE_S - 10
        os.utime(beat, (t, t))
        self.assertTrue(self.writer.stopping())


if __name__ == "__main__":
    unittest.main()
