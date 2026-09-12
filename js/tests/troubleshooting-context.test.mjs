import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTroubleshootingContext, describeTroubleshootingContext, TROUBLESHOOTING_FIELDS,
  UNKNOWN_TROUBLESHOOTING_CONTEXT
} from '../modules/TroubleshootingContext.js';
import { createRunSnapshot, completeRunSnapshot } from '../modules/RunSnapshot.js';
import builder from '../modules/DiagnosticReportBuilder.js';
import eventBus from '../modules/EventBus.js';
import { EVENTS } from '../modules/constants.js';
import { evaluatePremiumReport } from '../../server/premium-report-evaluator.js';

const legacyGuidanceReport = {
  version: '2.0', generatedAt: '2026-09-08T00:00:00.000Z', sessionId: 'saved-session',
  run: { id: 'saved-guidance', accountOwnerId: 'captured-owner', type: 'troubleshooting' },
  profile: { id: null, label: 'Troubleshooting', category: null },
  communicationContext: { usage: 'voice-call' },
  troubleshooting: {
    version: 1, usage: 'voice-call', os: 'windows', osSource: 'user-selected', app: 'unknown', client: 'unknown',
    symptom: 'bluetooth-change', scope: 'unknown', trigger: 'call-start'
  },
  device: null, recording: null, loopback: null, audioMetrics: null,
  deepAnalysis: null, system: null, sanityCheck: null, logs: null
};

test('saved guidance keeps its described use when the current measured profile changes', t => {
  setupBrowser(t);
  const guidance = structuredClone(legacyGuidanceReport);
  for (const profile of [{ id: 'raw', category: 'record' }, { id: 'discord', category: 'call' }, { id: 'telegram-voice', category: 'record' }]) {
    const snapshot = createRunSnapshot({ profile });
    builder._beginRun(profile.category === 'call' ? 'test' : 'record', { runSnapshot: snapshot });
    assert.equal(builder.build().communicationContext.usage, snapshot.communicationContext.usage);
    builder.restoreReport(guidance);
    assert.equal(evaluatePremiumReport(builder.getLastReport()).recommendations[0].id, 'GUIDE_BLUETOOTH_CALL_CHANGE');
  }
  assert.deepEqual(guidance, legacyGuidanceReport);
  const unknown = structuredClone(guidance);
  unknown.troubleshooting.usage = 'unknown';
  assert.equal(evaluatePremiumReport(unknown).recommendations[0].id, 'GUIDE_UNAVAILABLE');
});

test('OS hints prioritize iPad and Android ambiguity and never invent a Windows version', () => {
  const cases = [
    [{ userAgentData: { platform: 'Windows' } }, 'windows'],
    [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, 'windows'],
    [{ platform: 'Win32' }, 'windows'],
    [{ userAgentData: { platform: 'macOS' } }, 'macos'],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel', maxTouchPoints: 5,
      userAgentData: { platform: 'macOS', mobile: false } }, 'ios'],
    [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }, 'ios'],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 14; Phone)', platform: 'Linux armv8l' }, 'android'],
    [{ userAgentData: { platform: 'Android' } }, 'android'],
    [{ userAgent: 'Mozilla/5.0 (X11; CrOS x86_64)' }, 'chromeos'],
    [{ userAgentData: { platform: 'Chrome OS' } }, 'chromeos'],
    [{ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }, 'linux'],
    [{ platform: 'Linux x86_64' }, 'linux'],
    [{ userAgentData: { mobile: true }, platform: 'Linux armv8l' }, 'unknown'],
    [{ userAgentData: { mobile: true } }, 'unknown'],
    [{ userAgentData: { mobile: false } }, 'unknown'],
    [{ userAgentData: { platform: '__proto__' } }, 'unknown'],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 12; Android TV)', userAgentData: { platform: 'Android' } }, 'unknown'],
    [{ userAgent: 'WebOS SmartTV', userAgentData: { platform: 'Linux' } }, 'unknown'],
    [{}, 'unknown'], [null, 'unknown']
  ];
  for (const [navigatorInfo, expected] of cases) {
    const result = createTroubleshootingContext({ navigator: navigatorInfo });
    assert.equal(result.os, expected, JSON.stringify(navigatorInfo));
    assert.equal(result.osSource, expected === 'unknown' ? 'unknown' : 'browser-hint');
    assert.equal(result.app, 'unknown');
    assert.equal(result.client, 'unknown');
    assert.equal('osVersion' in result, false);
  }
});

test('user-selected OS including unknown overrides browser hints and input is allowlisted', () => {
  const navigatorInfo = { userAgentData: { platform: 'Windows' } };
  for (const os of ['ios', 'unknown']) {
    const result = createTroubleshootingContext({ input: { os }, navigator: navigatorInfo });
    assert.equal(result.os, os);
    assert.equal(result.osSource, 'user-selected');
  }
  const result = createTroubleshootingContext({ input: {
    os: 'Windows 11', app: 'javascript:alert(1)', client: 'desktop', symptom: ['noise'],
    scope: 'all', trigger: '__proto__', extra: 'ignored'
  }, navigator: navigatorInfo });
  assert.deepEqual(result, UNKNOWN_TROUBLESHOOTING_CONTEXT);
  assert.deepEqual(createTroubleshootingContext({ input: null }), UNKNOWN_TROUBLESHOOTING_CONTEXT);
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => { result.os = 'ios'; }, TypeError);
});

test('normalized contexts retain OS provenance through repeated capture normalization', () => {
  for (const initial of [
    createTroubleshootingContext({ navigator: { userAgentData: { platform: 'Windows' } } }),
    createTroubleshootingContext({ input: { os: 'ios', symptom: 'cuts' } }),
    UNKNOWN_TROUBLESHOOTING_CONTEXT
  ]) {
    const next = createTroubleshootingContext({ input: initial, navigator: { userAgentData: { platform: 'Android' } } });
    assert.deepEqual(next, initial);
  }
});

test('shared descriptions only expose valid known context with OS provenance', () => {
  const hint = createTroubleshootingContext({ input: { app: 'teams', client: 'native', symptom: 'cuts' },
    navigator: { userAgentData: { platform: 'Windows' } } });
  const entries = describeTroubleshootingContext(hint);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0], ['Operating system with the problem', 'Windows (browser hint)']);
  assert.deepEqual(describeTroubleshootingContext({ os: 'android' }), [
    ['Operating system with the problem', 'Android (you selected)']
  ]);
  assert.deepEqual(describeTroubleshootingContext({ app: '<script>', symptom: 'unknown' }), []);
  assert.deepEqual(describeTroubleshootingContext(undefined), []);
  for (const definition of Object.values(TROUBLESHOOTING_FIELDS)) {
    assert.equal(Object.isFrozen(definition.options), true);
    assert.equal(new Set(definition.options.map(option => option.value)).size, definition.options.length);
  }
});

function setupBrowser(t) {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', language: 'en', platform: 'Win32'
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => {
    builder._resetRunState();
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else delete globalThis.window;
  });
}

test('run and built report retain the starting problem when form and browser change', t => {
  setupBrowser(t);
  const input = { os: 'android', app: 'whatsapp', client: 'native', symptom: 'cuts', scope: 'one-app', trigger: 'background' };
  const start = createRunSnapshot({ profile: { id: 'whatsapp-voice', category: 'record' }, troubleshooting: input });
  input.os = 'windows';
  input.app = 'teams';
  globalThis.navigator.userAgent = 'Macintosh';
  const completed = completeRunSnapshot(start);
  builder._beginRun('record', { runSnapshot: completed });
  const report = builder.build();
  assert.equal(report.troubleshooting, start.troubleshooting);
  assert.equal(report.troubleshooting.os, 'android');
  assert.equal(report.troubleshooting.app, 'whatsapp');
  assert.equal(report.communicationContext.usage, 'voice-message');
  assert.equal(Object.isFrozen(completed.troubleshooting), true);
  assert.equal(createRunSnapshot().troubleshooting.os, 'windows');
});

test('legacy run and restore do not acquire the current OS or problem description', t => {
  setupBrowser(t);
  builder._beginRun('record', { runSnapshot: { runId: 'legacy' } });
  assert.equal(builder.build().troubleshooting, UNKNOWN_TROUBLESHOOTING_CONTEXT);
  const report = { run: { id: 'saved-legacy' }, profile: { id: 'discord' } };
  builder.restoreReport(report);
  assert.equal(builder.getLastReport(), report);
  assert.equal(report.troubleshooting, undefined);
});

test('restoring saved guidance preserves its identity and leaves active capture samples and ownership intact', t => {
  setupBrowser(t);
  let cancelled = 0;
  let logged = 0;
  let emitted = 0;
  const previousDeps = { ...builder._deps };
  t.after(() => builder.init(previousDeps));
  builder.init({
    deepAnalysisEngine: { cancel: () => { cancelled += 1; } },
    logManager: { sessionId: 'browser-session', getSanityReport: () => { logged += 1; },
      getStats: () => { logged += 1; }, getByCategory: () => { logged += 1; } }
  });
  const activeRun = createRunSnapshot();
  builder._beginRun('record', { runSnapshot: activeRun });
  builder._lastRecordingData = { blob: new Blob(['old sample']) };
  builder._lastLoopbackStats = { jitterMs: 123 };
  builder._lastDeepAnalysis = { audioMetrics: { sampleCount: 48 } };
  builder._systemSnapshot = { oldMeasurement: true };
  builder._lastReport = { run: { id: 'previous-report' } };
  const priorState = { ...builder };
  const cancelsBefore = cancelled;
  const report = structuredClone(legacyGuidanceReport);
  const off = eventBus.on(EVENTS.DIAGNOSTIC_REPORT_READY, restored => { emitted += 1; assert.equal(restored, report); });
  t.after(off);
  builder.restoreReport(report);
  assert.equal(builder.getLastReport(), report);
  assert.notEqual(report.run.id, activeRun.runId);
  assert.deepEqual(report, legacyGuidanceReport);
  assert.deepEqual({ ...builder }, { ...priorState, _lastReport: report });
  assert.equal(cancelled, cancelsBefore);
  assert.equal(logged, 0);
  assert.equal(emitted, 1);
});
