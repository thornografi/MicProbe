import test from 'node:test';
import assert from 'node:assert/strict';
import CaptureGuide from '../modules/CaptureGuide.js';
import eventBus from '../modules/EventBus.js';
import { CAPTURE_GUIDE as GUIDE, EVENTS, TEST } from '../modules/constants.js';
import { measureGuidedNoise } from '../modules/utils/guidedNoise.js';
import { analyzePcm } from '../modules/utils/pcmAnalysis.js';
import { analyze } from '../workers/spectral-analysis-worker.js';
import { comparisonSummary } from '../ui/AccountPanelUI.js';
import { createRunSnapshot } from '../modules/RunSnapshot.js';
import reportEvaluator from '../modules/ReportEvaluator.js';

const processing = { autoGainControl: false, noiseSuppression: false, echoCancellation: false };
const segments = () => ({ version: 1, method: 'user-guided-file-segments', durationMs: 10000,
  quiet: { startMs: 500, endMs: 2500 }, speaking: { startMs: 3500, endMs: 9500 }, processing });
// Integer-period tones give an independent exact-power reference, not a speech-quality fixture.
const samples = (rate = 16000) => Float32Array.from({ length: rate * 10 }, (_, i) =>
  0.01 * Math.sin(2 * Math.PI * 100 * i / rate) + (i >= 3 * rate ? 0.1 * Math.sin(2 * Math.PI * 500 * i / rate) : 0));

test('guided SNR subtracts noise power and preserves channel power across sample rates', () => {
  for (const rate of [16000, 24000, 44100, 48000]) {
    const pcm = samples(rate);
    for (const channels of [[pcm], [pcm, pcm], [pcm, Float32Array.from(pcm, x => -x)]]) {
      const result = measureGuidedNoise(channels, rate, segments());
      assert.equal(result.noiseFloor.status, 'measured');
      assert.ok(Math.abs(result.noiseFloor.estimatedDb + 43.01) < 0.02);
      assert.ok(Math.abs(result.snr.estimatedDb - 20) < 0.02);
      assert.ok(Math.abs(result.guidedNoise.contrastDb - 20.04) < 0.02);
    }
  }
});

test('free speaking stays unmeasured; guided segments survive the real PCM and worker entry points', () => {
  const pcm = samples();
  assert.equal(analyzePcm([pcm], 16000).snr.status, 'unavailable');
  const result = analyze({ channels: [pcm.buffer], sampleRate: 16000, fftSize: 1024, hopSize: 512,
    outputBins: 24, progressInterval: 8, guidedSegments: segments(), bands: { subBass: [20, 60], lowMid: [250, 500], highMid: [2000, 4000], presence: [4000, 6000] } });
  assert.equal(result.audioMetrics.snr.estimatedDb, 20);
});

test('active or unknown processing allows output-level contrast but cannot produce an SNR estimate', () => {
  for (const settings of [{}, ...Object.keys(processing).map(key => ({ ...processing, [key]: true }))]) {
    const result = measureGuidedNoise([samples()], 16000, { ...segments(), processing: settings });
    assert.equal(result.guidedNoise.status, 'measured');
    assert.equal(result.snr.estimatedDb, null);
    assert.equal(result.snr.reason, 'processing-limits-snr-estimate');
  }
});

test('invalid, early, overlapping, interrupted and out-of-file segments fail closed', () => {
  for (const change of [{ version: 2 }, { interrupted: true }, { quiet: null }, { speaking: null },
    { quiet: { startMs: -1, endMs: 2500 } }, { speaking: { startMs: 3500, endMs: 4500 } },
    { speaking: { startMs: 2000, endMs: 9500 } }, { speaking: { startMs: 3500, endMs: 11000 } },
    { quiet: { startMs: NaN, endMs: 2500 } }]) {
    const result = measureGuidedNoise([samples()], 16000, { ...segments(), ...change });
    assert.equal(result.snr.status, 'unavailable');
    assert.equal(result.noiseFloor.estimatedDb, null);
  }
});

test('silence, unchanged input and a contaminated quiet segment do not become valid guided measurements', () => {
  const silence = new Float32Array(160000);
  const unchanged = Float32Array.from(silence, (_, i) => 0.01 * Math.sin(2 * Math.PI * 100 * i / 16000));
  const contaminated = samples();
  for (let i = 8000; i < 20000; i++) contaminated[i] *= 10;
  for (const pcm of [silence, unchanged, contaminated]) {
    assert.equal(measureGuidedNoise([pcm], 16000, segments()).guidedNoise.status, 'unavailable');
  }
});

test('full-scale speaking permits recorded levels but rejects SNR', () => {
  const pcm = samples(); pcm[70000] = 1;
  const result = measureGuidedNoise([pcm], 16000, segments());
  assert.equal(result.noiseFloor.status, 'measured');
  assert.equal(result.snr.reason, 'speaking-segment-clipped');
});

test('preparation resolves on cancel and leaves no level subscription or late cue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const guide = new CaptureGuide({ runId: 'cancel', captureGuide: { enabled: true, noiseCheck: true } });
  const states = [], unsubscribe = eventBus.on(EVENTS.CAPTURE_GUIDE_CHANGED, state => states.push(state.stage));
  t.after(unsubscribe);
  const pending = guide.prepare({ getAudioTracks: () => [{ label: 'Test mic', getSettings: () => processing }] });
  guide.cancel();
  assert.equal(await pending, false);
  t.mock.timers.tick(GUIDE.PREPARE_MS + 100);
  eventBus.emit(EVENTS.VUMETER_LEVEL, { rawDb: '-20' });
  assert.deepEqual(states, ['prepare', 'cancelled']);
});

test('preparation ignores missing levels and resolves when the microphone ends', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const guide = new CaptureGuide({ runId: 'ended', captureGuide: { enabled: true } });
  const track = new EventTarget(), states = [];
  const unsubscribe = eventBus.on(EVENTS.CAPTURE_GUIDE_CHANGED, state => states.push(state.stage));
  t.after(unsubscribe);
  const pending = guide.prepare({ getAudioTracks: () => [track] });
  for (const rawDb of [null, undefined, '', '-Infinity']) eventBus.emit(EVENTS.VUMETER_LEVEL, { rawDb });
  assert.deepEqual(states, ['prepare']);
  track.dispatchEvent(new Event('ended'));
  assert.equal(await pending, false);
  t.mock.timers.tick(GUIDE.PREPARE_MS + 100);
  track.dispatchEvent(new Event('ended'));
  assert.deepEqual(states, ['prepare', 'cancelled']);
});

test('missing preparation input remains attached to the recording cues', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const guide = new CaptureGuide({ runId: 'silent-input', captureGuide: { enabled: true, noiseCheck: true } });
  const states = [], unsubscribe = eventBus.on(EVENTS.CAPTURE_GUIDE_CHANGED, state => states.push(state));
  t.after(() => { guide.cancel(); unsubscribe(); });
  const pending = guide.prepare({ getAudioTracks: () => [] });
  t.mock.timers.tick(GUIDE.PREPARE_MS);
  assert.equal(await pending, true, 'No observed level is a readiness hint, not a device failure');
  guide.start(performance.now(), () => {});
  assert.equal(states.at(-1).stage, 'quiet');
  assert.equal(states.at(-1).inputDetected, false);
  t.mock.timers.tick(GUIDE.QUIET_MS);
  assert.equal(states.at(-1).stage, 'speak');
  assert.equal(states.at(-1).inputDetected, false);
});

test('guided cue times use actual elapsed capture time and automatic completion is cancelled by early stop', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0, completed = 0;
  t.mock.method(performance, 'now', () => now);
  const guide = new CaptureGuide({ runId: 'timing', captureGuide: { enabled: true, noiseCheck: true } });
  guide.start(0, () => completed++);
  now = 3600; t.mock.timers.tick(GUIDE.QUIET_MS);
  const result = guide.finish(5600);
  assert.equal(result.quiet.endMs, 3100);
  assert.equal(result.speaking.startMs, 4100);
  assert.equal(result.speaking.endMs, 5100);
  now = 20000; t.mock.timers.tick(TEST.DURATION_MS);
  assert.equal(completed, 0);
});

test('capture options are frozen with the pre-permission snapshot', () => {
  const choice = { enabled: true, noiseCheck: true };
  const snapshot = createRunSnapshot({ captureGuide: choice });
  choice.noiseCheck = false;
  assert.equal(snapshot.captureGuide.noiseCheck, true);
});

const report = (rms, mic = 'Mic A') => ({ run: { type: 'test' },
  profile: { id: 'discord', bitrate: 64000, appliedConstraints: { noiseSuppression: true } },
  recording: { guidedSegments: null }, device: { micName: mic }, audioMetrics: { status: 'measured',
    signal: { rmsDb: rms, peakDb: -5 }, clipping: { status: 'measured', rate: 0.01 }, coverage: { truncated: false } } });

test('comparison reports signed deltas, applied changes and context without declaring improvement', () => {
  const before = report(-30), after = report(-20, 'Mic B');
  after.profile.id = 'meeting-call'; after.profile.appliedConstraints.noiseSuppression = false;
  after.audioMetrics.clipping.rate = 0.02;
  const result = comparisonSummary(before, after, { detailed: true });
  assert.ok(result.context.some(line => line.includes('Different scenarios')));
  assert.ok(result.context.some(line => line.includes('Mic A → Mic B')));
  assert.ok(result.settings.some(line => line.includes('Noise suppression (applied): On → Off')));
  assert.ok(result.measurements.includes('RMS level: increased by 10 dB.'));
  assert.ok(result.measurements.includes('Clipped samples: increased by 1 percentage point.'));
  assert.doesNotMatch(JSON.stringify(result), /improv|better/);
  assert.deepEqual(comparisonSummary(before, after).measurements, []);
  assert.deepEqual(comparisonSummary(before, after).settings, []);
  before.audioMetrics.signal.rmsDb = null;
  assert.ok(!comparisonSummary(before, after, { detailed: true }).measurements.some(line => line.startsWith('RMS level')));
});

test('report scope explains guided limitations without inventing speech identification', () => {
  const audioMetrics = analyzePcm([samples()], 16000, { guidedSegments: { ...segments(), processing: {} } });
  const result = reportEvaluator.evaluateFree({ ...report(-20), audioMetrics });
  assert.match(result.scope, /processing prevents an SNR estimate/);
  assert.equal(result.overall.stars, null);
  assert.equal(result.assessment.speech, 'not-measured');
});
