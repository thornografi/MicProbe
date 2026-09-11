import test from 'node:test';
import assert from 'node:assert/strict';
import { getConstraintMismatches, projectCaptureContext } from '../modules/CaptureContext.js';
import { projectReviewReport } from '../modules/ReviewEvidence.js';
import { formatReportScope } from '../modules/MeasurementValue.js';
import { evaluateIndependentReport } from '../../server/independent-report.js';
import { createNodeAccountDb } from '../../server/node-account-db.mjs';
import { AccountStore } from '../../server/account-store.mjs';
import { reviewReport } from './review-fixtures.mjs';

const environment = (os = 'windows') => ({ version: 1, os, osSource: 'browser-hint', browser: 'chrome',
  browserMajor: 145, formFactor: 'desktop', formFactorSource: 'browser-hint' });
const normalSignal = { rmsDb: -25, peakDb: -10, maxBlockRmsDb: -20, maxBlockRmsStatus: 'measured', maxBlockRmsWindowMs: 10 };
const recommendations = report => evaluateIndependentReport(report).detailed.recommendations;
const text = item => [item?.reason, item?.action, ...(item?.steps || []), item?.expected, item?.evidence].filter(Boolean).join(' ');
const observationIds = ['TAB_HIDDEN', 'TIMING_VARIATION', 'LOCAL_CONCEALMENT'];
const observationItems = report => recommendations(report).filter(item => observationIds.includes(item.id));

function capturedReport(runId = 'context-run', patch) {
  return { ...reviewReport(runId, patch), environment: environment(), captureContext: { capabilities: {
    sampleRateRange: { min: 44100, max: 48000 }, channelCountRange: { min: 1, max: 2 },
    ecSupported: [true, false], nsSupported: [false], agcSupported: [true, false]
  } } };
}

function systemEvidence(runId) {
  return { runId, tabWasHidden: true, mainThreadJitter: { supported: true, sampleCount: 120, spikeCount: 3 },
    network: { concealedSamples: 960, concealmentRatio: 0.002 } };
}

test('requested/applied differences use known capture settings, preserve false and ignore missing values', () => {
  const profile = {
    requestedConstraints: { sampleRate: 44100, channelCount: 2, echoCancellation: true, noiseSuppression: false, autoGainControl: true, deviceId: 'private' },
    appliedConstraints: { sampleRate: 48000, channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: null, deviceId: 'different' }
  };
  const before = structuredClone(profile);
  assert.deepEqual(getConstraintMismatches(profile), [
    { key: 'sampleRate', requested: 44100, applied: 48000 },
    { key: 'channelCount', requested: 2, applied: 1 },
    { key: 'echoCancellation', requested: true, applied: false },
    { key: 'noiseSuppression', requested: false, applied: true }
  ]);
  assert.deepEqual(profile, before);
  assert.deepEqual(getConstraintMismatches({ requestedConstraints: { autoGainControl: false }, appliedConstraints: {} }), []);
  assert.deepEqual(getConstraintMismatches({ requestedConstraints: { autoGainControl: 'false', sampleRate: -1 },
    appliedConstraints: { autoGainControl: true, sampleRate: 48000 } }), []);
});

test('legacy differences are validated and cannot override available requested/applied settings', () => {
  const valid = { key: 'echoCancellation', requested: true, applied: false };
  const legacy = [valid, { key: 'deviceId', requested: 'private', applied: 'other' },
    { key: 'autoGainControl', requested: 'true', applied: false }, { key: 'sampleRate', requested: -1, applied: 48000 },
    { key: 'channelCount', requested: 1, applied: 1 }];
  assert.deepEqual(getConstraintMismatches({ constraintMismatches: legacy }), [valid]);
  assert.deepEqual(getConstraintMismatches({ requestedConstraints: { echoCancellation: false },
    appliedConstraints: { echoCancellation: false }, constraintMismatches: legacy }), []);
  const report = capturedReport(); report.profile.constraintMismatches = legacy;
  for (const candidate of [report, projectReviewReport(report)]) {
    const mismatch = recommendations(candidate).find(item => item.id === 'SETTINGS_NOT_APPLIED');
    assert.ok(mismatch); assert.match(text(mismatch), /echo cancellation false instead of true/);
    assert.doesNotMatch(text(mismatch), /private|deviceId/);
  }
});

test('an absent or malformed optional profile does not erase valid measurements', () => {
  for (const profile of [undefined, null, [], 'unknown']) {
    const report = capturedReport(); report.profile = profile;
    assert.deepEqual(getConstraintMismatches(profile), []);
    for (const candidate of [report, projectReviewReport(report)]) {
      const result = evaluateIndependentReport(candidate);
      assert.equal(result.public.summary, 'The recording has a low sound level.');
      assert.ok(!result.detailed.recommendations.some(item => item.id === 'SETTINGS_NOT_APPLIED'));
    }
  }
});

test('context projection retains actionable capabilities and observations while dropping inventories and logs', () => {
  const report = capturedReport(); report.run.type = 'test'; report.system = systemEvidence(report.run.id);
  report.captureContext.deviceLabel = 'private-device';
  report.captureContext.capabilities.deviceId = 'private-id';
  report.captureContext.osInputLevel = { value: 'private-unverified' };
  report.system.env = { hardwareConcurrency: 16, deviceMemoryGB: 8, userAgent: 'private-user-agent' };
  report.system.logs = ['private-log']; report.device = { micName: 'private-microphone' };
  const before = structuredClone(report), projected = projectReviewReport(report), context = projectCaptureContext(report);
  assert.deepEqual(projected.captureContext, context.captureContext);
  assert.deepEqual(projected.system, context.system);
  assert.deepEqual(projected.captureContext.capabilities.sampleRateRange, { min: 44100, max: 48000 });
  assert.deepEqual(projected.captureContext.capabilities.nsSupported, [false]);
  assert.deepEqual(projected.system, systemEvidence(report.run.id));
  assert.doesNotMatch(JSON.stringify(projected), /private-|hardwareConcurrency|deviceMemoryGB/);
  assert.deepEqual(report, before);
});

test('malformed capability values and observations do not survive projection as evidence', () => {
  const report = capturedReport(); report.captureContext.capabilities = {
    sampleRateRange: { min: 48000, max: 44100 }, channelCountRange: { min: -1, max: Infinity },
    ecSupported: ['false'], nsSupported: 'false', agcSupported: { value: true }
  };
  report.system = { runId: report.run.id, tabWasHidden: 'true',
    mainThreadJitter: { supported: true, sampleCount: -1, spikeCount: Infinity },
    network: { concealedSamples: -960, concealmentRatio: 2 } };
  const projected = projectReviewReport(report), caps = projected.captureContext?.capabilities || {};
  for (const key of ['sampleRateRange', 'channelCountRange', 'ecSupported', 'nsSupported', 'agcSupported']) {
    assert.ok(caps[key] == null, `${key} must remain unknown`);
  }
  assert.deepEqual(observationItems(report), []);
  assert.deepEqual(observationItems(projected), []);
});

test('unsupported capture requests explain the device limit consistently in full and projected reports', () => {
  const report = capturedReport(); report.profile.requestedConstraints = { noiseSuppression: true, sampleRate: 96000 };
  for (const candidate of [report, projectReviewReport(report)]) {
    const result = evaluateIndependentReport(candidate);
    const mismatch = result.detailed.recommendations.find(item => item.id === 'SETTINGS_NOT_APPLIED');
    assert.ok(mismatch);
    assert.match(text(mismatch), /noise suppression.*false.*true/i);
    assert.match(text(mismatch), /support|available|capabilit/i);
    assert.doesNotMatch(mismatch.action, /change the device or its system format/i);
    assert.equal(result.detailed.metrics.find(item => item.key === 'appliedSettings').rating, 'fair');
  }
  delete report.captureContext;
  for (const candidate of [report, projectReviewReport(report)]) {
    const mismatch = recommendations(candidate).find(item => item.id === 'SETTINGS_NOT_APPLIED');
    assert.ok(mismatch);
    assert.doesNotMatch(text(mismatch), /did not report support|cannot enable an unsupported/i,
      'A missing capabilities report does not establish a device limit');
  }
});

test('saved capture OS selects local instructions without a troubleshooting questionnaire', () => {
  for (const [os, expected, excluded] of [['windows', /Windows Settings/, /Apple menu/], ['macos', /Apple menu/, /Windows Settings/]]) {
    const report = capturedReport(); report.environment = environment(os);
    for (const candidate of [report, projectReviewReport(report)]) {
      const guide = recommendations(candidate).find(item => item.id === (os === 'windows' ? 'GUIDE_WINDOWS_RECORDED_INPUT' : 'GUIDE_MACOS_RECORDED_INPUT'));
      assert.ok(guide, `${os} guidance must survive transport`);
      assert.match(text(guide), expected); assert.doesNotMatch(text(guide), excluded);
    }
  }
});

test('OS and browser information change applicable instructions without changing recording quality', () => {
  const report = capturedReport(), baseline = evaluateIndependentReport(report).public;
  for (const [os, browser, browserMajor] of [['macos', 'safari', 26], ['windows', 'edge', 146],
    ['android', 'chrome', 145], ['unknown', 'unknown', null]]) {
    report.environment = { ...environment(os), browser, browserMajor };
    for (const candidate of [report, projectReviewReport(report)]) {
      const result = evaluateIndependentReport(candidate);
      assert.deepEqual(result.public.overall, baseline.overall);
      assert.equal(result.public.summary, baseline.summary);
    }
  }
});

test('canonical capture environment wins over stale local hints and missing environment stays unknown', () => {
  const report = capturedReport(); report.troubleshooting = { version: 1, os: 'macos', osSource: 'browser-hint',
    app: 'unknown', client: 'unknown', symptom: 'unknown', scope: 'unknown', trigger: 'unknown' };
  assert.ok(recommendations(report).some(item => item.id === 'GUIDE_WINDOWS_RECORDED_INPUT'));
  assert.ok(!recommendations(report).some(item => item.id === 'GUIDE_MACOS_RECORDED_INPUT'));
  delete report.environment;
  assert.ok(recommendations(report).some(item => item.id === 'GUIDE_MACOS_RECORDED_INPUT'), 'Legacy saved hints remain usable');
  report.environment = environment('unknown');
  assert.ok(!recommendations(report).some(item => /^GUIDE_(WINDOWS|MACOS)_RECORDED_INPUT$/.test(item.id)),
    'Explicitly unknown capture OS must not inherit a legacy hint');
  delete report.environment;
  delete report.troubleshooting;
  for (const candidate of [report, projectReviewReport(report)]) {
    assert.ok(!recommendations(candidate).some(item => /^GUIDE_(WINDOWS|MACOS)_RECORDED_INPUT$/.test(item.id)));
  }
});

test('active AGC changes input guidance but absent AGC is not described as disabled', () => {
  const report = capturedReport(); report.profile.appliedConstraints.autoGainControl = true;
  for (const candidate of [report, projectReviewReport(report)]) {
    const recs = recommendations(candidate), guide = recs.find(item => item.id === 'GUIDE_WINDOWS_RECORDED_INPUT');
    assert.ok(guide); assert.match(text(guide), /automatic|managed/i);
    assert.ok(recs.some(item => item.id === 'AGC_SYSTEM_LEVEL'));
  }
  delete report.profile.appliedConstraints.autoGainControl;
  for (const candidate of [report, projectReviewReport(report)]) {
    const recs = recommendations(candidate);
    assert.ok(!recs.some(item => item.id === 'AGC_SYSTEM_LEVEL'));
    assert.doesNotMatch(recs.map(text).join(' '), /automatic gain control (?:was |is )?(?:off|disabled)|AGC (?:was |is )?(?:off|disabled)/i);
  }
});

test('legacy applied constraints retain AGC and requested-setting differences through projection', () => {
  const report = capturedReport();
  report.profile.constraints = { ...report.profile.appliedConstraints, autoGainControl: true };
  report.profile.requestedConstraints = { autoGainControl: false };
  delete report.profile.appliedConstraints;
  for (const appliedConstraints of [undefined, null]) {
    report.profile.appliedConstraints = appliedConstraints;
    for (const candidate of [report, projectReviewReport(report)]) {
      const recs = recommendations(candidate);
      assert.match(text(recs.find(item => item.id === 'SETTINGS_NOT_APPLIED')), /automatic gain control true instead of false/);
      assert.ok(recs.some(item => item.id === 'AGC_SYSTEM_LEVEL'));
      assert.match(text(recs.find(item => item.id === 'GUIDE_WINDOWS_RECORDED_INPUT')), /automatic|managed/i);
    }
  }
  report.profile.appliedConstraints = { autoGainControl: false };
  for (const candidate of [report, projectReviewReport(report)]) {
    const recs = recommendations(candidate);
    assert.ok(!recs.some(item => ['AGC_SYSTEM_LEVEL', 'SETTINGS_NOT_APPLIED'].includes(item.id)),
      'Present applied constraints take priority over the legacy alias');
  }
  report.profile.appliedConstraints = null;
  for (const constraints of [null, [], 'unknown']) {
    report.profile.constraints = constraints;
    for (const candidate of [report, projectReviewReport(report)]) {
      const recs = recommendations(candidate);
      assert.ok(!recs.some(item => ['AGC_SYSTEM_LEVEL', 'SETTINGS_NOT_APPLIED'].includes(item.id)));
    }
  }
});

test('independent scope remains coherent text for new and legacy evaluations', () => {
  const report = capturedReport();
  const current = evaluateIndependentReport(report), legacy = evaluateIndependentReport(report, undefined, { legacy: true });
  for (const result of [current, legacy]) {
    assert.equal(typeof result.public.scope, 'string');
    assert.equal(result.detailed.summary.scope, result.public.scope);
    assert.match(result.public.scope, /recording|recorded|audio/i);
    assert.ok(result.public.scope.length > 20);
  }
  assert.ok(legacy.public.scope.startsWith(current.public.scope));
  assert.match(legacy.public.scope, /prepared when it was reopened/);
  assert.doesNotMatch(current.public.scope, /prepared when it was reopened/);
});

test('scope presentation repairs accepted legacy arrays without changing their saved values', () => {
  const scope = 'Only this recording was measured.', legacy = 'Details were prepared when it was reopened.';
  for (const [input, expected] of [[scope, scope], [[...scope], scope],
    [[...scope, legacy], `${scope} ${legacy}`], [[scope, legacy], `${scope} ${legacy}`],
    [[], ''], [null, ''], [{ scope }, ''], [[scope, null], '']]) {
    const accepted = { public: { scope: input } }, before = structuredClone(accepted);
    if (Array.isArray(input)) Object.freeze(input);
    Object.freeze(accepted.public); Object.freeze(accepted);
    assert.equal(formatReportScope(accepted.public.scope), expected);
    assert.deepEqual(accepted, before, 'Rendering an accepted evaluation must not rewrite its scope');
  }
});

test('runtime observations survive transport without lowering the measured result or asserting a cause', () => {
  const report = capturedReport('observed-test', { signal: normalSignal }); report.run.type = 'test';
  const baseline = evaluateIndependentReport(report).public; report.system = systemEvidence(report.run.id);
  for (const tabWasHidden of [false, true]) {
    report.system.tabWasHidden = tabWasHidden;
    for (const candidate of [report, projectReviewReport(report)]) {
      const result = evaluateIndependentReport(candidate);
      const items = result.detailed.recommendations.filter(item => observationIds.includes(item.id));
      const timingId = tabWasHidden ? 'TAB_HIDDEN' : 'TIMING_VARIATION';
      assert.deepEqual(items.map(item => item.id).sort(), ['LOCAL_CONCEALMENT', timingId].sort());
      for (const item of items) { assert.equal(item.severity, 'info'); assert.equal(item.category, 'observation'); }
      assert.deepEqual(result.public.overall, baseline.overall); assert.equal(result.public.summary, baseline.summary);
      assert.match(text(items.find(item => item.id === timingId)), /does not|do not|cannot|not reliable/i);
      assert.match(text(items.find(item => item.id === 'LOCAL_CONCEALMENT')), /local/i);
      assert.doesNotMatch(items.map(text).join(' '), /CPU caused|network caused|internet (?:is |was )?(?:bad|slow|poor)/i);
    }
  }
});

test('different-run, unbound, unsupported and zero timing samples cannot drive observations', () => {
  const report = capturedReport('bound-test', { signal: normalSignal }); report.run.type = 'test';
  for (const runId of ['other-run', null, undefined, '']) {
    report.system = systemEvidence(runId);
    assert.deepEqual(observationItems(report), []);
    assert.deepEqual(observationItems(projectReviewReport(report)), []);
    assert.deepEqual(projectCaptureContext(report).system || {}, {});
  }
  for (const timing of [{ supported: false, sampleCount: 120, spikeCount: 3 },
    { supported: true, sampleCount: 0, spikeCount: 3 }, { supported: true, sampleCount: 120, spikeCount: 0 }]) {
    report.system = { runId: report.run.id, tabWasHidden: false, mainThreadJitter: timing };
    assert.deepEqual(observationItems(report), []); assert.deepEqual(observationItems(projectReviewReport(report)), []);
  }
});

test('local transport concealment is not interpreted as recording or actual-app network evidence', () => {
  const report = capturedReport('record-with-stale-network', { signal: normalSignal });
  report.system = { runId: report.run.id, network: { concealedSamples: 960, concealmentRatio: 0.002 } };
  for (const candidate of [report, projectReviewReport(report)]) assert.deepEqual(observationItems(candidate), []);
  report.run.type = 'test';
  for (const candidate of [report, projectReviewReport(report)]) {
    const item = observationItems(candidate).find(entry => entry.id === 'LOCAL_CONCEALMENT');
    assert.ok(item); assert.match(text(item), /not|cannot/i);
  }
});

test('additional capture context never turns simultaneous peaks or near silence into a gain-increase recommendation', () => {
  const peak = capturedReport('peaks', { signal: { rmsDb: -50, peakDb: 0 },
    lufs: { status: 'measured', integratedStatus: 'measured', integrated: -48 },
    clipping: { status: 'measured', method: 'sample-saturation', rate: 0.01 } });
  const silent = capturedReport('near-silence', { signal: { rmsDb: -150, peakDb: -150 } });
  for (const report of [peak, silent]) {
    report.profile.appliedConstraints.autoGainControl = true;
    report.system = systemEvidence(report.run.id);
    for (const candidate of [report, projectReviewReport(report)]) {
      const recs = recommendations(candidate), low = recs.find(item => item.id === 'LOW_RECORDED_LEVEL');
      assert.ok(low); assert.match(low.action, report === peak ? /could worsen/ : /not.*justify increasing gain/i);
      assert.doesNotMatch(recs.map(text).join(' '), /(?:step|then|try to|you should) increase (?:the |your |input )?(?:gain|level)/i);
      if (report === silent) assert.ok(!recs.some(item => /^GUIDE_(WINDOWS|MACOS)_RECORDED_INPUT$/.test(item.id)));
    }
  }
});

test('accepted archive instructions preserve the capture environment and observations after edits and retries', async t => {
  const db = createNodeAccountDb(':memory:'); t.after(() => db.close());
  const store = new AccountStore(db, 'sandbox');
  const user = await store.upsertUser({ sub: 'capture-context-owner', email: 'context@example.com', name: 'Context Owner' });
  await store.saveLicense(user.id, { licenseId: 'context-license', freemiusUserId: '1', active: true, verifiedAt: Date.now() });
  const report = capturedReport('archived-context'); report.run.accountOwnerId = user.id;
  report.system = systemEvidence(report.run.id); report.profile.appliedConstraints.autoGainControl = true;
  const accepted = await store.saveReport(user.id, report, 'First note');
  assert.ok(accepted.evaluation.detailed.recommendations.some(item => item.id === 'TAB_HIDDEN'));
  assert.ok(accepted.evaluation.detailed.recommendations.some(item => item.id === 'GUIDE_WINDOWS_RECORDED_INPUT'));
  const changed = structuredClone(report); changed.environment = environment('macos');
  changed.system.tabWasHidden = false; changed.profile.appliedConstraints.autoGainControl = false;
  assert.deepEqual((await store.saveReport(user.id, changed, 'Retry note')).evaluation, accepted.evaluation);
  await store.updateReportNote(user.id, accepted.id, 'Edited note');
  const reopened = await store.getReport(user.id, accepted.id);
  assert.equal(reopened.note, 'Edited note'); assert.deepEqual(reopened.evaluation, accepted.evaluation);
  assert.deepEqual(reopened.report.environment, report.environment);
});
