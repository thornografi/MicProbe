import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPlatformExpectations, validReference } from '../../server/platform-expectations.js';
import { evaluateReview } from '../../server/review-evaluator.js';
import { evaluatePremiumReport } from '../../server/premium-report-evaluator.js';
import evaluator from '../modules/ReportEvaluator.js';
import { PROFILES } from '../modules/Config.js';
import { PLATFORM_REFERENCE_VERSION, PLATFORM_TARGETS, capturePlatformRuntime } from '../modules/PlatformContext.js';
import { projectReviewReport } from '../modules/ReviewEvidence.js';
import { createRunSnapshot } from '../modules/RunSnapshot.js';
import builder from '../modules/DiagnosticReportBuilder.js';
import { reviewReport } from './review-fixtures.mjs';

import { platformReferenceFixture as fixture } from './platform-reference-fixtures.mjs';

test('all current profiles retain their catalog version; technical observations are not quality calibration', () => {
  assert.deepEqual(Object.keys(PROFILES).sort(), Object.keys(PLATFORM_TARGETS).sort());
  for (const profile of Object.values(PROFILES)) {
    const snapshot = createRunSnapshot({ profile });
    assert.equal(snapshot.profileReferenceVersion, PLATFORM_REFERENCE_VERSION);
    builder._runSnapshot = snapshot;
    const report = reviewReport(); report.profile = builder._buildProfile();
    const assessment = assessPlatformExpectations(report);
    assert.equal(assessment.status, PLATFORM_TARGETS[profile.id].platform ? 'unverified' : 'not-applicable', profile.id);
    assert.deepEqual(assessment.comparisons, []);
  }
  builder._resetRunState();
  assert.equal(PLATFORM_TARGETS['zoom-hifi'].platform, null, 'legacy ID is not proof of a Zoom target');
});

test('expected behavior preserves the fact, removes corrective advice and does not sell a personal diagnosis', () => {
  const { report, catalogs } = fixture(), original = structuredClone(report);
  const decision = evaluateReview(report, { answers: { sameProblem: 'yes' } }, catalogs);
  assert.equal(decision.reason, 'expected-platform-behavior'); assert.equal(decision.status, 'SUMMARY');
  assert.equal(decision.eligible, false); assert.equal(decision.next, null); assert.equal(decision.question, null);
  assert.equal(decision.observations[0].expectation, 'within-reference');
  assert.match(decision.observations[0].text, /low level/);
  assert.equal(decision.platform.hasDeviation, false);
  const free = evaluator.evaluateFree(report, decision.platform);
  assert.equal(free.overall.color, 'muted'); assert.match(free.summary, /within the validated/);
  assert.ok(free.findings.every(item => item.severity === 'info'));
  assert.doesNotMatch(free.summary, /change|adjust|buy|upgrade/i);
  const premium = evaluatePremiumReport(report, catalogs);
  assert.equal(premium.recommendations.find(item => item.id === 'LOW_RECORDED_LEVEL').action, '');
  assert.equal(premium.recommendations.find(item => item.id === 'LOCAL_TEST_SCOPE').action, '');
  assert.ok(premium.metrics.some(item => item.key === 'reference:signal.maxBlockRmsDb'));
  assert.deepEqual(report, original);
  assert.equal(evaluateReview(projectReviewReport(report), {}, catalogs).reason, decision.reason, 'guest transport preserves applicability');
});

test('a platform deviation is visible even when generic recording thresholds produce no warning', () => {
  const { report, catalogs } = fixture();
  report.audioMetrics.signal = { rmsDb: -28, peakDb: -10, maxBlockRmsDb: -20, maxBlockRmsStatus: 'measured', maxBlockRmsWindowMs: 10 };
  const decision = evaluateReview(report, {}, catalogs);
  assert.equal(decision.reason, 'platform-deviation'); assert.equal(decision.eligible, true);
  assert.equal(decision.next, null); assert.equal(decision.question, null);
  assert.match(decision.observations[0].text, /above/); assert.equal(decision.platform.hasDeviation, true);
  assert.match(evaluator.evaluateFree(report, decision.platform).summary, /outside/);
  assert.ok(decision.blockedClaims.includes('physical-root-cause'));
});

test('an expected characteristic never hides an independent anomaly or excuses near silence', () => {
  const { report, catalogs, reference } = fixture();
  report.audioMetrics.clipping.rate = 0.01;
  let decision = evaluateReview(report, { answers: { sameProblem: 'yes' } }, catalogs);
  assert.equal(decision.next.id, 'headroom');
  assert.equal(evaluator.evaluateFree(report, decision.platform).findings.find(item => item.id === 'CLIPPING').severity, 'warning');
  report.audioMetrics.clipping.rate = 0;
  report.audioMetrics.signal = { rmsDb: -80, peakDb: -65, maxBlockRmsDb: -70, maxBlockRmsStatus: 'measured', maxBlockRmsWindowMs: 10 };
  reference.ranges[0].min = -90;
  decision = evaluateReview(report, {}, catalogs);
  assert.equal(decision.question.id, 'spoke'); assert.deepEqual(decision.platform.expectedFindingIds, []);
});

test('all supporting measurements must match before a compound level finding is expected', () => {
  const { report, catalogs } = fixture();
  report.audioMetrics.lufs = { status: 'measured', integratedStatus: 'measured', integrated: -48 };
  const decision = evaluateReview(report, { answers: { sameProblem: 'yes' } }, catalogs);
  assert.equal(decision.next.id, 'inputLevel'); assert.deepEqual(decision.platform.expectedFindingIds, []);
});

test('expected noise cannot hide unexpected SNR and an expected peak cannot permit raising input level', () => {
  const { report, reference, catalogs } = fixture();
  report.audioMetrics.guidedNoise = { status: 'measured', method: 'user-guided-file-segments' };
  report.audioMetrics.noiseFloor = { status: 'measured', method: 'guided-quiet-segment', estimatedDb: -25 };
  report.audioMetrics.snr = { status: 'measured', method: 'guided-power-subtraction', estimatedDb: 5 };
  report.audioMetrics.signal = { rmsDb: -24, peakDb: -10, maxBlockRmsDb: -20, maxBlockRmsStatus: 'measured', maxBlockRmsWindowMs: 10 };
  reference.ranges = [{ path: 'noiseFloor.estimatedDb', min: -28, max: -22, unit: 'dBFS' }];
  reference.expectedFindings = ['MEASURED_NOISE'];
  const decision = evaluateReview(report, { answers: { sameProblem: 'yes' } }, catalogs);
  const free = evaluator.evaluateFree(report, decision.platform);
  assert.equal(free.findings.find(item => item.id === 'LOW_SNR').severity, 'warning');
  assert.equal(free.findings.find(item => item.id === 'HIGH_NOISE').severity, 'info');
  const peak = fixture(); peak.report.audioMetrics.clipping.rate = 0.01;
  peak.reference.ranges = [{ path: 'clipping.rate', min: 0, max: 0.02, unit: 'ratio' }];
  peak.reference.expectedFindings = ['FULL_SCALE_SAMPLES'];
  assert.equal(evaluateReview(peak.report, { answers: { sameProblem: 'yes' } }, peak.catalogs).next, null);
});

test('wrong mode, missing local validation, mismatched processing, codec, duration or method cannot establish normality', () => {
  const changes = [
    f => { f.reference.scope.mode = 'voice-call'; },
    f => { f.reference.scope.client = 'unknown'; },
    f => { f.reference.evidence.localArtifact = null; },
    f => { f.reference.evidence.status = 'observed'; },
    f => { f.report.profile.appliedConstraints.autoGainControl = true; },
    f => { f.report.profile.appliedConstraints.noiseSuppression = null; },
    f => { f.report.profile.runtime.majorVersion++; },
    f => { f.report.profile.runtime.browser = 'firefox'; },
    f => { f.report.profile.runtime.formFactor = 'mobile'; },
    f => { f.report.recording.mimeType = 'audio/ogg'; },
    f => { f.report.audioMetrics.sampleRate = 44100; },
    f => { f.report.audioMetrics.durationMs = 5000; },
    f => { f.report.audioMetrics.coverage.truncated = true; },
    f => { f.report.audioMetrics.signal.maxBlockRmsWindowMs = 20; },
    f => { f.report.profile.referenceVersion = 'unknown-version'; },
    f => { f.report.generatedAt = '2026-10-02'; },
    f => { f.report.generatedAt = '2026-08-31'; }
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    const decision = evaluateReview(f.report, {}, f.catalogs);
    assert.deepEqual(decision.platform.expectedFindingIds, [], change.toString());
    assert.notEqual(decision.reason, 'expected-platform-behavior', change.toString());
  }
});

test('conflicting references and malformed or unsupported metrics fail closed without taking away local facts', () => {
  const f = fixture();
  const other = structuredClone(f.reference); other.id = 'conflict'; other.ranges[0].max = -40;
  f.catalogs['fixture-v1'].references.push(other);
  assert.equal(evaluateReview(f.report, {}, f.catalogs).platform.reason, 'conflicting-references');
  for (const ranges of [[{ path: 'inventedQuality', min: 0, max: 100, unit: 'score' }], [{ path: 'clipping.rate', min: -1, max: 2, unit: 'ratio' }], {}]) {
    assert.equal(validReference({ ...f.reference, ranges }, f.target), false);
  }
});

test('published catalog updates cannot silently reclassify a saved report; unknown history stays unknown', () => {
  const { report, reference, catalogs, target } = fixture();
  catalogs['fixture-v2'] = { targets: { 'fixture-platform': target }, references: [{ ...reference, ranges: [{ path: 'signal.maxBlockRmsDb', min: -35, max: -20, unit: 'dBFS' }] }] };
  assert.equal(evaluateReview(report, {}, catalogs).reason, 'expected-platform-behavior');
  report.profile.referenceVersion = 'fixture-v2';
  assert.equal(evaluateReview(report, {}, catalogs).platform.hasDeviation, true);
  delete report.profile.referenceVersion;
  assert.equal(evaluateReview(report, {}, catalogs).platform.reason, 'reference-version-unavailable');
});

test('only scalar test facts cross the review boundary, never reference rules, platform claims or audio', () => {
  const { report } = fixture();
  report.profile.evidence = { summary: 'invented platform behavior' };
  report.profile.expectedFindings = ['LOW_RECORDED_LEVEL'];
  report.platformAssessment = { expectedFindings: ['LOW_RECORDED_LEVEL'] };
  report.recording.audio = 'private audio';
  report.loopback = { senderCodec: { mimeType: 'audio/opus', secret: 'private' }, receiverCodec: { mimeType: 'audio/opus' }, requestedOpus: { dtx: true, fec: false } };
  const packet = projectReviewReport(report);
  assert.equal(packet.loopback.senderCodec.mimeType, 'audio/opus');
  assert.equal(packet.profile.referenceVersion, 'fixture-v1');
  assert.doesNotMatch(JSON.stringify(packet), /invented|private|expectedFindings|platformAssessment/);
});

test('local runtime is frozen before capture; browser hints never identify the target app client', () => {
  for (const [ua, browser, major] of [['Chrome/140.0 Safari/537.36 Edg/141.0', 'edge', 141],
    ['Chrome/140.0 Safari/537.36 OPR/125.0', 'opera', 125], ['Chrome/140.0 Safari/537.36', 'chrome', 140],
    ['Firefox/140.0', 'firefox', 140], ['Version/19.1 Safari/605.1.15', 'safari', 19], ['Unclassified/1', 'unknown', null]]) {
    const runtime = capturePlatformRuntime({ userAgent: ua, platform: 'Win32' }, 'desktop');
    assert.equal(runtime.browser, browser); assert.equal(runtime.majorVersion, major);
  }
  const navigator = { userAgent: 'Mozilla Windows NT Chrome/140.0', platform: 'Win32' };
  const snapshot = createRunSnapshot({ profile: PROFILES.teams, navigator });
  navigator.userAgent = 'Firefox/150.0';
  assert.equal(snapshot.captureRuntime.browser, 'chrome');
  assert.equal(snapshot.captureRuntime.majorVersion, 140);
  assert.equal(PLATFORM_TARGETS.teams.client, 'unknown');
});

test('call references require the actual codec observations and the additional file-encoding conditions', () => {
  const { report, reference, catalogs } = fixture();
  report.run.type = 'test'; report.profile.encoder = null;
  report.recording = { mimeType: 'audio/webm;codecs=opus', encoderReportedBitrate: 128000 };
  report.loopback = { senderCodec: { mimeType: 'audio/opus' }, receiverCodec: { mimeType: 'audio/opus' },
    requestedBitrate: 32000, requestedOpus: { dtx: true, fec: false } };
  delete reference.conditions['profile.encoder']; delete reference.conditions['recording.bitrateMode'];
  Object.assign(reference.conditions, { 'run.type': 'test', 'recording.mimeType': report.recording.mimeType,
    'recording.encoderReportedBitrate': 128000, 'loopback.senderCodec.mimeType': 'audio/opus', 'loopback.receiverCodec.mimeType': 'audio/opus',
    'loopback.requestedBitrate': 32000, 'loopback.requestedOpus.dtx': true, 'loopback.requestedOpus.fec': false });
  assert.equal(evaluateReview(projectReviewReport(report), {}, catalogs).reason, 'expected-platform-behavior');
  for (const mutate of [r => { r.loopback.senderCodec = {}; }, r => { r.recording.encoderReportedBitrate = 64000; },
    r => { r.loopback.requestedOpus.dtx = null; }, r => { r.recording.mimeType = 'audio/ogg'; }]) {
    const changed = structuredClone(report); mutate(changed);
    assert.equal(evaluateReview(changed, {}, catalogs).platform.status, 'unavailable');
  }
});
