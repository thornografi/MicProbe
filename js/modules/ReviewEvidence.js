import { normalizeEnvironment } from './EnvironmentContext.js';
import { projectCaptureTiming } from './CaptureOutcome.js';
import { projectCaptureContext, getConstraintMismatches, getAppliedConstraints } from './CaptureContext.js';

// Public transport shape only. Finding thresholds and review decisions stay on
// the server. Never send audio, arbitrary notes, logs or device identifiers.
const fields = {
  signal: ['rmsDb', 'peakDb', 'maxBlockRmsDb', 'maxBlockRmsStatus', 'maxBlockRmsWindowMs', 'crestFactorDb'],
  clipping: ['status', 'method', 'rate', 'eventCount'],
  lufs: ['status', 'integratedStatus', 'integrated', 'integratedMonoEquivalent'],
  noiseFloor: ['status', 'method', 'estimatedDb', 'reason'],
  snr: ['status', 'method', 'estimatedDb', 'reason'],
  guidedNoise: ['status', 'method', 'version', 'quietStatus', 'contrastDb', 'reason', 'quietTotalDb', 'quietSpreadDb', 'quietVariable', 'excludedQuietMs'],
  speechActivity: ['status', 'method', 'reason', 'detectedSpeechMs', 'speakingDurationMs', 'detection', 'quietSpeechMs'],
  truePeak: ['status', 'db'],
  ceiling: ['status', 'ceilingDb', 'nearCeilingRate', 'flatTopRate'],
  coverage: ['truncated', 'durationSec', 'analyzedDurationSec', 'sampleRate', 'numberOfChannels'],
  channelIdentity: ['identical']
};
const scalar = value => value === null || typeof value === 'boolean' || Number.isFinite(value)
  || (typeof value === 'string' && /^[a-zA-Z0-9_.:;/= -]{1,160}$/.test(value));
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value && Object.hasOwn(value, key) && scalar(value[key]))
  .map(key => [key, value[key]]));
const settings = ['sampleRate', 'channelCount', 'echoCancellation', 'noiseSuppression', 'autoGainControl'];

export function projectReviewReport(report) {
  const metrics = report?.audioMetrics;
  return {
    ...pick(report, ['version', 'generatedAt']),
    run: pick(report?.run, ['id', 'type', 'accountOwnerId']),
    environment: normalizeEnvironment(report?.environment),
    ...projectCaptureContext(report),
    profile: {
      ...pick(report?.profile, ['id', 'category', 'pipeline', 'encoder', 'approximation', 'referenceVersion']),
      runtime: pick(report?.profile?.runtime, ['browser', 'majorVersion', 'platform', 'formFactor']),
      appliedConstraints: pick(getAppliedConstraints(report?.profile), settings),
      requestedConstraints: pick(report?.profile?.requestedConstraints, settings),
      constraintMismatches: getConstraintMismatches(report?.profile)
    },
    communicationContext: pick(report?.communicationContext, ['usage']),
    recording: { ...pick(report?.recording, ['mimeType', 'encoderReportedBitrate', 'requestedBitrate', 'bitrateMode']),
      ...projectCaptureTiming(report?.recording) },
    loopback: {
      ...pick(report?.loopback, ['requestedBitrate']),
      senderCodec: pick(report?.loopback?.senderCodec, ['mimeType']),
      receiverCodec: pick(report?.loopback?.receiverCodec, ['mimeType']),
      requestedOpus: pick(report?.loopback?.requestedOpus, ['dtx', 'fec'])
    },
    audioMetrics: {
      ...pick(metrics, ['status', 'source', 'sampleCount', 'durationMs', 'sampleRate', 'channelCount', 'channelLayout']),
      ...Object.fromEntries(Object.entries(fields).map(([key, keys]) => [key, pick(metrics?.[key], keys)]))
    }
  };
}
