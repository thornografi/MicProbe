"""Known-time adversarial signals, independent of real platform audio and thresholds."""
import sys
import copy
import unittest
from pathlib import Path

import numpy as np
from scipy import signal

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from platform_lab import audio, alignment

RATE = 8000


def repeated_fixture(delays=(0, .016, .018), gains=(.5, 1.1, .6)):
    rng = np.random.default_rng(137)
    # Distinct syllable-like modulation, with the SAME utterance in three slots.
    voice = signal.lfilter([1], [1, -.82], rng.normal(0, .05, 8 * RATE))
    t = np.arange(len(voice)) / RATE
    knots = np.arange(0, 8.25, .25)
    voice *= np.interp(t, knots, rng.uniform(.05, 1, len(knots))) ** 2
    reference = np.zeros(44 * RATE)
    reference[:RATE] = rng.normal(0, .04, RATE)
    reference[28 * RATE:] = rng.normal(0, .007, 16 * RATE)
    sections = []
    transformed = np.zeros(44 * RATE)
    for i, (start, level, delay, gain) in enumerate(zip((4, 12, 20), (1, .125, 1), delays, gains)):
        reference[start * RATE:(start + 8) * RATE] = voice * level
        part = voice * level * gain
        part[:RATE] = 0
        dest = round((start + delay) * RATE)
        transformed[dest:dest + len(part)] = part
        sections.append(dict(name=f'speech-{i}', kind='speech', startSeconds=start, endSeconds=start + 8))
    offset = 27.716
    received = np.pad(transformed, (round(offset * RATE), 18 * RATE))
    return reference[:, None], received[:, None], sections, offset


class AlignmentTests(unittest.TestCase):
    def test_global_never_accepts_a_wrong_repetition_with_a_silent_half(self):
        ref, rx, _, _ = repeated_fixture()
        result = audio.estimate_alignment(ref, RATE, rx, RATE)
        self.assertEqual(result['status'], 'unavailable', result)
        self.assertEqual(result['reason'], 'weak-independent-half', result)

    def test_ordered_sections_recover_known_local_timing_without_retiming_pcm(self):
        ref, rx, sections, offset = repeated_fixture()
        before = rx.copy()
        result = audio.estimate_alignment(ref, RATE, rx, RATE, sections=sections)
        self.assertEqual(result['status'], 'partial', result)
        for section, delay in zip(sections, (0, .016, .018)):
            match = result['sections'][section['name']]
            self.assertEqual(match['status'], 'aligned', match)
            self.assertAlmostEqual(match['offsetSeconds'], offset + delay, delta=.004)
        np.testing.assert_array_equal(rx, before)

    def test_identical_complete_copies_are_ambiguous(self):
        ref, rx, sections, _ = repeated_fixture(delays=(0, 0, 0))
        double = np.concatenate((rx, np.zeros((RATE, 1)), rx))
        result = audio.estimate_alignment(ref, RATE, double, RATE, sections=sections)
        self.assertEqual(result['status'], 'unavailable', result)

    def test_wrong_reference_and_missing_repeats_do_not_become_good_sections(self):
        ref, rx, sections, _ = repeated_fixture()
        for bad in (np.random.default_rng(999).normal(0, .03, rx.shape), rx[:40 * RATE]):
            result = audio.estimate_alignment(ref, RATE, bad, RATE, sections=sections)
            self.assertNotIn(result['status'], ('aligned', 'partial'), result)

    def test_dc_is_not_a_strong_independent_half(self):
        x = np.random.default_rng(38).normal(0, .04, (8 * RATE, 1))
        y = x.copy();y[4 * RATE:] = .01
        self.assertEqual(audio.estimate_alignment(x, RATE, y, RATE)['status'], 'unavailable')

    def test_polarity_gain_and_dc_do_not_invalidate_real_matching(self):
        x = np.random.default_rng(19).normal(0, .04, (8 * RATE, 1))
        y = np.pad(-x * .5, ((RATE, RATE), (0, 0))) + .02
        result = audio.estimate_alignment(x, RATE, y, RATE)
        self.assertEqual(result['status'], 'aligned', result)
        self.assertEqual(result['offsetSeconds'], 1)
        self.assertGreater(result['similarity'], .999)

    def test_small_receiver_excerpt_cannot_count_as_full_reference(self):
        x = np.random.default_rng(29).normal(0, .04, (8 * RATE, 1))
        result = audio.estimate_alignment(x, RATE, x[:2 * RATE], RATE)
        self.assertEqual(result['reason'], 'insufficient-reference-overlap', result)

    def test_changed_waveform_with_matching_envelope_is_rejected(self):
        ref, rx, sections, _ = repeated_fixture()
        shuffled = rx[:len(rx) // 80 * 80].copy().reshape(-1, 80)
        np.random.default_rng(4).shuffle(shuffled, axis=1)
        result = audio.estimate_alignment(ref, RATE, shuffled.reshape(-1, 1), RATE, sections=sections)
        self.assertEqual(result['status'], 'unavailable', result)

    def test_large_timing_change_within_one_section_is_rejected(self):
        rng = np.random.default_rng(54)
        x = rng.normal(0, .04, 8 * RATE)
        y = np.zeros(9 * RATE)
        y[:4 * RATE] = x[:4 * RATE]
        y[round(4.08 * RATE):round(8.08 * RATE)] = x[4 * RATE:]
        section = dict(name='speech', kind='speech', startSeconds=0, endSeconds=8)
        # Padding permits both boundaries; there is an 80-ms jump in the middle.
        result = alignment.speech_section(x, np.pad(y, (RATE, 0)), section, 1.04)
        self.assertEqual(result['reason'], 'local-timing-spread-too-large', result)

    def test_invalid_recipes_are_rejected_before_measurement(self):
        _, _, sections, _ = repeated_fixture()
        for mutate in (
            lambda s: s[1].update(name=s[0]['name']),
            lambda s: s[1].update(startSeconds=7),
            lambda s: s[0].update(endSeconds=float('nan')),
            lambda s: s[0].update(startSeconds=True),
            lambda s: s[2].update(endSeconds=45),
        ):
            bad = copy.deepcopy(sections)
            mutate(bad)
            with self.assertRaises(ValueError):
                alignment.validate_sections(bad, 44)

    def test_gain_uses_actual_source_and_failed_source_is_never_replaced(self):
        ref = np.random.default_rng(75).normal(0, .05, (8 * RATE, 1))
        source = ref * .25
        received = np.pad(source * .5, ((RATE, RATE), (0, 0)))
        sections = [dict(name='speech', kind='speech', startSeconds=0, endSeconds=8)]
        source_map = {'status': 'aligned', 'offsetSeconds': 0}
        receiver_map = {'status': 'partial', 'sections': {'speech': {'status': 'aligned', 'offsetSeconds': 1, 'edgeTrimSeconds': .1}}}
        decoded = {'reference-audio': (ref, RATE), 'source-audio': (source, RATE), 'receiver-audio': (received, RATE)}
        mappings = {'source-audio': source_map, 'receiver-audio': receiver_map}
        row = audio.section_comparisons(decoded, mappings, sections, True)[0]
        self.assertEqual(row['status'], 'measured')
        self.assertAlmostEqual(row['gainDb'], -6.0206, places=3)
        self.assertEqual(row['referenceRangeSeconds'], [.1, 7.9])
        self.assertEqual(row['ranges']['receiver-audio']['startSample'], 8800)
        for absent in (False, True):
            if absent:
                decoded.pop('source-audio')
            mappings['source-audio'] = {'status': 'unavailable', 'reason': 'weak'}
            row = audio.section_comparisons(decoded, mappings, sections, True)[0]
            self.assertEqual(row['status'], 'incomplete')
            self.assertIsNone(row['gainDb'])
            self.assertEqual(row['comparisonBasis'], 'source-audio → receiver-audio')
        # Nominal reference is legitimate only when no source was supplied at all.
        row = audio.section_comparisons(decoded, mappings, sections, False)[0]
        self.assertAlmostEqual(row['gainDb'], -18.0618, places=3)

    def test_partial_mapping_does_not_extrapolate_to_noise(self):
        x = np.ones((8 * RATE, 1)) * .01
        sections = [dict(name='noise', kind='noise', startSeconds=1, endSeconds=2)]
        decoded = {'reference-audio': (x, RATE), 'receiver-audio': (x, RATE)}
        mappings = {'receiver-audio': {'status': 'partial', 'sections': {}}}
        row = audio.section_comparisons(decoded, mappings, sections, False)[0]
        self.assertEqual(row['status'], 'incomplete')
        self.assertIsNone(row['gainDb'])


if __name__ == '__main__':
    unittest.main()
