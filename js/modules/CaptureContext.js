// Capture facts only: no quality thresholds, hardware identity or live probing.
const SETTINGS = ['sampleRate', 'channelCount', 'echoCancellation', 'noiseSuppression', 'autoGainControl'];
const validSetting = (key, value) => ['sampleRate', 'channelCount'].includes(key)
  ? Number.isFinite(value) && value > 0 : typeof value === 'boolean';

export function getAppliedConstraints(profile) {
  const applied = profile?.appliedConstraints ?? profile?.constraints;
  return applied && typeof applied === 'object' && !Array.isArray(applied) ? applied : {};
}

export function getConstraintMismatches(profile = {}) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return [];
  const requested = profile.requestedConstraints || {}, applied = getAppliedConstraints(profile);
  if (SETTINGS.some(key => Object.hasOwn(requested, key))) {
    return SETTINGS.filter(key => validSetting(key, requested[key]) && validSetting(key, applied[key]) && requested[key] !== applied[key])
      .map(key => ({ key, requested: requested[key], applied: applied[key] }));
  }
  // Old reports may contain only the already captured mismatch list. Do not
  // let that list override present requested/applied facts in newer reports.
  return (Array.isArray(profile.constraintMismatches) ? profile.constraintMismatches : [])
    .filter(item => item && SETTINGS.includes(item.key) && validSetting(item.key, item.requested)
      && validSetting(item.key, item.applied) && item.requested !== item.applied)
    .map(({ key, requested, applied }) => ({ key, requested, applied }));
}

export function projectCaptureContext(report) {
  const caps = report?.captureContext?.capabilities;
  const capabilities = {};
  for (const key of ['sampleRateRange', 'channelCountRange']) {
    const range = caps?.[key];
    if (Number.isFinite(range?.min) && Number.isFinite(range?.max) && range.min > 0 && range.max >= range.min) {
      capabilities[key] = { min: range.min, max: range.max };
    }
  }
  for (const key of ['ecSupported', 'nsSupported', 'agcSupported']) {
    if (Array.isArray(caps?.[key]) && caps[key].length && caps[key].every(value => typeof value === 'boolean')) {
      capabilities[key] = [...new Set(caps[key])];
    }
  }
  const system = {}, sys = report?.system;
  if (typeof report?.run?.id === 'string' && report.run.id && sys?.runId === report.run.id) {
    system.runId = sys.runId;
    if (typeof sys.tabWasHidden === 'boolean') system.tabWasHidden = sys.tabWasHidden;
    const timing = sys.mainThreadJitter;
    if (timing?.supported === true && Number.isSafeInteger(timing.sampleCount) && timing.sampleCount > 0
      && Number.isSafeInteger(timing.spikeCount) && timing.spikeCount >= 0 && timing.spikeCount <= timing.sampleCount) {
      system.mainThreadJitter = { supported: true, sampleCount: timing.sampleCount, spikeCount: timing.spikeCount };
    }
    const net = sys.network;
    if (report.run.type === 'test' && Number.isSafeInteger(net?.concealedSamples) && net.concealedSamples >= 0) {
      system.network = { concealedSamples: net.concealedSamples };
      if (Number.isFinite(net.concealmentRatio) && net.concealmentRatio >= 0 && net.concealmentRatio <= 1) system.network.concealmentRatio = net.concealmentRatio;
    }
  }
  return { captureContext: { capabilities }, system };
}
