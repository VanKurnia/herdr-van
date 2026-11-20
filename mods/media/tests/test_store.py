import json
import os
import re
import sys
import tempfile
import time
import unittest

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
