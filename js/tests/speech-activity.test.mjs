import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSpeechDetector, loadSpeechDetector } from '../modules/utils/speechActivity.js';
import { measureGuidedNoise } from '../modules/utils/guidedNoise.js';
import { analyzePcm } from '../modules/utils/pcmAnalysis.js';
import { analyze } from '../workers/spectral-analysis-worker.js';
import { usableReport, countsAsCompletedTest } from '../modules/MeasurementValidity.js';
import { projectReviewReport } from '../modules/ReviewEvidence.js';
import evaluator from '../modules/ReportEvaluator.js';
import { evaluatePremiumReport } from '../../server/premium-report-evaluator.js';
import { speechFixture, guidedSegments, processing } from './speech-fixture.mjs';

const binary = readFileSync(new URL('../lib/fvad/libfvad.wasm', import.meta.url));
const detector = await createSpeechDetector(binary);
const measure = (pcm, rate = 16000, segments = guidedSegments()) => measureGuidedNoise([pcm], rate, segments, detector([pcm], rate));
const report = pcm => ({ run: { id: 'vad-test', type: 'record' }, profile: { appliedConstraints: processing },
  recording: { guidedSegments: guidedSegments(), durationMs: 10000, stopReason: 'guided-complete' },
  audioMetrics: analyzePcm([pcm], 16000, { guidedSegments: guidedSegments(), speechActivity: detector([pcm], 16000) }) });
const disturb = (pcm, start, length, rate = 16000) => {
  for (let i = Math.round(start * rate); i < Math.round((start + length) * rate); i++) pcm[i] += 0.15 * Math.sin(i * 2 * Math.PI * 700 / rate);
  return pcm;
};

test('actual WebRTC WASM finds generated speech across capture rates, phases and silent channels', () => {
  for (const rate of [8000, 16000, 24000, 32000, 44100, 48000, 96000]) {
    const pcm = speechFixture(rate);
    for (const channels of [[pcm], [pcm, Float32Array.from(pcm, x => -x)], [new Float32Array(pcm.length), pcm]]) {
      const result = measureGuidedNoise(channels, rate, guidedSegments(), detector(channels, rate));
      assert.equal(result.speechActivity.detection, 'detected', `${rate} / ${channels.length}`);
      assert.ok(result.speechActivity.detectedSpeechMs > 3000);
      assert.equal(result.speechActivity.quietSpeechMs, 0);
      assert.equal(result.snr.status, 'measured');
    }
  }
});

test('a 300ms disturbance recovers the same file without hiding whole-section energy', () => {
  const original = speechFixture(), pcm = disturb(original.slice(), 0.5, 0.3);
  assert.equal(measureGuidedNoise([pcm], 16000, guidedSegments()).snr.status, 'unavailable');
  const recovered = measure(pcm), baseline = measure(original);
  assert.equal(recovered.snr.status, 'measured');
  assert.ok(recovered.guidedNoise.excludedQuietMs > 0 && recovered.guidedNoise.excludedQuietMs <= 500);
  assert.ok(recovered.guidedNoise.quiet.endMs - recovered.guidedNoise.quiet.startMs >= 1500);
  assert.ok(Math.abs(recovered.noiseFloor.estimatedDb - baseline.noiseFloor.estimatedDb) < 0.1);
  assert.ok(recovered.guidedNoise.quietTotalDb > recovered.noiseFloor.estimatedDb + 20);
  assert.equal(recovered.guidedNoise.quietVariable, true);
  const r = report(pcm), free = evaluator.evaluateFree(r);
  assert.ok(free.findings.some(f => f.id === 'QUIET_VARIATION'));
  assert.match(free.scope, /excluded.*remains in your recording/);
  assert.doesNotMatch(free.nextStep, /record again|new recording/i);
  assert.equal(usableReport(projectReviewReport(r)).report.audioMetrics.noiseFloor.status, 'measured');
  const detail = evaluatePremiumReport(projectReviewReport(r));
  assert.match(JSON.stringify(detail), /Whole Quiet-section Level/);
});

test('repeated, prolonged and middle interruptions cannot cherry-pick a too-short clean remainder', () => {
  for (const events of [[[0.5, 0.7]], [[0.5, 0.2], [2.2, 0.2]], [[1.3, 0.3]]]) {
    const pcm = speechFixture(); events.forEach(([start, length]) => disturb(pcm, start, length));
    const result = measure(pcm);
    assert.equal(result.noiseFloor.status, 'unavailable');
    assert.equal(result.snr.status, 'unavailable');
    assert.equal(result.guidedNoise.excludedQuietMs, 0);
  }
});

test('quiet speech contamination and continuous changing noise cannot become a quiet measurement', () => {
  const talking = speechFixture(16000, { voiceStart: 0 });
  assert.equal(measure(talking).noiseFloor.status, 'unavailable');
  const pcm = speechFixture();
  for (let i = 8000; i < 40000; i++) pcm[i] *= 1 + 15 * (i - 8000) / 32000;
  assert.equal(measure(pcm).noiseFloor.status, 'unavailable');
});

test('late and quiet speech survive; a short click or noise alone does not prove enough speech', () => {
  assert.equal(measure(speechFixture(16000, { voiceStart: 6 })).speechActivity.detection, 'detected');
  assert.equal(measure(speechFixture(16000, { voiceGain: 0.03, noiseGain: 0.00005 })).speechActivity.detection, 'detected');
  for (const pcm of [speechFixture(16000, { voiceGain: 0 }), disturb(speechFixture(16000, { voiceGain: 0 }), 5, 0.03)]) {
    const result = measure(pcm);
    assert.equal(result.speechActivity.detection, 'uncertain');
    assert.equal(result.noiseFloor.status, 'measured');
    assert.equal(result.snr.status, 'unavailable');
    const r = report(pcm), checked = usableReport(projectReviewReport(r));
    assert.equal(checked.valid, true);
    assert.equal(checked.report.audioMetrics.noiseFloor.status, 'measured');
    assert.equal(countsAsCompletedTest(r), true, 'optional VAD uncertainty is not a quota decision');
    const free = evaluator.evaluateFree(r);
    assert.ok(free.findings.some(f => f.id === 'SPEECH_UNCERTAIN'));
  }
});

test('digital zero, processing and saturation retain independent measurements without infinite SNR', () => {
  const zeroQuiet = speechFixture(); zeroQuiet.fill(0, 0, 48000);
  const result = measure(zeroQuiet);
  assert.equal(result.speechActivity.detection, 'detected');
  assert.equal(result.noiseFloor.reason, 'quiet-below-resolution');
  assert.equal(result.guidedNoise.quietSpreadDb, 0);
  assert.equal(result.snr.estimatedDb, null);
  for (const setting of ['autoGainControl', 'echoCancellation', 'noiseSuppression']) {
    const value = measure(speechFixture(), 16000, { ...guidedSegments(), processing: { ...processing, [setting]: true } });
    assert.equal(value.noiseFloor.status, 'measured');
    assert.equal(value.snr.reason, 'processing-limits-snr-estimate');
  }
  const clipped = speechFixture(); clipped[80000] = 1;
  assert.equal(measure(clipped).snr.reason, 'speaking-segment-clipped');
});

test('worker detection failures preserve PCM checks, timing and legacy guided estimates', () => {
  const msg = { channels: [speechFixture().buffer], sampleRate: 16000, fftSize: 1024, hopSize: 512,
    guidedSegments: guidedSegments(), outputBins: 24 };
  const failed = analyze(msg, () => {}, () => { throw new Error('wasm failed'); });
  assert.equal(failed.audioMetrics.status, 'measured');
  assert.equal(failed.audioMetrics.speechActivity.status, 'unavailable');
  assert.equal(failed.audioMetrics.snr.status, 'measured');
  const detected = analyze(msg, () => {}, detector);
  assert.equal(detected.audioMetrics.signal.peakDb, failed.audioMetrics.signal.peakDb);
  assert.equal(detected.audioMetrics.durationMs, 10000);
  assert.equal(detected.audioMetrics.speechActivity.detection, 'detected');
  const hidden = measure(speechFixture(), 16000, { ...guidedSegments(), interrupted: true });
  assert.equal(hidden.snr.status, 'unavailable');
  assert.equal(hidden.noiseFloor.status, 'unavailable');
});

test('a gated quiet block is not labelled speech, and recovery never edits PCM or hides saturation', () => {
  const gated = speechFixture(); gated.fill(0, 8000, 9600);
  assert.equal(measure(gated).noiseFloor.reason, 'quiet-segment-not-steady');
  const pcm = speechFixture(); pcm[9000] = 1;
  const before = pcm.slice(), r = report(pcm);
  assert.deepEqual(pcm, before);
  assert.equal(r.audioMetrics.clipping.saturatedSamples, 1);
  assert.equal(r.audioMetrics.signal.peakDb, 0);
  assert.equal(r.audioMetrics.speechActivity.detection, 'detected');
  const projected = projectReviewReport(r);
  assert.equal(projected.audioMetrics.speechActivity.detection, 'detected');
  assert.equal(Object.hasOwn(projected.audioMetrics.speechActivity, 'frames'), false);
  const invalid = measureGuidedNoise([before], 16000, guidedSegments(),
    { status: 'measured', frameMs: 20, frames: new Uint8Array(10) });
  assert.equal(invalid.speechActivity.status, 'unavailable');
});

test('optional loader handles unavailable or invalid assets without network retries', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return { ok: false }; });
  assert.equal(await loadSpeechDetector(), null);
  assert.equal(requests, 1);
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  assert.equal(await loadSpeechDetector(), null);
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => binary });
  assert.equal(typeof await loadSpeechDetector(), 'function');
});
