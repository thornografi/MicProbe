// Regressions for the 2026-09-05 physical-microphone findings: a clipped waveform whose
// level was reduced after the converter, one brief loud moment in a quiet recording,
// identical stereo channels, ignored capture settings, inter-sample peaks and the
// system facts a browser cannot read. Signals are synthetic; the thresholds were set
// from real Scarlett Solo recordings (see AUDIO_VALIDATION.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { analyzePcm, measureTruePeak } from '../modules/utils/pcmAnalysis.js';
import evaluator from '../modules/ReportEvaluator.js';
import builder from '../modules/DiagnosticReportBuilder.js';
import { createRunSnapshot, completeRunSnapshot } from '../modules/RunSnapshot.js';
import { QUALITY } from '../modules/constants.js';

const require = createRequire(import.meta.url);
const { evaluatePremiumReport } = require('../../server/premium-report-evaluator.js');
const { getTroubleshootingGuidance } = require('../../server/troubleshooting-guidance.js');

globalThis.window = globalThis.window || {};
const sampleRate = 48000;
const near = (actual, expected, tolerance) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
  `${actual} differs from ${expected} by > ${tolerance}`);
const sine = (seconds, amplitude, frequency = 1000, phase = 0) => Float32Array.from({ length: Math.round(seconds * sampleRate) },
  (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate + phase));
// Deterministic speech-like signal: several harmonics with a slow amplitude envelope, no pure-tone flat peaks.
const speechLike = (seconds, amplitude, seed = 1) => Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, i) => {
  const t = i / sampleRate;
  const envelope = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3.1 * t + seed);
  return amplitude * envelope * (0.5 * Math.sin(2 * Math.PI * 160 * t) + 0.3 * Math.sin(2 * Math.PI * 335 * t + 1)
    + 0.15 * Math.sin(2 * Math.PI * 1210 * t + 2) + 0.05 * Math.sin(2 * Math.PI * 2470 * t + 3));
});
const report = (metrics, profile = {}) => ({ run: { id: 'run-1', type: 'record' }, audioMetrics: metrics,
  profile: { id: 'raw', appliedConstraints: {}, requestedConstraints: {}, constraintMismatches: [], ...profile },
  troubleshooting: { version: 1, osSource: 'browser-hint', os: 'windows', app: 'unknown', client: 'unknown', symptom: 'unknown',
    scope: 'unknown', trigger: 'unknown', usage: 'recording' } });
const ids = findings => findings.map(f => f.id);
// Windowed-sinc resampler (band-limited), enough to reproduce the ringing that a real SRC or codec leaves on a plateau.
const resample = (pcm, ratio) => {
  const out = new Float32Array(Math.floor(pcm.length * ratio)), taps = 32, cutoff = Math.min(1, ratio);
  for (let i = 0; i < out.length; i++) {
    const center = i / ratio; let acc = 0;
    for (let j = Math.floor(center) - taps; j <= Math.floor(center) + taps; j++) {
      if (j < 0 || j >= pcm.length) continue;
      const x = (j - center) * cutoff, sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const window = 0.5 + 0.5 * Math.cos(Math.PI * (j - center) / (taps + 1));
      acc += pcm[j] * sinc * window * cutoff;
    }
    out[i] = acc;
  }
  return out;
};

test('a waveform pinned flat below full scale is reported as clipping before capture, tones and speech are not', () => {
  // Analog clipping at the converter, then a system input level of 62.7 % and a mono fold: ceiling ~ -10 dBFS.
  const clipped = speechLike(6, 3).map(v => Math.max(-0.3162, Math.min(0.3162, v)));
  const m = analyzePcm([clipped], sampleRate);
  assert.equal(m.clipping.saturatedSamples, 0, 'no sample reaches full scale');
  assert.ok(m.signal.crestFactorDb <= QUALITY.FLAT_TOP_CREST_DB);
  assert.ok(m.ceiling.flatTopRate >= QUALITY.FLAT_TOP_RATE_CRITICAL && m.ceiling.nearCeilingRate >= QUALITY.FLAT_TOP_NEAR_RATE_CRITICAL);
  const free = evaluator.evaluateFree(report(m));
  const pinned = free.findings.find(f => f.id === 'PINNED_CEILING');
  assert.equal(pinned?.severity, 'critical');
  assert.equal(free.overall.score, 'critical');
  assert.match(pinned.message, /before the browser received the audio/);
  const premium = evaluatePremiumReport(report(m));
  const guide = premium.recommendations.find(r => r.id === 'GUIDE_WINDOWS_RECORDED_INPUT');
  assert.equal(guide?.replaces, 'PINNED_CEILING', 'the OS step replaces the pinned-ceiling recommendation');
  assert.match(guide.steps[1], /do not raise it/);
  assert.ok(!premium.recommendations.some(r => r.id === 'PINNED_CEILING'));
  assert.equal(premium.metrics.find(item => item.key === 'nearCeiling').rating, 'poor');
  // The signature must survive resampling and ringing: overshoot spikes move the maximum,
  // ripple removes exact plateaus, but the percentile ceiling and its dwell stay.
  const resampled = analyzePcm([resample(resample(clipped, 44100 / 48000), 48000 / 44100)], sampleRate);
  assert.ok(resampled.ceiling.nearCeilingRate >= QUALITY.FLAT_TOP_NEAR_RATE_CRITICAL, 'dwell at the percentile ceiling survives resampling');
  assert.equal(evaluator.evaluateFree(report(resampled)).findings.find(f => f.id === 'PINNED_CEILING')?.severity, 'critical');
  const rippled = analyzePcm([clipped.map((v, i) => v + 0.004 * Math.sin(i * 1.9))], sampleRate);
  assert.ok(rippled.ceiling.flatTopRate < 0.1 && rippled.ceiling.flatTopRate < m.ceiling.flatTopRate / 5, 'ripple removes most exact plateaus');
  assert.equal(evaluator.evaluateFree(report(rippled)).findings.find(f => f.id === 'PINNED_CEILING')?.severity, 'critical');
  // Pure tones (crest 3 dB, arc-shaped peaks) and clean speech-like audio stay clear.
  for (const pcm of [sine(3, 0.3), sine(3, 0.3, 50), speechLike(6, 0.4)]) {
    const clean = evaluator.evaluateFree(report(analyzePcm([pcm], sampleRate)));
    assert.ok(!clean.findings.some(f => f.id === 'PINNED_CEILING'), ids(clean.findings).join(','));
  }
});

test('one brief loud moment no longer hides a recording that is quiet almost everywhere', () => {
  // Whisper-level speech (about -48 LUFS) with one 150 ms sound roughly 12 dB louder over a
  // 400 ms block (a breath, a knob, a chair). Much louder bursts become the gated program by
  // design; the real recordings R2/R4 sat in this range.
  const quiet = speechLike(8, 10 ** (-36 / 20));
  quiet.set(sine(0.15, 10 ** (-32 / 20), 300), sampleRate * 3);
  const m = analyzePcm([quiet], sampleRate);
  assert.ok(m.signal.maxBlockRmsDb > QUALITY.WEAK_SIGNAL_DB, 'the loudest 10 ms window alone would clear the recording');
  const weak = evaluator.evaluateFree(report(m)).findings.find(f => f.id === 'WEAK_SIGNAL');
  assert.equal(weak?.basis, 'integrated-loudness');
  assert.equal(weak.severity, 'warning');
  // Premium hands the level finding to the OS guidance step (replaces) when a browser OS hint exists.
  const premiumLevel = (r, severity) => evaluatePremiumReport(r).recommendations.some(item => item.id === 'LOW_RECORDED_LEVEL'
    ? item.severity === severity : item.replaces === 'LOW_RECORDED_LEVEL');
  assert.ok(premiumLevel(report(m), 'warning'));
  const bare = { ...report(m), troubleshooting: undefined };
  assert.ok(evaluatePremiumReport(bare).recommendations.some(r => r.id === 'LOW_RECORDED_LEVEL' && r.severity === 'warning'));
  const silent = speechLike(8, 10 ** (-48 / 20));
  silent.set(sine(0.15, 10 ** (-40 / 20), 300), sampleRate * 2);
  const s = analyzePcm([silent], sampleRate);
  assert.ok(s.signal.maxBlockRmsDb > QUALITY.WEAK_SIGNAL_DB, 'the loudest 10 ms window alone would clear the recording');
  const silence = evaluator.evaluateFree(report(s)).findings.find(f => f.id === 'SILENCE');
  assert.equal(silence?.basis, 'integrated-loudness');
  assert.ok(premiumLevel(report(s), 'critical'));
  assert.ok(evaluatePremiumReport({ ...report(s), troubleshooting: undefined }).recommendations
    .some(r => r.id === 'LOW_RECORDED_LEVEL' && r.severity === 'critical'));
  // Normal speech with pauses keeps no level warning.
  const paused = new Float32Array(sampleRate * 10);
  paused.set(speechLike(4, 0.2), sampleRate * 3);
  assert.ok(!evaluator.evaluateFree(report(analyzePcm([paused], sampleRate))).findings.some(f => ['WEAK_SIGNAL', 'SILENCE'].includes(f.id)));
});

test('identical channels are reported as dual-mono and level rules use the mono equivalent', () => {
  const voice = speechLike(5, 0.02);
  const m = analyzePcm([voice, voice], sampleRate);
  assert.equal(m.channelLayout, 'dual-mono');
  assert.equal(m.channelIdentity.identical, true);
  near(m.lufs.integrated - m.lufs.integratedMonoEquivalent, 3.01, 0.001);
  near(m.lufs.integratedMonoEquivalent, analyzePcm([voice], sampleRate).lufs.integrated, 0.01);
  const free = evaluator.evaluateFree(report(m));
  assert.ok(free.findings.some(f => f.id === 'DUAL_MONO' && f.severity === 'info'));
  assert.equal(free.findings.find(f => f.id === 'WEAK_SIGNAL')?.value, m.lufs.integratedMonoEquivalent);
  const stereo = analyzePcm([voice, speechLike(5, 0.02, 7)], sampleRate);
  assert.equal(stereo.channelLayout, 'stereo');
  assert.equal(stereo.lufs.integratedMonoEquivalent, null);
  assert.ok(!evaluator.evaluateFree(report(stereo)).findings.some(f => f.id === 'DUAL_MONO'));
  assert.equal(evaluatePremiumReport(report(m)).metrics.find(item => item.key === 'channelLayout').value, 'dual-mono');
});

test('true peak follows BS.1770-4 over-sampling and flags inter-sample peaks above full scale', () => {
  const between = sine(2, 1, 12000, Math.PI / 4);     // samples at +/-0.707, the waveform peaks at 1.0 between them
  const m = analyzePcm([between], sampleRate);
  near(m.signal.peakDb, -3.01, 0.01);
  near(m.truePeak.db, 0, 0.15);
  assert.equal(m.truePeak.oversampling, 4);
  const hot = sine(2, 1.06, 12000, Math.PI / 4).map(v => Math.max(-0.99, Math.min(0.99, v)));
  const h = analyzePcm([hot], sampleRate);
  assert.equal(h.clipping.saturatedSamples, 0);
  assert.ok(h.truePeak.db > QUALITY.TRUE_PEAK_WARNING_DBTP);
  assert.ok(evaluator.evaluateFree(report(h)).findings.some(f => f.id === 'TRUE_PEAK_OVER' && f.severity === 'warning'));
  assert.ok(evaluatePremiumReport(report(h)).recommendations.some(r => r.id === 'TRUE_PEAK_OVER'));
  assert.equal(measureTruePeak([new Float32Array(1000)], 48000, 0).db, -180);
  assert.equal(measureTruePeak([between], 192000, 1).method, 'sample-peak');
});

test('ignored capture settings and active gain control surface as observations with system facts marked unavailable', () => {
  const run = completeRunSnapshot(createRunSnapshot({
    profile: { id: 'raw', label: 'Raw Recording', category: 'record' },
    requestedSettings: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, sampleRate: 44100, channelCount: 1 }
  }), { getAudioTracks: () => [{ label: 'Analogue 1 + 2 (Focusrite USB Audio)', getSettings: () => ({ echoCancellation: false,
    noiseSuppression: false, autoGainControl: true, sampleRate: 48000, channelCount: 2 }), getCapabilities: () => ({ sampleRate: { min: 48000, max: 48000 } }) }] });
  builder.init({ deepAnalysisEngine: { cancel() {}, analyze: async () => ({ status: 'ready' }) } });
  builder._beginRun('record', { runSnapshot: run });
  try {
    const built = builder.build();
    assert.deepEqual(built.profile.constraintMismatches, [
      { key: 'sampleRate', requested: 44100, applied: 48000 }, { key: 'channelCount', requested: 1, applied: 2 }]);
    assert.equal(built.captureContext.osInputLevel.status, 'unavailable');
    assert.equal(built.captureContext.osProcessing.status, 'unavailable');
    assert.equal(built.captureContext.browserInputVolumeAdjustment.status, 'possible');
    assert.equal(built.captureContext.deviceLabel, 'Analogue 1 + 2 (Focusrite USB Audio)');
    const m = analyzePcm([speechLike(4, 0.2)], sampleRate);
    const free = evaluator.evaluateFree({ ...built, audioMetrics: m });
    const applied = free.findings.find(f => f.id === 'SETTINGS_NOT_APPLIED');
    assert.equal(applied?.severity, 'info');
    assert.match(applied.message, /sample rate 48000 instead of 44100/);
    assert.match(applied.message, /channel count 2 instead of 1/);
    assert.ok(free.findings.some(f => f.id === 'AGC_ACTIVE' && f.severity === 'info'));
    assert.match(free.scope, /input level, driver processing and audio enhancements are not visible to the browser/);
    const premium = evaluatePremiumReport({ ...built, audioMetrics: m });
    assert.ok(premium.recommendations.some(r => r.id === 'SETTINGS_NOT_APPLIED' && r.relatedSetting === 'sampleRate'));
    assert.ok(premium.recommendations.some(r => r.id === 'AGC_SYSTEM_LEVEL'));
    assert.equal(premium.metrics.find(item => item.key === 'osInputLevel').value, 'Not visible to the browser');
    assert.equal(premium.metrics.find(item => item.key === 'appliedSettings').rating, 'fair');
    assert.equal(premium.metrics.find(item => item.key === 'truePeak').unit, 'dBTP');
  } finally { builder._resetRunState(); }
  // A run whose device honoured every request stays quiet on these observations.
  const honoured = report(analyzePcm([speechLike(4, 0.2)], sampleRate), { appliedConstraints: { autoGainControl: false } });
  assert.ok(!evaluator.evaluateFree(honoured).findings.some(f => ['SETTINGS_NOT_APPLIED', 'AGC_ACTIVE'].includes(f.id)));
});

test('guidance-only and legacy reports without the new metrics keep their previous behaviour', () => {
  const legacy = report({ status: 'measured', source: 'decoded-file-pcm', sampleCount: 48000, durationMs: 1000,
    signal: { rmsDb: -25, peakDb: -10, maxBlockRmsDb: -20, maxBlockRmsStatus: 'measured' },
    clipping: { status: 'measured', method: 'sample-saturation', rate: 0 }, headroom: { peakDb: -10 },
    noiseFloor: { status: 'unavailable' }, snr: { status: 'unavailable' }, dropouts: { status: 'unavailable' },
    lufs: { integrated: -45, shortTerm: -45 } });
  const free = evaluator.evaluateFree(legacy);
  assert.deepEqual(ids(free.findings), []);
  assert.equal(getTroubleshootingGuidance(legacy, { measurementFindings: [{ id: 'PINNED_CEILING' }] })[0].replaces, 'PINNED_CEILING');
  assert.equal(getTroubleshootingGuidance(legacy, { measurementFindings: [{ id: 'FULL_SCALE_SAMPLES' }, { id: 'PINNED_CEILING' }] })[0].replaces,
    'FULL_SCALE_SAMPLES');
});
