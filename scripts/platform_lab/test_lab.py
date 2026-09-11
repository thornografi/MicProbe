"""Analytical counter references, broken captures and hardware-free audio fixtures."""
import io
import base64
import copy
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.io import wavfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from platform_lab import audio, bundle, rtp
from platform_lab.cli import ingest
from platform_lab.browser_capture import unpack, unpack_micprobe, import_capture
from platform_lab.report import analyze, compare
from concurrent.futures import ThreadPoolExecutor

START = datetime(2026, 9, 8, 12, tzinfo=timezone.utc).timestamp() * 1000


def stamp(seconds):
    return datetime.fromtimestamp(START / 1000 + seconds, timezone.utc).isoformat()


def samples(count=11):
    return [dict(connectionId='pc', streamId='audio', direction='inbound', timestampMs=START + i * 1000,
                 bytes=i * 4000, packets=i * 50, lost=0, jitterSeconds=.004,
                 codec={'mimeType': 'audio/opus', 'clockRate': 48000}) for i in range(count)]


class BrowserCaptureTests(unittest.TestCase):
    def fixture(self):
        return {'schemaVersion': 1, 'runId': 'test-run',
                'state': {'runId': 'test-run', 'collecting': False, 'captureActive': False,
                          'errors': [], 'pcmBytes': 4, 'pcmChunks': 2, 'statsCount': 1},
                'records': [
                    {'kind': 'metadata', 'runId': 'test-run', 'captureMime': 'audio/webm;codecs=pcm'},
                    {'kind': 'event', 'name': 'pcm-start'},
                    {'kind': 'pcm-container', 'dataBase64': base64.b64encode(b'ab').decode()},
                    {'kind': 'stats', 'connectionId': 'pc', 'reports': [
                        {'id': 'rx', 'type': 'inbound-rtp', 'kind': 'audio', 'timestamp': START,
                         'bytesReceived': 4000, 'packetsReceived': 50, 'codecId': 'c', 'jitter': .003},
                        {'id': 'c', 'type': 'codec', 'mimeType': 'audio/opus', 'clockRate': 48000,
                         'transportId': 'must-not-leak'}]},
                    {'kind': 'pcm-container', 'dataBase64': base64.b64encode(b'cd').decode()},
                    {'kind': 'event', 'name': 'collector-stop'}]}

    def test_pcm_chunks_keep_order_and_rtp_units(self):
        pcm, rows = unpack(self.fixture(), 'test-run')
        self.assertEqual(pcm, b'abcd')
        self.assertEqual(rows[0]['bytes'], 4000)
        self.assertEqual(rows[0]['jitterSeconds'], .003)
        self.assertEqual(rows[0]['codec'], {'mimeType': 'audio/opus', 'clockRate': 48000})

    def test_incomplete_lossy_or_mismatched_capture_is_rejected(self):
        for mutate in (
            lambda d: d.update(runId='another-run'),
            lambda d: d['state'].update(collecting=True),
            lambda d: d['state'].update(pcmBytes=5),
            lambda d: d['state'].update(statsCount=2),
            lambda d: d['state'].update(errors=['write failed']),
            lambda d: d['records'][0].update(captureMime='audio/webm;codecs=opus'),
            lambda d: d['records'].pop(),
        ):
            data = copy.deepcopy(self.fixture())
            mutate(data)
            with self.assertRaises(ValueError):
                unpack(data, 'test-run')

    def test_sender_pcm_cannot_be_imported_as_receiver(self):
        data = self.fixture()
        data['records'][0]['capturePoint'] = 'sender-outbound'
        with self.assertRaises(ValueError):
            unpack(data, 'test-run')
        pcm, _ = unpack(data, 'test-run', capture_point='sender-outbound')
        self.assertEqual(pcm, b'abcd')

    def test_local_lab_requires_both_complete_taps_and_released_input(self):
        sender = self.fixture()
        sender['records'][0]['capturePoint'] = 'sender-outbound'
        data = {'schemaVersion': 1, 'runId': 'test-run', 'snapshot': {'runId': 'test-run'},
                'errors': [], 'liveInputTracks': 0, 'stoppedAt': stamp(10), 'stopReason': 'reference-deadline',
                'settingsContext': {'basis': 'local-profile', 'defaultEvidence': None, 'overrides': {}},
                'captures': {'sender-outbound': sender, 'receiver': self.fixture()}}
        self.assertEqual(unpack_micprobe(data, 'test-run')['receiver'][0], b'abcd')
        for mutate in (lambda d: d.update(liveInputTracks=1),
                       lambda d: d['snapshot'].update(runId='old'),
                       lambda d: d.update(stopReason='watchdog'),
                       lambda d: d.update(errors=['failed']),
                       lambda d: d['captures'].pop('sender-outbound'),
                       lambda d: d['captures']['receiver']['state'].update(pcmBytes=5),
                       lambda d: d['settingsContext'].update(basis='verified-default')):
            broken = copy.deepcopy(data)
            mutate(broken)
            with self.assertRaises(ValueError):
                unpack_micprobe(broken, 'test-run')

    def input_fixture(self):
        data = self.fixture()
        data.update(schemaVersion=2, captureId='pre')
        data['state'].update(captureId='pre', pending=0, statsCount=0)
        data['records'] = [r for r in data['records'] if r['kind'] != 'stats']
        data['records'][0].update(capturePoint='browser-input', statsScope='none', connectionId=None,
                                  trackId='mic', availableTrackIds=['mic'], trackSelection='explicit-track-id',
                                  inputProvenance={'kind': 'observed-getUserMedia-result',
                                                   'observerRunId': 'test-run', 'observerStartedAt': START})
        for i, record in enumerate(data['records']):
            record.update(runId='test-run', captureId='pre', sequence=i)
            if record['kind'] == 'pcm-container':
                record['byteLength'] = 2
        return data

    def test_browser_input_pcm_is_valid_without_inventing_rtp(self):
        pcm, rows = unpack(self.input_fixture(), 'test-run', 'browser-input')
        self.assertEqual(pcm, b'abcd')
        self.assertEqual(rows, [])
        with self.assertRaises(ValueError):
            unpack(self.input_fixture(), 'test-run')

    def test_new_capture_rejects_mixed_reordered_incomplete_or_mislabeled_records(self):
        for mutate in (
            lambda d: d['records'][2].update(captureId='other'),
            lambda d: d['records'][2].update(runId='old'),
            lambda d: d['records'][2].update(sequence=3),
            lambda d: d['records'][2].update(byteLength=1),
            lambda d: d['state'].update(pending=1),
            lambda d: d['records'][0].update(statsScope='peer-connection-audio'),
            lambda d: d['records'][0].update(connectionId='unrelated-peer'),
            lambda d: d['records'][0].update(trackId='unobserved'),
            lambda d: d['records'][0]['inputProvenance'].update(observerRunId='old'),
            lambda d: d.update(schemaVersion=1),
        ):
            data = self.input_fixture()
            mutate(data)
            with self.assertRaises(ValueError):
                unpack(data, 'test-run', 'browser-input')

    def test_input_import_keeps_intermediate_evidence_separate_from_source_receiver_and_rtp(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / 'run'
            bundle.init(run, 'other', 'desktop-web', 'synthetic-input-test')
            with bundle.edit_run(run) as (_, manifest):
                manifest['runId'] = 'test-run'
            source = root / 'input.json'
            source.write_text(json.dumps(self.input_fixture()), encoding='utf-8')
            # A default receiver import must refuse this point before writing files.
            with self.assertRaises(ValueError):
                import_capture(run, source)
            self.assertEqual(list(run.glob('browser-import-*')), [])
            result = import_capture(run, source, 'browser-input')
            self.assertNotIn('stats', result)
            self.assertEqual(result['audio']['role'], 'evidence')
            self.assertEqual(bundle.evidence_path(run, result['audio']).read_bytes(), b'abcd')


class RtpTests(unittest.TestCase):
    def window(self):
        return {'startUtc': stamp(0), 'endUtc': stamp(10), 'maxStatsGapSeconds': 2.5}

    def test_known_rate_loss_and_jitter(self):
        rows = samples()
        rows[-1]['lost'] = 2
        result = rtp.summarize(rows, self.window())
        self.assertEqual(result['coverage']['status'], 'covered')
        self.assertEqual(result['payloadKbps'], 32)
        self.assertAlmostEqual(result['packetLossPercent'], 200 / 502)
        self.assertEqual(result['jitterMs']['median'], 4)

    def test_late_capture_never_becomes_zero_speech_bitrate(self):
        rows = samples(4)
        for row in rows:
            row['timestampMs'] += 300000
            row['bytes'] = 72415
        result = rtp.summarize(rows, self.window())
        self.assertIsNone(result['payloadKbps'])
        self.assertIn('measurement-window-not-covered', result['coverage']['reasons'])

    def test_gap_reset_overlap_and_missing_markers(self):
        for change, expected in (
            (lambda r: r.pop(4) or None, None),
            (lambda r: r.__delitem__(slice(3, 8)), 'gap-in-statistics'),
            (lambda r: r[5].update(bytes=0), 'rtp-counter-reset'),
            (lambda r: r.append({**r[0], 'bytes': 1}), 'conflicting-overlapping-exports')):
            rows = samples()
            change(rows)
            result = rtp.summarize(rows, self.window())
            if expected:
                self.assertIsNone(result['payloadKbps'])
                self.assertIn(expected, result['coverage']['reasons'])
            else:
                self.assertEqual(result['payloadKbps'], 32)
        self.assertIsNone(rtp.summarize(samples(), {})['payloadKbps'])

    def test_identical_overlapping_exports_are_deduplicated(self):
        result = rtp.summarize(samples() + samples(), self.window())
        self.assertEqual(result['sampleCount'], 11)
        self.assertEqual(result['payloadKbps'], 32)

    def test_non_finite_or_wrong_year_samples_rejected(self):
        for bad in (float('nan'), 1000, START + 30_000_000_000):
            with self.assertRaises(ValueError):
                rtp.validate_sample({**samples()[0], 'timestampMs': bad})


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.run = self.root / 'run'
        self.manifest = bundle.init(self.run, 'other', 'desktop-app', 'synthetic-selftest')

    def tearDown(self):
        self.temp.cleanup()

    def test_immutable_copy_and_hash_verification(self):
        source = self.root / 'log.txt'
        source.write_text('evidence', encoding='utf-8')
        item = bundle.attach(self.run, source, 'native-log')
        source.write_text('later change', encoding='utf-8')
        copied = bundle.evidence_path(self.run, item)
        self.assertEqual(copied.read_text(), 'evidence')
        copied.write_text('tampered', encoding='utf-8')
        with self.assertRaises(ValueError):
            bundle.evidence_path(self.run, item)

    def test_settings_changes_invalidate_comparison_and_legacy_remains_unverified(self):
        result = analyze(self.run)
        self.assertEqual(result['settingsContext']['basis'], 'observed-settings')
        compare([self.run], self.root / 'initial.md')
        with bundle.edit_run(self.run) as (_, manifest):
            manifest['settingsContext']['overrides'] = {'noiseSuppression': False}
        with self.assertRaises(ValueError):
            compare([self.run], self.root / 'stale.md')
        with bundle.edit_run(self.run) as (_, manifest):
            manifest.pop('settingsContext')
        result = analyze(self.run)
        self.assertEqual(result['settingsContext']['basis'], 'unverified')
        result.pop('settingsContext')
        bundle.save(self.run / 'report.json', result)
        legacy = compare([self.run], self.root / 'legacy.md')
        self.assertIn('unverified', legacy.read_text(encoding='utf-8'))

    def test_obsolete_analysis_revision_cannot_be_compared_as_current(self):
        result = analyze(self.run)
        result['audio'].pop('analysisRevision')
        bundle.save(self.run / 'report.json', result)
        with self.assertRaisesRegex(ValueError, 'Analysis revision changed'):
            compare([self.run], self.root / 'obsolete.md')

    def test_path_traversal_rejected(self):
        with self.assertRaises(ValueError):
            bundle.evidence_path(self.run, {'id': 'bad', 'path': '../outside', 'sha256': 'x'})

    def test_persistent_sink_binds_run_and_rejects_reuse(self):
        lines = '\n'.join(json.dumps({'runId': self.manifest['runId'], 'sample': s}) for s in samples())
        artifact = ingest(self.run, 'receiver-stats', io.StringIO(lines))
        self.assertEqual(len(bundle.evidence_path(self.run, artifact).read_text().splitlines()), 11)
        with self.assertRaises(ValueError):
            ingest(self.run, 'receiver-stats', io.StringIO(json.dumps({'runId': 'stale', 'sample': samples()[0]})))

    def test_older_document_is_not_accepted_by_access_date(self):
        source = self.root / 'tech.json'
        item = {'field': 'mediaEngine', 'value': 'test-engine', 'scope': 'sender', 'locator': 'section 1',
                'source': {'kind': 'official-document', 'date': '2025-01-01', 'accessDate': '2026-09-08', 'url': 'https://example.invalid'}}
        source.write_text(json.dumps({'observations': [item]}))
        artifact = bundle.attach(self.run, source, 'technology')
        result = bundle.technology(self.run, [artifact])
        self.assertFalse(result['observations'])
        self.assertEqual(len(result['rejected']), 1)

    def test_end_before_start_is_rejected(self):
        with self.assertRaises(ValueError):
            bundle.mark(self.run, 'measure-end', stamp(10))
        bundle.mark(self.run, 'measure-start', stamp(10))
        with self.assertRaises(ValueError):
            bundle.mark(self.run, 'measure-end', stamp(5))

    def test_concurrent_capture_and_marker_writers_keep_all_events(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda i: bundle.mark(self.run, f'event-{i}', stamp(i)), range(4)))
        self.assertEqual(len(bundle.load(self.run)[1]['events']), 4)

    def test_runtime_claim_requires_linked_evidence(self):
        source = self.root / 'claim.json'
        source.write_text(json.dumps({'observations': [{'field': 'audioWorklet', 'scope': 'sender',
            'value': True, 'locator': 'runtime trace', 'source': {'kind': 'runtime', 'date': '2026-09-08'}}]}))
        artifact = bundle.attach(self.run, source, 'technology')
        self.assertEqual(len(bundle.technology(self.run, [artifact])['rejected']), 1)

    def test_known_pcm_gain_and_file_offset(self):
        rate = 16000
        rng = np.random.default_rng(42)
        x = rng.normal(0, .04, (rate * 4, 1)).astype(np.float32)
        y = np.concatenate((np.zeros((rate // 4, 1)), x * .5, np.zeros((rate // 4, 1)))).astype(np.float32)
        self.assertAlmostEqual(audio.estimate_alignment(x, rate, y, rate)['offsetSeconds'], .25, places=3)
        self.assertAlmostEqual(audio.level(x * .5) - audio.level(x), -6.0206, places=3)
        speech, received = self.root / 'reference.wav', self.root / 'received.wav'
        wavfile.write(speech, rate, x)
        wavfile.write(received, rate, y)
        recipe = self.root / 'recipe.json'
        bundle.save(recipe, {'schemaVersion': 1, 'referenceSha256': bundle.digest(speech),
                            'segments': [{'name': 'noise', 'kind': 'broadband', 'startSeconds': .5, 'endSeconds': 3.5}]})
        for path, role in ((speech, 'reference-audio'), (speech, 'source-audio'), (received, 'receiver-audio'), (recipe, 'recipe')):
            bundle.attach(self.run, path, role)
        result = analyze(self.run)
        self.assertFalse(result['coverage']['receiverRtp'])
        self.assertTrue(result['coverage']['referenceSegments'])
        self.assertAlmostEqual(result['audio']['segments'][0]['gainDb'], -6.0206, places=2)
        json.loads((self.run / 'report.json').read_text(encoding='utf-8'), parse_constant=lambda value: self.fail('Non-finite JSON: ' + value))

    def test_partial_audio_report_keeps_unverified_sections_empty(self):
        from test_alignment import repeated_fixture
        ref, rx, sections, _ = repeated_fixture()
        sections.append(dict(name='noise-tail', kind='noise', startSeconds=28, endSeconds=32))
        source = self.root / 'reference.wav'
        received = self.root / 'receiver.wav'
        wavfile.write(source, 8000, ref.astype(np.float32))
        wavfile.write(received, 8000, rx.astype(np.float32))
        recipe = self.root / 'recipe.json'
        bundle.save(recipe, {'referenceSha256': bundle.digest(source), 'segments': sections})
        for path, role in ((source, 'reference-audio'), (source, 'source-audio'), (received, 'receiver-audio'), (recipe, 'recipe')):
            bundle.attach(self.run, path, role)
        result = analyze(self.run)
        self.assertEqual(result['audio']['alignment']['receiver-audio']['status'], 'partial')
        self.assertEqual([s['status'] for s in result['audio']['segments']], ['measured'] * 3 + ['incomplete'])
        self.assertFalse(result['coverage']['referenceSegments'])
        self.assertIsNone(result['audio']['segments'][-1]['gainDb'])
        self.assertIn('no-independent-section-alignment', (self.run / 'report.md').read_text(encoding='utf-8'))

    def test_recipe_hash_mismatch_and_bad_schema_produce_no_segment_measurements(self):
        source = self.root / 'reference.wav'
        wavfile.write(source, 8000, np.random.default_rng(9).normal(0, .03, (16000, 1)).astype(np.float32))
        for i, recipe_data in enumerate(({'referenceSha256': 'wrong', 'segments': []},
                                         {'referenceSha256': bundle.digest(source), 'segments': [None]})):
            run = self.root / f'bad-recipe-{i}'
            bundle.init(run, 'other', 'desktop-app', 'synthetic-selftest')
            recipe = self.root / f'recipe-{i}.json'
            bundle.save(recipe, recipe_data)
            for path, role in ((source, 'reference-audio'), (source, 'receiver-audio'), (recipe, 'recipe')):
                bundle.attach(run, path, role)
            result = analyze(run)
            self.assertEqual(result['audio']['status'], 'incomplete')
            self.assertFalse(result['audio']['segments'])
            self.assertEqual(result['audio']['errors'][0]['role'], 'recipe')

    def test_alignment_handles_receiver_started_before_reference(self):
        source = np.random.default_rng(8).normal(0, .03, (4 * 8000, 1))
        received = np.pad(source * .5, ((32 * 8000, 8000), (0, 0)))
        result = audio.estimate_alignment(source, 8000, received, 8000)
        self.assertEqual(result['status'], 'aligned')
        self.assertAlmostEqual(result['offsetSeconds'], 32, places=3)
        self.assertGreater(result['similarity'], .99)

    def test_silent_or_unrelated_audio_is_not_aligned(self):
        rng = np.random.default_rng(12)
        x, y = rng.normal(size=(32000, 1)), rng.normal(size=(32000, 1))
        self.assertEqual(audio.estimate_alignment(x, 16000, y, 16000)['status'], 'unavailable')
        self.assertEqual(audio.estimate_alignment(x, 16000, np.zeros_like(y), 16000)['status'], 'unavailable')


if __name__ == '__main__':
    unittest.main()
