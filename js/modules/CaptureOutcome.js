import { getGuidedSegmentIssue } from './utils/guidedNoise.js';

/** Timing evidence only: completing a speaking prompt does not prove speech. */
export function captureOutcome(recording, decodedDurationMs) {
  const segments = recording?.guidedSegments;
  const reason = recording?.stopReason;
  const early = !!segments && reason === 'user';
  const disconnected = reason === 'device-ended';
  // Older and non-guided recordings retain their existing assessment contract.
  const issue = segments ? getGuidedSegmentIssue({ ...segments, interrupted: false }, decodedDurationMs ?? recording?.durationMs) : null;
  const interrupted = segments?.interrupted === true;
  const incomplete = !!issue;
  const message = disconnected ? 'The microphone disconnected. The captured audio was kept.'
    : interrupted ? 'The test was interrupted while the page was hidden. The captured audio was kept.'
    : incomplete && !segments?.speaking ? 'The recording ended before the speaking section started.'
    : incomplete ? 'The recording ended before enough of the speaking section was captured.'
    : early ? 'You stopped the recording early. The captured section was assessed.' : '';
  return { incomplete, interrupted, early, message };
}

/** Minimal timing evidence for quota/review requests; never audio or device data. */
export function projectCaptureTiming(recording) {
  if (!recording?.guidedSegments && !recording?.stopReason) return {};
  const finite = value => Number.isFinite(value) ? value : null;
  const range = value => value ? { startMs: finite(value.startMs), endMs: finite(value.endMs) } : null;
  const segments = recording.guidedSegments;
  return {
    stopReason: ['user', 'guided-complete', 'duration-limit', 'device-ended', 'memory-limit', 'capture-error'].includes(recording.stopReason)
      ? recording.stopReason : null,
    ...(segments ? { guidedSegments: { version: segments.version, method: segments.method,
      interrupted: segments.interrupted === true, quiet: range(segments.quiet), speaking: range(segments.speaking) } } : {})
  };
}
