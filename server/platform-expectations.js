const { PLATFORM_REFERENCE_CATALOGS } = require('./platform-reference-catalog.js');
const finite = Number.isFinite;
const read = (value, path) => path.split('.').reduce((part, key) => part?.[key], value);
const matches = (report, conditions) => Object.entries(conditions).every(([path, value]) => read(report, path) === value);
const metric = (unit, conditions) => ({ unit, conditions });
const LABELS = { 'signal.maxBlockRmsDb': 'Loudest short-window level', 'lufs.integrated': 'Integrated loudness',
  'lufs.integratedMonoEquivalent': 'Mono-equivalent loudness', 'signal.crestFactorDb': 'Peak-to-average spread',
  'ceiling.nearCeilingRate': 'Samples near the waveform ceiling', 'clipping.rate': 'Full-scale sample share',
  'truePeak.db': 'True peak', 'noiseFloor.estimatedDb': 'Recorded quiet-segment level', 'snr.estimatedDb': 'Estimated signal-to-noise ratio' };
// Only established scalar measurements can be compared. No quality score or
// frequency-response diagnosis is inferred from speech or a bitrate target.
const METRICS = {
  'signal.maxBlockRmsDb': metric('dBFS', { 'audioMetrics.signal.maxBlockRmsStatus': 'measured', 'audioMetrics.signal.maxBlockRmsWindowMs': 10 }),
  'lufs.integrated': metric('LUFS', { 'audioMetrics.lufs.status': 'measured', 'audioMetrics.lufs.integratedStatus': 'measured' }),
  'lufs.integratedMonoEquivalent': metric('LUFS', { 'audioMetrics.lufs.status': 'measured', 'audioMetrics.lufs.integratedStatus': 'measured', 'audioMetrics.channelLayout': 'dual-mono' }),
  'signal.crestFactorDb': metric('dB', {}),
  'ceiling.nearCeilingRate': metric('ratio', { 'audioMetrics.ceiling.status': 'measured' }),
  'clipping.rate': metric('ratio', { 'audioMetrics.clipping.status': 'measured', 'audioMetrics.clipping.method': 'sample-saturation' }),
  'truePeak.db': metric('dBTP', { 'audioMetrics.truePeak.status': 'measured' }),
  'noiseFloor.estimatedDb': metric('dBFS', { 'audioMetrics.guidedNoise.status': 'measured', 'audioMetrics.guidedNoise.method': 'user-guided-file-segments', 'audioMetrics.noiseFloor.status': 'measured', 'audioMetrics.noiseFloor.method': 'guided-quiet-segment' }),
  'snr.estimatedDb': metric('dB', { 'audioMetrics.snr.status': 'measured', 'audioMetrics.snr.method': 'guided-power-subtraction',
    'audioMetrics.guidedNoise.status': 'measured', 'audioMetrics.guidedNoise.method': 'user-guided-file-segments',
    'profile.appliedConstraints.echoCancellation': false, 'profile.appliedConstraints.noiseSuppression': false, 'profile.appliedConstraints.autoGainControl': false })
};
const FINDING_PATHS = {
  PINNED_CEILING: ['ceiling.nearCeilingRate', 'signal.crestFactorDb'],
  FULL_SCALE_SAMPLES: ['clipping.rate'], TRUE_PEAK_OVER: ['truePeak.db'],
  MEASURED_NOISE: ['noiseFloor.estimatedDb'], MEASURED_LOW_SNR: ['snr.estimatedDb']
};
const FREE_IDS = { LOW_RECORDED_LEVEL: ['WEAK_SIGNAL'], PINNED_CEILING: ['PINNED_CEILING'],
  FULL_SCALE_SAMPLES: ['CLIPPING'], TRUE_PEAK_OVER: ['TRUE_PEAK_OVER'], MEASURED_NOISE: ['HIGH_NOISE'], MEASURED_LOW_SNR: ['LOW_SNR'] };
const CONDITIONS = new Set(['version', 'run.type', 'profile.pipeline', 'profile.encoder', 'recording.mimeType', 'recording.encoderReportedBitrate',
  'profile.runtime.browser', 'profile.runtime.majorVersion', 'profile.runtime.platform', 'profile.runtime.formFactor',
  'recording.requestedBitrate', 'recording.bitrateMode',
  'loopback.senderCodec.mimeType', 'loopback.receiverCodec.mimeType', 'loopback.requestedBitrate', 'loopback.requestedOpus.dtx', 'loopback.requestedOpus.fec',
  'audioMetrics.sampleRate', 'audioMetrics.channelCount', 'audioMetrics.channelLayout',
  ...['sampleRate', 'channelCount', 'echoCancellation', 'noiseSuppression', 'autoGainControl'].map(key => `profile.appliedConstraints.${key}`)]);
const REQUIRED = ['version', 'run.type', 'profile.pipeline', 'recording.mimeType', 'audioMetrics.sampleRate', 'audioMetrics.channelCount',
  'profile.runtime.browser', 'profile.runtime.majorVersion', 'profile.runtime.platform', 'profile.runtime.formFactor',
  ...['sampleRate', 'channelCount', 'echoCancellation', 'noiseSuppression', 'autoGainControl'].map(key => `profile.appliedConstraints.${key}`)];

function validReference(reference, target) {
  const { evidence = {}, conditions = {}, ranges = [], scope = {} } = reference;
  if (!evidence || !conditions || !scope || !Array.isArray(ranges)) return false;
  const date = value => typeof value === 'string' && finite(Date.parse(value));
  const required = [...REQUIRED, ...(conditions['run.type'] === 'test'
    ? ['loopback.senderCodec.mimeType', 'loopback.receiverCodec.mimeType', 'loopback.requestedBitrate', 'recording.encoderReportedBitrate', 'loopback.requestedOpus.dtx', 'loopback.requestedOpus.fec']
    : ['profile.encoder', 'recording.bitrateMode', ...(conditions['recording.bitrateMode'] === 'requested' ? ['recording.requestedBitrate'] : [])])];
  return typeof reference.id === 'string' && reference.id.length > 0 && scope.platform === target.platform && scope.mode === target.mode
    && ['web', 'desktop', 'mobile'].includes(scope.client) && scope.output === 'local-saved-recording'
    && typeof scope.clientVersion === 'string' && scope.clientVersion.trim().length > 0 && scope.clientVersion !== 'unknown'
    && evidence.status === 'validated' && [evidence.platformArtifact, evidence.localArtifact, evidence.protocol].every(value => typeof value === 'string' && value.trim().length > 0)
    && date(evidence.measuredAt) && date(evidence.reviewedAt) && date(evidence.validFrom) && date(evidence.validUntil)
    && Date.parse(evidence.measuredAt) <= Date.parse(evidence.reviewedAt)
    && Date.parse(evidence.reviewedAt) <= Date.parse(evidence.validFrom) && Date.parse(evidence.validFrom) < Date.parse(evidence.validUntil)
    && required.every(key => Object.hasOwn(conditions, key) && conditions[key] != null && conditions[key] !== 'unknown')
    && Object.entries(conditions).every(([key, value]) => CONDITIONS.has(key) && value != null && ['string', 'number', 'boolean'].includes(typeof value))
    && ['record', 'test'].includes(conditions['run.type']) && finite(reference.minimumDurationMs) && reference.minimumDurationMs >= 400
    && ranges.length > 0 && ranges.every(item => item && typeof item === 'object') && new Set(ranges.map(item => item.path)).size === ranges.length
    && ranges.every(item => METRICS[item.path]?.unit === item.unit && finite(item.min) && finite(item.max) && item.min <= item.max
      && (item.unit !== 'ratio' || (item.min >= 0 && item.max <= 1)))
    && Array.isArray(reference.expectedFindings) && reference.expectedFindings.every(id => Object.hasOwn(FREE_IDS, id));
}

function assessPlatformExpectations(report, catalogs = PLATFORM_REFERENCE_CATALOGS) {
  const version = report?.profile?.referenceVersion;
  const catalog = Object.hasOwn(catalogs, version || '') ? catalogs[version] : null;
  const target = catalog && Object.hasOwn(catalog.targets, report?.profile?.id || '') ? catalog.targets[report.profile.id] : null;
  const result = { version: 1, catalogVersion: version || null, target: target || null, status: 'unavailable',
    reason: 'reference-version-unavailable', summary: 'A compatible platform reference is unavailable. These findings describe the local recording only.',
    comparisons: [], excluded: [], expectedFindings: [] };
  if (!catalog || !target) return result;
  if (!target.platform) return { ...result, status: 'not-applicable', reason: 'no-specific-platform', summary: 'This scenario does not establish a specific application target.' };
  result.status = 'unverified'; result.reason = 'awaiting-validated-reference';
  result.summary = 'A validated sound-quality reference is not yet available for this scenario. Local findings do not establish a microphone fault or an application problem.';
  const references = catalog.references.filter(item => item.profileId === report.profile.id);
  const m = report.audioMetrics;
  const captureDate = Date.parse(report.generatedAt);
  for (const reference of references) {
    let reason = null;
    const evidence = reference.evidence || {};
    if (!validReference(reference, target)) reason = 'reference-not-validated';
    else if (!finite(captureDate) || captureDate < Date.parse(evidence.validFrom) || captureDate >= Date.parse(evidence.validUntil)) reason = 'outside-reference-period';
    else if (!matches(report, reference.conditions)) reason = 'test-conditions-differ';
    else if (m?.source !== 'decoded-file-pcm' || m.status !== 'measured' || !(m.sampleCount > 0)
      || !finite(m.signal?.rmsDb) || !finite(m.signal?.peakDb) || m.signal.rmsDb > m.signal.peakDb
      || m.coverage?.truncated !== false || !(m.durationMs >= reference.minimumDurationMs)) reason = 'insufficient-measurement';
    if (reason) { result.excluded.push({ id: reference.id, reason }); continue; }
    for (const range of reference.ranges) {
      const value = read(m, range.path);
      if (!finite(value) || (range.unit === 'ratio' && (value < 0 || value > 1))
        || !matches(report, METRICS[range.path].conditions)
        || (range.path === 'lufs.integrated' && finite(m.lufs?.integratedMonoEquivalent))
        || (range.path === 'signal.maxBlockRmsDb' && value > m.signal.peakDb)) {
        result.excluded.push({ id: reference.id, path: range.path, reason: 'metric-unavailable' }); continue;
      }
      result.comparisons.push({ referenceId: reference.id, path: range.path, label: LABELS[range.path], unit: range.unit, value,
        min: range.min, max: range.max, status: value < range.min ? 'below' : value > range.max ? 'above' : 'within',
        scope: reference.scope, evidence, expectedFindings: reference.expectedFindings });
    }
  }
  // Overlapping references cannot silently vote an observation into normality.
  const conflicting = result.comparisons.some(item => result.comparisons.some(other => other !== item && other.path === item.path
    && (other.min !== item.min || other.max !== item.max)));
  if (conflicting) return { ...result, status: 'unavailable', reason: 'conflicting-references', comparisons: [],
    summary: 'The available references disagree; a platform comparison cannot be made reliably.' };
  if (!result.comparisons.length) return references.length ? { ...result, status: 'unavailable', reason: 'no-compatible-reference',
    summary: 'The available platform reference does not cover this recording’s conditions or measurements. A platform comparison is unavailable.' } : result;
  result.status = 'compared'; result.reason = 'compatible-reference';
  result.summary = result.comparisons.some(item => item.status !== 'within')
    ? 'At least one measured characteristic is outside the validated range for this local scenario. This does not identify its cause.'
    : 'The compared characteristics are within the validated ranges for this local scenario. This does not establish microphone health or suitability for every use.';
  return result;
}

function applyPlatformExpectations(findings, assessment) {
  const comparisons = assessment.comparisons || [];
  const classified = findings.map(finding => {
    // Near silence still needs speaking context; platform processing cannot excuse it.
    const paths = finding.evidencePaths || FINDING_PATHS[finding.id];
    const expected = !finding.nearSilent && paths?.length && comparisons.length && paths.every(path =>
      comparisons.some(item => item.path === path && item.status === 'within' && item.expectedFindings.includes(finding.id)))
      && !comparisons.some(item => paths.includes(item.path) && item.status !== 'within');
    if (!expected) return finding;
    if (!assessment.expectedFindings.includes(finding.id)) assessment.expectedFindings.push(finding.id);
    return { ...finding, expectation: 'within-reference', severity: 'info', category: 'observation', action: '',
      reason: `${finding.reason} This characteristic is within the validated range for the selected local scenario; it does not by itself justify a microphone correction.` };
  });
  // An expected result does not itself justify the legacy invitation to make
  // another call/message. Keep its scope explanation without that extra task.
  const expectedOnly = assessment.expectedFindings.length > 0 && comparisons.every(item => item.status === 'within')
    && !classified.some(item => ['warning', 'critical'].includes(item.severity));
  return expectedOnly ? classified.map(item => item.id === 'LOCAL_TEST_SCOPE' ? { ...item, action: '' } : item) : classified;
}

function publicPlatformAssessment(assessment) {
  return { status: assessment.status, reason: assessment.reason, summary: assessment.summary,
    hasDeviation: assessment.comparisons.some(item => item.status !== 'within'),
    expectedFindingIds: [...new Set(assessment.expectedFindings.flatMap(id => FREE_IDS[id] || []))] };
}

module.exports = { assessPlatformExpectations, applyPlatformExpectations, publicPlatformAssessment, validReference };
