import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import levels


class BandRangeTest(unittest.TestCase):
    def test_one_range_per_band(self):
        self.assertEqual(len(levels.BAND_RANGES), levels.BANDS)

    def test_ranges_are_in_bounds(self):
        for lo, hi in levels.BAND_RANGES:
            self.assertGreaterEqual(lo, 1)
            self.assertLess(lo, hi)
            self.assertLessEqual(hi, levels.BLOCK // 2)

    def test_ranges_never_move_backwards(self):
        # The lowest bands are narrower than one bin, so neighbouring bands share an edge; the
        # bands must never run backwards, and the last must still reach the top of the range.
        for i in range(len(levels.BAND_RANGES) - 1):
            lo, hi = levels.BAND_RANGES[i]
            next_lo, next_hi = levels.BAND_RANGES[i + 1]
            self.assertLessEqual(lo, next_lo)
            self.assertLessEqual(hi, next_hi)
        self.assertEqual(levels.BAND_RANGES[-1][1], round(levels.HIGH_HZ / (levels.RATE / levels.BLOCK)))


class LevelTest(unittest.TestCase):
    def test_silence_is_empty(self):
        self.assertEqual(levels.level(0), 0.0)
        self.assertEqual(levels.level(1e-12), 0.0)

    def test_floor_is_empty(self):
        self.assertAlmostEqual(levels.level(10 ** (levels.FLOOR_DB / 20)), 0.0, places=6)

    def test_loudness_is_full(self):
        self.assertEqual(levels.level(levels.LOUDNESS), 1.0)

    def test_monotone(self):
        self.assertLessEqual(levels.level(0.001), levels.level(0.01))
        self.assertLessEqual(levels.level(0.01), levels.level(1.0))

    def test_sweep_stays_in_range(self):
        for peak in (1e-12, 1e-9, 1e-6, 0.001, 0.01, 0.1, 0.5, 1.0, 10.0):
            value = levels.level(peak)
            self.assertGreaterEqual(value, 0.0)
            self.assertLessEqual(value, 1.0)


class ReleaseTest(unittest.TestCase):
    def test_fall_follows_the_clock_not_the_block(self):
        # One time constant of release leaves 1/e of the gap, whatever the block rate is.
        one_tau = levels.release([0.0], [1.0], levels.TAU_RELEASE)[0]
        self.assertAlmostEqual(one_tau, 1 / math.e, places=3)
        self.assertGreater(levels.release([0.0], [1.0], levels.TAU_RELEASE / 2)[0], one_tau)
        self.assertLess(levels.release([0.0], [1.0], levels.TAU_RELEASE * 2)[0], one_tau)

    def test_no_time_means_no_change(self):
        self.assertEqual(levels.release([0.0, 1.0], [0.5, 0.2], 0), [0.5, 0.2])

    def test_attack_reaches_the_new_value_at_once(self):
        self.assertEqual(levels.release([0.9], [0.1], 0.046)[0], 0.9)

    def test_never_overshoots(self):
        for dt in (0.01, 0.046, 0.5, 5.0):
            for fresh, prev in ((0.0, 1.0), (1.0, 0.0), (0.6, 0.6)):
                value = levels.release([fresh], [prev], dt)[0]
                self.assertGreaterEqual(value, min(fresh, prev) - 1e-9)
                self.assertLessEqual(value, max(fresh, prev) + 1e-9)


if __name__ == "__main__":
    unittest.main()
