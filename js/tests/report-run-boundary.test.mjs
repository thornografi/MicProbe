import test from 'node:test';
import assert from 'node:assert/strict';
import builder from '../modules/DiagnosticReportBuilder.js';
import { createRunSnapshot, completeRunSnapshot } from '../modules/RunSnapshot.js';
import { summarizeLoopbackStats } from '../modules/utils/loopbackStats.js';
import eventBus from '../modules/EventBus.js';
import { EVENTS } from '../modules/constants.js';

globalThis.window = {};
const snap = (id, bitrate = 0) => completeRunSnapshot(createRunSnapshot({
  profile: { id, label: id, category: 'record' },
  requestedSettings: { sampleRate: 16000, noiseSuppression: true, bitrate, pipeline: 'worklet' }
}), { getAudioTracks: () => [{ label: 'captured microphone', getSettings: () => ({ sampleRate: 48000, noiseSuppression: false }) }] });

test('restoring history during call or record completion cannot consume the active report publication', async t => {
  t.after(() => builder._resetRunState());
  for (const type of ['test', 'record']) {
    builder.init({ deepAnalysisEngine: { cancel() {}, analyze: async (_blob, { runId }) => ({ runId, status: 'ready' }) } });
    const run = snap(`active-${type}`);
    builder._beginRun(type, { runSnapshot: run });
    builder.restoreReport({ run: { id: 'old-report', type } });
    assert.equal(builder.getLastReport().run.id, 'old-report');
    const next = new Promise(resolve => {
      const off = eventBus.on(EVENTS.DIAGNOSTIC_REPORT_READY, report => { off(); resolve(report); });
    });
    if (type === 'test') {
      builder._handleTestRecordingStopped({ runSnapshot: run });
      builder._handleTestCompleted({ runId: run.runId, analysis: { status: 'ready' } });
    } else await builder._handleRecordingCompleted({ runSnapshot: run, blob: new Blob(['audio']) });
    assert.equal((await next).run.id, run.runId);
    assert.equal(builder.isReportPending(), false);
    builder.restoreReport({ run: { id: 'old-again', type } });
    if (type === 'test') {
      builder._handleTestCompleted({ runId: run.runId });
      assert.equal(builder._reportTimerId, null, 'a duplicate completion cannot republish the run');
    }
  }
});

test('report freezes applied settings, preserves VBR, and never grades live UI snapshots', () => {
  builder.init({ metricsCollector: { getResults: () => ({ sampleCount: 999, status: 'preview' }) } });
  builder._beginRun('record', { runSnapshot: snap('telegram') });
  const r = builder.build();
  assert.equal(r.profile.requestedConstraints.sampleRate, 16000);
  assert.equal(r.profile.constraints.sampleRate, 48000);
  assert.equal(r.profile.constraints.noiseSuppression, false);
  assert.equal(r.profile.constraints.channelCount, null);
  assert.equal(r.profile.bitrate, 0);
  assert.equal(r.device.micName, 'captured microphone');
  assert.equal(r.audioMetrics, null);
});

test('a late previous-file analysis cannot publish into the next run', async () => {
  let finish;
  builder.init({ deepAnalysisEngine: { cancel() {}, analyze: () => new Promise(resolve => { finish = resolve; }) } });
  const a = snap('A');
  builder._beginRun('record', { runSnapshot: a });
  const pending = builder._handleRecordingCompleted({ runSnapshot: a, blob: new Blob(['A']) });
  const b = snap('B');
  builder._beginRun('record', { runSnapshot: b });
  finish({ runId: a.runId, audioMetrics: { sampleCount: 48 } });
  await pending;
  assert.equal(builder.build().run.id, b.runId);
  assert.equal(builder.build().audioMetrics, null);
  assert.equal(builder._reportTimerId, null);
});

test('matching saved-file analysis becomes the report, with frozen capture diagnostics', async () => {
  const run = snap('saved');
  const metrics = { status: 'measured', sampleCount: 48000 };
  builder.init({ deepAnalysisEngine: { cancel() {}, analyze: async () => ({ runId: run.runId, audioMetrics: metrics }) },
    systemProbeCollector: { stop: () => ({ mainThreadJitter: { spikeCount: 3 }, network: { concealmentEvents: 4 } }) } });
  builder._beginRun('record', { runSnapshot: run });
  builder._onCaptureStopped({ runSnapshot: run });
  let emitted;
  const off = eventBus.on(EVENTS.DIAGNOSTIC_REPORT_READY, r => { emitted = r; });
  await builder._handleRecordingCompleted({ runSnapshot: run, blob: new Blob(['sample']), durationMs: 1000, requestedBitrate: 0 });
  await new Promise(resolve => setTimeout(resolve, 5));
  off();
  assert.equal(emitted.audioMetrics, metrics);
  assert.equal(emitted.recording.bitrateMode, 'encoder-default-vbr');
  assert.equal(emitted.system.correlation.method, 'observations-only');
  assert.equal(emitted.system.correlation.findings[0].id, 'INCONCLUSIVE');
});

test('WebRTC receiver metrics come from receiving peer and timestamps determine throughput', () => {
  const sender = [
    { id: 'send', type: 'outbound-rtp', kind: 'audio', bytesSent: 3000, timestamp: 2000 },
    { type: 'remote-inbound-rtp', kind: 'audio', roundTripTime: .02, jitter: 99 },
    { type: 'inbound-rtp', kind: 'audio', packetsReceived: 0, packetsLost: 999 }
  ];
  const receiver = [{ type: 'inbound-rtp', kind: 'audio', packetsReceived: 98, packetsLost: 2,
    jitter: .003, concealedSamples: 48, concealmentEvents: 1, timestamp: 2001 }];
  const r = summarizeLoopbackStats(sender, receiver, { id: 'send', bytesSent: 1000, timestamp: 1000 }).stats;
  assert.equal(r.actualBitrate, 16000);
  assert.equal(r.packetLossRate, .02);
  assert.equal(r.jitterMs, 3);
  assert.equal(r.concealedSamples, 48);
  assert.equal(r.rttMs, 20);
  assert.equal(r.isDtxActive, null);
  assert.equal(summarizeLoopbackStats(sender, []).stats.packetLossRate, null);
});

test('counter resets and first stats sample do not fabricate a bitrate', () => {
  const sender = [{ id: 'new', type: 'outbound-rtp', kind: 'audio', bytesSent: 0, timestamp: 1 }];
  assert.equal(summarizeLoopbackStats(sender, []).stats.actualBitrate, null);
  assert.equal(summarizeLoopbackStats(sender, [], { id: 'old', bytesSent: 999, timestamp: 0 }).stats.actualBitrate, null);
});

test('RTP codecId selects the actual codec separately on each peer, not the advertised Opus capability', () => {
  const sender = new Map([
    ['opus', { id: 'opus', type: 'codec', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }],
    ['shared', { id: 'shared', type: 'codec', mimeType: 'audio/PCMU', clockRate: 8000, payloadType: 0 }],
    ['send', { id: 'send', type: 'outbound-rtp', kind: 'audio', codecId: 'shared' }]
  ]);
  const receiver = new Map([
    ['shared', { id: 'shared', type: 'codec', mimeType: 'audio/opus', clockRate: 48000, channels: 2,
      payloadType: 111, sdpFmtpLine: 'minptime=10;useinbandfec=1' }],
    ['receive', { id: 'receive', type: 'inbound-rtp', mediaType: 'audio', codecId: 'shared' }]
  ]);
  const { stats } = summarizeLoopbackStats(sender, receiver);
  assert.deepEqual(stats.senderCodec, { source: 'rtc-codec-stats', mimeType: 'audio/PCMU', clockRate: 8000,
    channels: null, payloadType: 0, sdpFmtpLine: null });
  assert.deepEqual(stats.receiverCodec, { source: 'rtc-codec-stats', mimeType: 'audio/opus', clockRate: 48000,
    channels: 2, payloadType: 111, sdpFmtpLine: 'minptime=10;useinbandfec=1' });
  assert.equal(stats.isDtxActive, null, 'negotiated preferences are not evidence of active DTX');
  sender.get('shared').mimeType = 'audio/mutated';
  assert.equal(stats.senderCodec.mimeType, 'audio/PCMU', 'returned provenance is detached from browser stats');
});

test('missing codec links, absent peer stats and invalid codec fields never fabricate Opus', () => {
  const codec = { type: 'codec', id: 'opus', mimeType: 'audio/opus' };
  for (const sender of [null, [], [codec], [codec, { type: 'outbound-rtp', kind: 'audio' }],
    [codec, { type: 'outbound-rtp', kind: 'audio', codecId: 'missing' }]]) {
    const { stats } = summarizeLoopbackStats(sender, null);
    assert.equal(stats.senderCodec, null);
    assert.equal(stats.receiverCodec, null);
  }
  const { stats } = summarizeLoopbackStats([
    { type: 'outbound-rtp', kind: 'audio', codecId: 'partial' },
    { type: 'codec', id: 'partial', clockRate: NaN, channels: 0, payloadType: -1, sdpFmtpLine: 123 }
  ], []);
  assert.deepEqual(stats.senderCodec, { source: 'rtc-codec-stats', mimeType: null,
    clockRate: null, channels: null, payloadType: null, sdpFmtpLine: null });
});

test('call report separates requested Opus, observed RTP codecs, and the final MediaRecorder file', async t => {
  t.after(() => builder._resetRunState());
  const run = snap('call-provenance', 64000);
  builder._beginRun('test', { runSnapshot: run });
  const senderCodec = { source: 'rtc-codec-stats', mimeType: 'audio/PCMU', clockRate: 8000, channels: 1 };
  builder._onLoopbackStats({ runId: run.runId, actualBitrate: 60000, senderCodec, receiverCodec: null });
  senderCodec.mimeType = 'audio/mutated';
  builder._handleTestRecordingStopped({ runSnapshot: run });
  builder._handleTestCompleted({ runSnapshot: run, recording: {
    encoder: 'mediarecorder', mimeType: 'audio/mp4', mimeTypeSource: 'mediarecorder',
    encoderReportedBitrate: 128000, durationMs: 7000, blobSize: 1234
  } });
  const report = builder.build();
  assert.equal(report.profile.encoder, null);
  assert.equal(report.loopback.requestedCodec, 'audio/opus');
  assert.equal(report.loopback.requestedBitrate, 64000);
  assert.equal(report.loopback.senderCodec.mimeType, 'audio/PCMU');
  assert.equal(report.loopback.receiverCodec, null);
  assert.equal(report.loopback.actualBitrate, 60000);
  assert.equal(report.recording.mimeType, 'audio/mp4');
  assert.equal(report.recording.encoder, 'mediarecorder');
  assert.equal(report.recording.encoderReportedBitrate, 128000);
  assert.equal(report.recording.requestedBitrate, null, 'RTP cap is not a file encoder request');
  assert.equal(report.recording.actualBitrate, null);
  assert.equal(report.recording.bitrateMode, 'browser-default');
  assert.equal(report.recording.sampleSource, 'saved-received-audio');
});

test('a short call without codec stats stays unknown and stale file completion cannot replace it', t => {
  t.after(() => builder._resetRunState());
  const old = snap('old-codec');
  const current = snap('short-codec', 24000);
  builder._beginRun('test', { runSnapshot: current });
  builder._handleTestCompleted({ runSnapshot: old, recording: { mimeType: 'audio/old', encoderReportedBitrate: 999 } });
  const report = builder.build();
  assert.equal(report.loopback.senderCodec, null);
  assert.equal(report.loopback.receiverCodec, null);
  assert.equal(report.loopback.actualBitrate, null);
  assert.equal(report.loopback.requestedBitrate, 24000);
  assert.equal(report.recording, null);
});

test('profile evidence is captured before setup and never backfilled into older runs', t => {
  t.after(() => builder._resetRunState());
  const evidence = { schemaVersion: 1, verifiedAt: '2026-09-05', classification: 'local-approximation',
    clientVersion: null, clientCodec: null,
    sources: [{ platform: 'discord', title: 'Original', url: 'https://discord.com/blog/source', publishedAt: '2026-05-18' }] };
  const profile = { id: 'discord', category: 'call', evidence };
  const run = completeRunSnapshot(createRunSnapshot({ profile }), null);
  evidence.verifiedAt = '2099-01-01';
  evidence.sources[0].title = 'Changed after capture';
  builder._beginRun('test', { runSnapshot: run });
  assert.equal(builder.build().profile.evidence.verifiedAt, '2026-09-05');
  assert.equal(builder.build().profile.evidence.sources[0].title, 'Original');
  assert.equal(builder.build().profile.evidence.clientCodec, null);
  builder._beginRun('test', { runSnapshot: { ...run, evidence: undefined } });
  assert.equal(builder.build().profile.evidence, null);
});

test('late stats from the same connection cannot extend the captured test interval', () => {
  const run = snap('call');
  builder._beginRun('test', { runSnapshot: run });
  builder._onLoopbackStats({ runId: run.runId, actualBitrate: 32000, concealedSamples: 0 });
  builder._onCaptureStopped({ runSnapshot: run });
  builder._onLoopbackStats({ runId: run.runId, actualBitrate: 0, concealedSamples: 999 });
  assert.equal(builder.build().loopback.actualBitrate, 32000);
});

test('report remains pending through analysis success or failure until publication', async t => {
  t.after(() => builder._resetRunState());
  for (const fails of [false, true]) {
    let settle;
    builder.init({ deepAnalysisEngine: { cancel() {}, analyze: () => new Promise((resolve, reject) => {
      settle = fails ? () => reject(new Error('decode failed')) : () => resolve({ status: 'measured' });
    }) } });
    const run = snap(fails ? 'failed-analysis' : 'successful-analysis');
    builder._beginRun('record', { runSnapshot: run });
    assert.equal(builder.isReportPending(), false);
    const pending = builder._handleRecordingCompleted({ runSnapshot: run, blob: new Blob(['audio']) });
    assert.equal(builder.isReportPending(), true);
    // A metrics event does not mean the awaiting report consumer has finished.
    builder._onDeepAnalysisReady({ runId: run.runId, status: 'measured' });
    assert.equal(builder.isReportPending(), true);
    const published = new Promise(resolve => {
      const off = eventBus.on(EVENTS.DIAGNOSTIC_REPORT_READY, report => {
        off();
        resolve({ report, wasPending: builder.isReportPending() });
      });
    });
    settle();
    await pending;
    assert.equal(builder.isReportPending(), true, 'scheduled report is still pending after PCM settles');
    const result = await published;
    assert.equal(result.wasPending, false);
    assert.equal(builder.isReportPending(), false);
    assert.equal(result.report.deepAnalysis.status, fails ? 'failed' : 'measured');
  }
});

test('old analysis cannot clear a newer pending report and cancellation releases ownership', async t => {
  t.after(() => builder._resetRunState());
  const completions = new Map();
  builder.init({ deepAnalysisEngine: { cancel() {}, analyze: (_blob, { runId }) => new Promise(resolve => {
    completions.set(runId, resolve);
  }) } });
  const a = snap('pending-A');
  const b = snap('pending-B');
  builder._beginRun('record', { runSnapshot: a });
  const pendingA = builder._handleRecordingCompleted({ runSnapshot: a });
  assert.equal(builder.isReportPending(), true);
  builder._beginRun('record', { runSnapshot: b });
  assert.equal(builder.isReportPending(), false);
  const pendingB = builder._handleRecordingCompleted({ runSnapshot: b });
  assert.equal(builder.isReportPending(), true);
  completions.get(a.runId)({ status: 'measured' });
  await pendingA;
  assert.equal(builder.isReportPending(), true);
  builder._resetRunState();
  assert.equal(builder.isReportPending(), false);
  completions.get(b.runId)({ status: 'measured' });
  await pendingB;
  assert.equal(builder.isReportPending(), false);
  assert.equal(builder._reportTimerId, null);
});

test('call finalization is pending until its report is published or the test is cancelled', async t => {
  t.after(() => builder._resetRunState());
  const run = snap('pending-call');
  builder._beginRun('test', { runSnapshot: run });
  builder._handleTestRecordingStopped({ runSnapshot: run });
  assert.equal(builder.isReportPending(), true);
  const published = new Promise(resolve => {
    const off = eventBus.on(EVENTS.DIAGNOSTIC_REPORT_READY, () => { off(); resolve(); });
  });
  builder._handleTestCompleted({ runSnapshot: run, analysis: { status: 'measured' } });
  assert.equal(builder.isReportPending(), true);
  await published;
  assert.equal(builder.isReportPending(), false);
  const cancelled = snap('cancelled-call');
  builder._beginRun('test', { runSnapshot: cancelled });
  builder._handleTestRecordingStopped({ runSnapshot: cancelled });
  assert.equal(builder.isReportPending(), true);
  builder._handleTestCancelled({ runSnapshot: cancelled });
  assert.equal(builder.isReportPending(), false);
});
