import { captureOutcome } from './CaptureOutcome.js';

/** Measurement provenance and availability only. Private thresholds and advice
 * stay on the server. One unavailable metric must not erase another valid one. */
export function usableReport(input) {
  const report = structuredClone(input || {}), m = report.audioMetrics || {};
  const finite = Number.isFinite, invalid = [];
  const base = ['record', 'test'].includes(report.run?.type) && m.status === 'measured'
    && m.source === 'decoded-file-pcm' && Number.isSafeInteger(m.sampleCount) && m.sampleCount > 0
    && finite(m.durationMs) && m.durationMs >= 400
    && finite(m.signal?.rmsDb) && finite(m.signal?.peakDb);
  if (!base) return { report, valid: false, invalid: ['recording-evidence'] };
  if (captureOutcome(report.recording, m.durationMs).incomplete) {
    return { report, valid: false, invalid: ['guided-capture-incomplete'] };
  }
  if (m.signal.rmsDb > m.signal.peakDb + 0.000001 || (m.signal.maxBlockRmsStatus === 'measured'
    && (!finite(m.signal.maxBlockRmsDb) || m.signal.maxBlockRmsDb > m.signal.peakDb + 0.000001))) {
    return { report, valid: false, invalid: ['signal-consistency'] };
  }
  const disable = key => { invalid.push(key); m[key] = { status: 'unavailable', reason: m[key]?.reason || 'invalid-or-missing-evidence' }; };
  const ratio = value => finite(value) && value >= 0 && value <= 1;
  if (m.clipping?.status !== 'measured' || m.clipping.method !== 'sample-saturation' || !ratio(m.clipping.rate)) disable('clipping');
  if (m.ceiling?.status === 'measured' && (!ratio(m.ceiling.nearCeilingRate)
    || (m.ceiling.flatTopRate != null && !ratio(m.ceiling.flatTopRate))
    || !finite(m.signal.crestFactorDb) || m.signal.crestFactorDb < 0)) disable('ceiling');
  const guided = m.guidedNoise?.status === 'measured' && m.guidedNoise.method === 'user-guided-file-segments';
  const quietMeasured = m.guidedNoise?.version === 2
    ? m.guidedNoise.method === 'user-guided-file-segments' && m.guidedNoise.quietStatus === 'measured' : guided;
  if (!quietMeasured || m.noiseFloor?.status !== 'measured' || m.noiseFloor.method !== 'guided-quiet-segment'
    || !finite(m.noiseFloor.estimatedDb) || m.noiseFloor.estimatedDb > m.signal.peakDb) disable('noiseFloor');
  const applied = report.profile?.appliedConstraints || {};
  if (!guided || m.snr?.status !== 'measured' || m.snr.method !== 'guided-power-subtraction'
    || !finite(m.snr.estimatedDb) || !['echoCancellation', 'noiseSuppression', 'autoGainControl'].every(key => applied[key] === false)) disable('snr');
  if (m.speechActivity?.status === 'measured' && (m.speechActivity.method !== 'webrtc-vad-libfvad-2.0.7'
    || !finite(m.speechActivity.detectedSpeechMs) || !finite(m.speechActivity.speakingDurationMs)
    || m.speechActivity.detectedSpeechMs < 0 || m.speechActivity.speakingDurationMs > m.durationMs
    || m.speechActivity.detectedSpeechMs > m.speechActivity.speakingDurationMs
    || !['detected', 'uncertain'].includes(m.speechActivity.detection))) disable('speechActivity');
  return { report, valid: true, invalid };
}

/** Incomplete/interrupted guided tests do not consume an allowance. Missing
 * optional noise/SNR measurements alone do not invalidate a completed test. */
export function countsAsCompletedTest(report) {
  const m = report?.audioMetrics;
  const capture = captureOutcome(report?.recording, m?.durationMs);
  return !capture.incomplete && !capture.interrupted && m?.status === 'measured' && m.sampleCount > 0 && m.durationMs >= 400
    && Number.isFinite(m.signal?.rmsDb) && Number.isFinite(m.signal?.peakDb)
    && m.clipping?.status === 'measured' && m.clipping.method === 'sample-saturation' && Number.isFinite(m.clipping.rate);
}
