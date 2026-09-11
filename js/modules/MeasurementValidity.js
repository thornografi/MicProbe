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
  if (!guided || m.noiseFloor?.status !== 'measured' || m.noiseFloor.method !== 'guided-quiet-segment'
    || !finite(m.noiseFloor.estimatedDb) || m.noiseFloor.estimatedDb > m.signal.peakDb) disable('noiseFloor');
  const applied = report.profile?.appliedConstraints || {};
  if (!guided || m.snr?.status !== 'measured' || m.snr.method !== 'guided-power-subtraction'
    || !finite(m.snr.estimatedDb) || !['echoCancellation', 'noiseSuppression', 'autoGainControl'].every(key => applied[key] === false)) disable('snr');
  return { report, valid: true, invalid };
}

/** Existing daily-test accounting contract. Deliberately independent of how
 * many individual findings can be explained in a report. */
export function countsAsCompletedTest(report) {
  const m = report?.audioMetrics;
  return m?.status === 'measured' && m.sampleCount > 0 && m.durationMs >= 400
    && Number.isFinite(m.signal?.rmsDb) && Number.isFinite(m.signal?.peakDb)
    && m.clipping?.status === 'measured' && m.clipping.method === 'sample-saturation' && Number.isFinite(m.clipping.rate);
}
