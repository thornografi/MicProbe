export const reviewReport = (runId = 'review-run-1', patch = {}) => ({
  version: '2.0', generatedAt: '2026-09-11T12:00:00.000Z', run: { id: runId, type: 'record', accountOwnerId: null },
  profile: { id: 'raw', pipeline: 'worklet', encoder: 'pcm-wav', approximation: false,
    appliedConstraints: { sampleRate: 48000, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } },
  audioMetrics: { source: 'decoded-file-pcm', status: 'measured', sampleCount: 480000, durationMs: 10000,
    signal: { rmsDb: -51, peakDb: -42, maxBlockRmsDb: -48, maxBlockRmsStatus: 'measured', maxBlockRmsWindowMs: 10 },
    clipping: { status: 'measured', method: 'sample-saturation', rate: 0 }, coverage: { truncated: false }, ...patch }
});
