import math
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import levels


def reference_fluctuation(history, frame_hz):
    """The straightforward DFT `levels.fluctuation` used to run: every bin, trig rebuilt per call."""
    n = len(history)
    if n < 8:
        return 0.0
    mean = sum(history) / n
    centred = [value - mean for value in history]
    in_band = 0.0
    total = 0.0
    for k in range(1, n // 2 + 1):
        hz = k * frame_hz / n
        weight = 2.0 * math.pi * k / n
        real = 0.0
        imaginary = 0.0
        for i, value in enumerate(centred):
            real += value * math.cos(weight * i)
            imaginary -= value * math.sin(weight * i)
        power = real * real + imaginary * imaginary
        total += power
        if levels.FLUCT_LOW_HZ <= hz <= levels.FLUCT_HIGH_HZ:
            in_band += power
    return in_band / total if total > 0.0 else 0.0


class FluctuationTest(unittest.TestCase):
    def test_matches_the_transform_it_replaced(self):
        # The rewrite is only a rewrite: same answer as the all-bins DFT on every history length the
        # envelope can have.
        rng = random.Random(7)
        frame_hz = levels.RATE / levels.BLOCK
        for _ in range(200):
            length = rng.randint(8, levels.VOICE_FRAMES)
            history = [rng.random() for _ in range(length)]
            self.assertLess(
                abs(levels.fluctuation(history, frame_hz) - reference_fluctuation(history, frame_hz)), 1e-9
            )

    def test_too_short_is_nothing(self):
        self.assertEqual(levels.fluctuation([0.5] * 7, levels.RATE / levels.BLOCK), 0.0)

    def test_a_constant_history_moves_not_at_all(self):
        # 0.5 divides exactly, so the mean-centring leaves true zeros rather than rounding dust.
        history = [0.5] * levels.VOICE_FRAMES
        self.assertEqual(levels.fluctuation(history, levels.RATE / levels.BLOCK), 0.0)
        self.assertEqual(reference_fluctuation(history, levels.RATE / levels.BLOCK), 0.0)


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


class VoiceTest(unittest.TestCase):
    def test_a_silent_scene_reads_as_no_voice(self):
        history = []
        bands = [0.0] * levels.BANDS
        self.assertEqual(levels.voice_activity(bands, history), 0.0)

    def test_the_mid_band_alone_is_not_a_voice(self):
        # A guitar sitting in the vocal band, with nothing above it: the band is loud, the wobble is
        # steady, and the share against the other bands is flat. This is the case that used to light
        # the art as if someone were singing.
        history = []
        loop = [0.6] * levels.BANDS
        for _ in range(30):
            heard = levels.voice_activity(loop, history)
        self.assertLess(heard, 0.3)

    def test_a_sung_line_reads_as_voice(self):
        # Syllables: the vocal band rises and falls against a quieter rest of the mix.
        history = []
        for i in range(40):
            bands = [0.25] * levels.BANDS
            for b in range(levels.VOICE_RANGE[0], levels.VOICE_RANGE[1] + 1):
                bands[b] = 0.85 if i % 3 == 0 else 0.3
            heard = levels.voice_activity(bands, history)
        self.assertGreater(heard, 0.45)

    def test_history_is_bounded(self):
        history = []
        for _ in range(200):
            levels.voice_activity([0.5] * levels.BANDS, history)
        self.assertLessEqual(len(history), levels.VOICE_FRAMES)



class GainTest(unittest.TestCase):
    def run_gain(self, spectrum, seconds, peak=1.0, frame_hz=levels.RATE / levels.BLOCK):
        dt = 1.0 / frame_hz
        scaled = spectrum
        for _ in range(int(seconds * frame_hz)):
            scaled, peak = levels.gain(spectrum, peak, dt)
        return scaled, peak

    def test_a_quiet_spectrum_fills_the_row(self):
        # 0.25 of full scale is what a quiet master draws; over a few seconds it should reach the top.
        scaled, _ = self.run_gain([0.25] * levels.BANDS, 10.0)
        self.assertAlmostEqual(max(scaled), 1.0, places=3)
        self.assertAlmostEqual(min(scaled), 1.0, places=3)

    def test_full_scale_is_left_alone(self):
        # No time passing means no decay: a row already at full scale is drawn as it came in.
        scaled, peak = levels.gain([1.0, 0.5], 1.0, 0.0)
        self.assertEqual(peak, 1.0)
        self.assertEqual(scaled, [1.0, 0.5])

    def test_silence_lets_the_peak_decay(self):
        # A loud peak must not stick: without this a quiet passage after a chorus stays invisible.
        quiet = [0.02] * levels.BANDS
        silent, peak = self.run_gain([0.0] * levels.BANDS, 10.0, peak=1.0)
        self.assertEqual(silent, [0.0] * levels.BANDS)
        self.assertLess(peak, 0.05)
        _, later = self.run_gain(quiet, 0.0, peak=peak)
        self.assertLess(later, 1.0)

    def test_the_peak_never_exceeds_the_loudest_band(self):
        peak = 0.5
        for _ in range(400):
            bands = [0.1, 0.3, 0.2]
            _, peak = levels.gain(bands, peak, 0.0464)
            self.assertLessEqual(peak, max(0.5, max(bands)) + 1e-12)

    def test_band_ratios_survive_the_gain(self):
        # The property that protects voice_activity and the skyline: one gain moves the whole row, it
        # does not flatten the bands toward each other.
        bands = [0.2] * levels.BANDS
        bands[levels.VOICE_RANGE[0]] = 0.6
        scaled, _ = levels.gain(bands, 1.0, 0.0464)
        self.assertAlmostEqual(scaled[levels.VOICE_RANGE[0]] / scaled[0], 0.6 / 0.2, places=9)

    def test_nothing_to_see_stays_flat(self):
        scaled, peak = self.run_gain([0.0] * levels.BANDS, 60.0)
        self.assertEqual(scaled, [0.0] * levels.BANDS)
        self.assertLess(peak, 1e-6)


class EnvelopeTest(unittest.TestCase):
    def test_fall_follows_the_clock_not_the_block(self):
        # One time constant of release leaves 1/e of the gap, whatever the block rate is.
        one_tau = levels.envelope([0.0], [1.0], levels.TAU_RELEASE)[0]
        self.assertAlmostEqual(one_tau, 1 / math.e, places=3)
        self.assertGreater(levels.envelope([0.0], [1.0], levels.TAU_RELEASE / 2)[0], one_tau)
        self.assertLess(levels.envelope([0.0], [1.0], levels.TAU_RELEASE * 2)[0], one_tau)

    def test_no_time_means_no_change(self):
        self.assertEqual(levels.envelope([0.0, 1.0], [0.5, 0.2], 0), [0.5, 0.2])

    def test_a_rise_is_smoothed_by_the_attack(self):
        # One block (2048 samples at 44.1 kHz is 46.4 ms) gets most, not all, of the way up.
        dt = levels.BLOCK / levels.RATE
        risen = levels.envelope([1.0], [0.0], dt)[0]
        self.assertAlmostEqual(risen, 1.0 - math.exp(-dt / levels.TAU_ATTACK), places=6)
        self.assertGreater(risen, 0.6)
        self.assertLess(risen, 0.7)

    def test_a_fall_is_slower_than_a_rise(self):
        # The asymmetry is the point: same block, same distance, very different fractions.
        dt = levels.BLOCK / levels.RATE
        rise = levels.envelope([1.0], [0.0], dt)[0]
        fall = 1.0 - levels.envelope([0.0], [1.0], dt)[0]
        self.assertAlmostEqual(fall, 1.0 - math.exp(-dt / levels.TAU_RELEASE), places=6)
        self.assertLess(fall, 0.2)
        self.assertGreater(rise, fall * 3)

    def test_never_overshoots(self):
        for dt in (0.01, 0.046, 0.5, 5.0):
            for fresh, prev in ((0.0, 1.0), (1.0, 0.0), (0.6, 0.6)):
                value = levels.envelope([fresh], [prev], dt)[0]
                self.assertGreaterEqual(value, min(fresh, prev) - 1e-9)
                self.assertLessEqual(value, max(fresh, prev) + 1e-9)


if __name__ == "__main__":
    unittest.main()
