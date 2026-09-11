import test from 'node:test';
import assert from 'node:assert/strict';
import { captureEnvironment, normalizeEnvironment, UNKNOWN_ENVIRONMENT } from '../modules/EnvironmentContext.js';
import { createRunSnapshot } from '../modules/RunSnapshot.js';
import { projectReviewReport } from '../modules/ReviewEvidence.js';
import { captureErrorMessage } from '../modules/InputGuidance.js';
import builder from '../modules/DiagnosticReportBuilder.js';
import { evaluateReview, compareReviewReports } from '../../server/review-evaluator.js';
import { reviewReport } from './review-fixtures.mjs';

const windows = captureEnvironment({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/145.0.0.0', platform: 'Win32' });
function report(os = 'windows', normal = false) {
  const r = reviewReport('environment-run', normal ? { signal: { rmsDb: -25, peakDb: -10 } } : {});
  r.environment = { ...windows, os };
  return r;
}
const recordAttempt = (state, decision, outcome = 'unchanged') => {
  const { id: actionId, contextKey, target, changes } = decision.next;
  (state.attempts ||= []).push({ actionId, contextKey, target, changes, outcome });
};

test('browser variants distinguish iOS brands, Edge, Samsung and TV without collecting identifiers', () => {
  for (const [userAgent, browser, os] of [
    ['(iPhone) AppleWebKit/605 CriOS/145.0 Mobile Safari/604', 'chrome', 'ios'],
    ['(iPhone) AppleWebKit/605 FxiOS/140.0 Mobile Safari/604', 'firefox', 'ios'],
    ['(iPhone) EdgiOS/145.0 Mobile Safari/604', 'edge', 'ios'],
    ['(Linux; Android 15) Chrome/145.0 EdgA/145.0', 'edge', 'android'],
    ['(Linux; Android 15) Chrome/145.0 SamsungBrowser/28.0', 'samsung', 'android'],
    ['(Windows NT 10.0) Chrome/145.0 OPR/120.0', 'opera', 'windows'],
    ['(Macintosh) Version/26.0 Safari/605', 'safari', 'macos'],
    ['Android TV Chrome/145.0', 'unknown', 'unknown']
  ]) { const e = captureEnvironment({ userAgent }); assert.equal(e.browser, browser); assert.equal(e.os, os); }
  assert.equal(windows.browserMajor, 145); assert.equal(windows.osVersion, undefined);
  const chromium = { userAgent: 'Chrome/145.0', userAgentData: { brands: [{ brand: 'Chromium', version: '145' }] } };
  assert.equal(captureEnvironment(chromium).browser, 'unknown');
  chromium.userAgentData.brands.push({ brand: 'Microsoft Edge', version: '145' });
  assert.equal(captureEnvironment(chromium).browser, 'edge');
  assert.deepEqual(normalizeEnvironment({ version: 1, os: '__proto__', browser: 'private', browserMajor: Infinity }), UNKNOWN_ENVIRONMENT);
});

test('capture environment stays frozen through build/projection and legacy reports do not acquire current hints', () => {
  const nav = { userAgent: '(Windows NT 10.0) Chrome/145.0', platform: 'Win32' };
  const start = createRunSnapshot({ navigator: nav }); nav.userAgent = '(Macintosh) Version/26.0 Safari/605';
  try {
    builder._beginRun('record', { runSnapshot: start });
    assert.equal(builder.build().environment.os, 'windows');
    assert.equal(builder.build().environment.browser, 'chrome');
    assert.equal(Object.isFrozen(start.environment), true);
    const projection = projectReviewReport({ ...report(), environment: { ...windows, userAgent: 'private', gpu: 'private', deviceId: 'private' } });
    assert.equal(projection.environment.os, 'windows'); assert.doesNotMatch(JSON.stringify(projection), /private/);
    builder._beginRun('record', { runSnapshot: { runId: 'legacy' } });
    assert.deepEqual(builder.build().environment, UNKNOWN_ENVIRONMENT);
    assert.deepEqual(projectReviewReport(reviewReport()).environment, UNKNOWN_ENVIRONMENT);
    assert.equal(builder._buildCaptureContext({}).browserInputVolumeAdjustment.status, 'unavailable');
  } finally { builder._resetRunState(); }
});

test('permission guidance selects the current OS/browser and unreadable input is not a proven competing app', () => {
  const win = captureErrorMessage({ name: 'NotAllowedError' }, windows);
  assert.match(win, /Chrome Settings/); assert.match(win, /desktop apps/); assert.doesNotMatch(win, /Mac System/);
  const mac = captureErrorMessage({ name: 'NotAllowedError' }, { os: 'macos', browser: 'safari' });
  assert.match(mac, /Mac System Settings/); assert.doesNotMatch(mac, /Chrome|Windows/);
  assert.doesNotMatch(captureErrorMessage({ name: 'NotAllowedError' }, { os: 'ios', browser: 'chrome' }), /Privacy and security|Windows|Mac System/);
  assert.match(captureErrorMessage({ name: 'NotAllowedError' }, { os: 'ios', browser: 'chrome' }), /microphone icon beside the address bar/);
  assert.doesNotMatch(captureErrorMessage({ name: 'NotReadableError' }), /is being used/);
  assert.match(captureErrorMessage({ name: 'SecurityError' }), /administrator/);
});

test('known OS selects concrete input instructions and missing controls offer bounded alternatives', () => {
  const r = report(), state = { answers: { sameProblem: 'yes' }, attempts: [] };
  let d = evaluateReview(r, state);
  assert.match(d.next.instruction, /Windows Settings/); assert.deepEqual(d.next.changes, ['input-level']);
  recordAttempt(state, d, 'unavailable'); d = evaluateReview(r, state);
  assert.equal(d.question.id, 'inputControl');
  state.answers.inputControl = 'hardware'; d = evaluateReview(r, state);
  assert.equal(d.next.id, 'hardwareInput'); recordAttempt(state, d);
  d = evaluateReview(r, state); assert.equal(d.next.id, 'distance'); recordAttempt(state, d);
  assert.equal(evaluateReview(r, state).reason, 'checks-exhausted');
  state.answers.targetOs = 'macos'; delete state.answers.inputControl;
  d = evaluateReview(r, state); assert.match(d.next.instruction, /Apple menu/); assert.doesNotMatch(d.next.instruction, /Windows/);
});

test('saturation alternatives never suggest increasing gain even when sustained level is low', () => {
  const r = report(); r.audioMetrics.signal.peakDb = 0; r.audioMetrics.clipping.rate = 0.01;
  const state = { answers: { sameProblem: 'yes' }, attempts: [] };
  let d = evaluateReview(r, state); assert.equal(d.next.id, 'headroom'); recordAttempt(state, d, 'unavailable');
  state.answers.inputControl = 'none'; d = evaluateReview(r, state);
  assert.equal(d.next.id, 'distance'); assert.match(d.next.instruction, /farther/); assert.doesNotMatch(d.next.instruction, /closer|increase.*gain/i);
});

test('normal local recording enters an explicit support path; another device never inherits the capture OS', () => {
  const r = report('windows', true); r.profile.id = 'teams';
  const state = { hasComplaint: true, answers: {}, attempts: [] };
  assert.equal(evaluateReview(r).status, 'SUMMARY');
  assert.equal(evaluateReview(r, state).question.id, 'sameProblem');
  state.answers.sameProblem = 'external'; assert.equal(evaluateReview(r, state).question.id, 'targetDevice');
  state.answers.targetDevice = 'other'; assert.equal(evaluateReview(r, state).question.id, 'targetOs');
  state.answers.targetOs = 'ios'; assert.equal(evaluateReview(r, state).question.id, 'symptom');
  state.answers.symptom = 'cuts'; assert.equal(evaluateReview(r, state).question.id, 'trigger');
  state.answers.trigger = 'background';
  const d = evaluateReview(r, state);
  assert.equal(d.status, 'SUPPORT'); assert.equal(d.eligible, false); assert.equal(d.ai.available, false);
  assert.equal(d.next.id, 'foreground'); assert.equal(d.next.context.os, 'ios');
  assert.equal(d.next.context.app, 'teams'); assert.equal(d.next.context.browser, 'unknown');
  assert.equal(d.next.target, 'external'); assert.match(d.next.outcomes, /affected app/);
  assert.deepEqual(d.observations, []); recordAttempt(state, d);
  assert.equal(evaluateReview(r, state).next.id, 'teamsHealth');
});

test('support variants select one relevant check and exhaust even with unavailable answers', () => {
  for (const [symptom, trigger, expected] of [['quiet', 'unknown', 'appInput'], ['noise', 'unknown', 'appBackground'],
    ['echo', 'unknown', 'headphones'], ['distorted', 'unknown', 'headphones'], ['cuts', 'under-load', 'workload'],
    ['cuts', 'background', 'foreground'], ['bluetooth-change', 'unknown', 'bluetoothInput'], ['unknown', 'unknown', 'supportDetails']]) {
    const r = report('windows', true); r.profile.id = 'discord';
    const state = { hasComplaint: true, answers: { sameProblem: 'external', targetDevice: 'same', symptom, trigger }, attempts: [] };
    let d = evaluateReview(r, state); assert.equal(d.next.id, expected, symptom);
    const seen = new Set();
    for (let count = 0; d.next && count < 10; count++) {
      assert.equal(seen.has(d.next.id), false); seen.add(d.next.id); recordAttempt(state, d, 'unavailable'); d = evaluateReview(r, state);
    }
    assert.equal(d.next, null); assert.equal(d.reason, 'checks-exhausted');
  }
});

test('site permission is conditional on web/no-input and unknown context still permits generic checks', () => {
  const r = report('windows', true); r.profile.id = 'teams';
  const state = { hasComplaint: true, answers: { sameProblem: 'external', targetDevice: 'other', targetOs: 'unknown', symptom: 'no-input' }, attempts: [] };
  assert.equal(evaluateReview(r, state).question.id, 'targetClient'); state.answers.targetClient = 'web';
  recordAttempt(state, evaluateReview(r, state));
  const d = evaluateReview(r, state); assert.equal(d.next.id, 'sitePermission');
  assert.doesNotMatch(d.next.instruction, /Chrome|Windows|Mac System/);
});

test('changed or missing capture environments prevent a controlled comparison', () => {
  const a = report(), b = structuredClone(a); b.run.id = 'after'; b.generatedAt = '2026-09-11T12:01:00Z';
  const controls = { change: 'input-level', sameMicrophone: true, sameConditions: true };
  assert.equal(compareReviewReports(a, b, controls).status, 'controlled-by-user-report');
  for (const environment of [undefined, { ...windows, os: 'macos' }, { ...windows, browser: 'edge' }, { ...windows, browserMajor: 146 }]) {
    b.environment = environment;
    assert.equal(compareReviewReports(a, b, controls).status, 'descriptive');
  }
});

test('reported speech with near silence checks selection and mute before any level increase', () => {
  const r = report(); r.audioMetrics.signal = { rmsDb: -150, peakDb: -150 };
  const state = { answers: { spoke: 'yes', sameProblem: 'yes' }, attempts: [] };
  let d = evaluateReview(r, state); assert.equal(d.next.id, 'captureSelection'); recordAttempt(state, d);
  d = evaluateReview(r, state); assert.equal(d.next.id, 'physicalMute'); assert.doesNotMatch(d.next.instruction, /increase/i);
});

test('a local complaint in a Teams-shaped scenario does not route to an actual Teams call', () => {
  const r = report('windows', true); r.profile.id = 'teams';
  const state = { hasComplaint: true, answers: { sameProblem: 'yes', symptom: 'cuts', trigger: 'always' } };
  assert.equal(evaluateReview(r, state).next.id, 'captureSelection');
});
