import { reviewReport } from './review-fixtures.mjs';

// Fictional calibration, never published as a real platform's sound-quality range.
export function platformReferenceFixture() {
  const report = reviewReport();
  report.profile = { ...report.profile, id: 'fixture-platform', referenceVersion: 'fixture-v1', approximation: true };
  report.profile.runtime = { browser: 'chrome', majorVersion: 999, platform: 'Win32', formFactor: 'desktop' };
  report.audioMetrics.sampleRate = 48000; report.audioMetrics.channelCount = 1;
  report.recording = { mimeType: 'audio/wav', bitrateMode: 'uncompressed-pcm' };
  const target = { platform: 'fixture', mode: 'voice-message', client: 'unknown' };
  const reference = { id: 'fixture-level', profileId: report.profile.id,
    scope: { platform: 'fixture', mode: 'voice-message', client: 'web', clientVersion: 'fixture-build-1', output: 'local-saved-recording' },
    evidence: { status: 'validated', platformArtifact: 'fixture/platform', localArtifact: 'fixture/local', protocol: 'fixture/protocol',
      measuredAt: '2026-09-01', reviewedAt: '2026-09-02', validFrom: '2026-09-03', validUntil: '2026-10-01' },
    minimumDurationMs: 10000,
    conditions: { version: report.version, 'run.type': 'record', 'profile.pipeline': 'worklet', 'profile.encoder': 'pcm-wav',
      'recording.mimeType': 'audio/wav', 'recording.bitrateMode': 'uncompressed-pcm',
      'audioMetrics.sampleRate': 48000, 'audioMetrics.channelCount': 1,
      ...Object.fromEntries(Object.entries(report.profile.runtime).map(([key, value]) => [`profile.runtime.${key}`, value])),
      ...Object.fromEntries(Object.entries(report.profile.appliedConstraints).map(([key, value]) => [`profile.appliedConstraints.${key}`, value])) },
    ranges: [{ path: 'signal.maxBlockRmsDb', min: -52, max: -46, unit: 'dBFS' }], expectedFindings: ['LOW_RECORDED_LEVEL'] };
  const catalogs = { 'fixture-v1': { targets: { 'fixture-platform': target }, references: [reference] } };
  return { report, reference, catalogs, target };
}
