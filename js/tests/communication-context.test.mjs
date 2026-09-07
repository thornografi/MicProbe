import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommunicationContext, UNKNOWN_COMMUNICATION_CONTEXT } from '../modules/CommunicationContext.js';
import { createRunSnapshot, completeRunSnapshot } from '../modules/RunSnapshot.js';
import builder from '../modules/DiagnosticReportBuilder.js';
import { PROFILES } from '../modules/Config.js';
import eventBus from '../modules/EventBus.js';
import { EVENTS } from '../modules/constants.js';

test('profile evidence preserves source scope and review dates without asserting native client defaults', () => {
  for (const id of ['discord', 'whatsapp-telegram-call', 'whatsapp-voice']) {
    const evidence = PROFILES[id].evidence;
    assert.equal(evidence.schemaVersion, 1);
    assert.equal(evidence.verifiedAt, '2026-09-05');
    assert.equal(evidence.classification, 'local-approximation');
    assert.equal(evidence.clientVersion, null);
    assert.equal(evidence.clientCodec, null);
    assert(evidence.sources.length > 0);
    for (const source of evidence.sources) {
      assert.equal(source.platform, id === 'discord' ? 'discord' : 'whatsapp');
      assert(source.title);
      assert.equal(new URL(source.url).protocol, 'https:');
      assert(source.publishedAt === null || source.publishedAt < evidence.verifiedAt);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(evidence)), evidence);
  }
  assert.equal(PROFILES.raw.evidence, null, 'a local raw recording does not claim platform evidence');
  const voiceSources = PROFILES['whatsapp-voice'].evidence.sources;
  assert(voiceSources.some(source => source.title.includes('Cloud API')));
  assert(!voiceSources.some(source => source.url.includes('mlow')), 'call codec evidence is not voice-message encoder evidence');
});

test('existing call and voice-message profiles supply usage without another selection', () => {
  for (const profile of Object.values(PROFILES)) {
    const expected = profile.category === 'call' ? 'voice-call'
      : profile.id === 'raw' ? 'recording' : 'voice-message';
    const context = createCommunicationContext({ profile });
    assert.equal(context.usage, expected, profile.id);
    assert.equal(context.client, 'browser');
  }
  assert.equal(createCommunicationContext({ profile: { id: 'legacy', category: 'record' } }).usage, 'unknown');
  assert.equal(createCommunicationContext().usage, 'unknown');
});

test('access hints distinguish mobile, desktop and unavailable browser signals', () => {
  const cases = [
    [{ userAgentData: { mobile: true } }, 'mobile', 'user-agent-data'],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 14; Phone)' }, 'mobile', 'user-agent'],
    [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }, 'mobile', 'user-agent'],
    [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, 'desktop', 'user-agent'],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, 'desktop', 'user-agent'],
    [{ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }, 'desktop', 'user-agent'],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 12; Android TV)' }, 'unknown', 'unknown'],
    [{ userAgent: 'Mozilla/5.0 (WebOS; SmartTV)', userAgentData: { mobile: true } }, 'unknown', 'unknown'],
    [{ userAgent: 'Unclassified browser' }, 'unknown', 'unknown'],
    [{}, 'unknown', 'unknown'],
    [null, 'unknown', 'unknown']
  ];
  for (const [navigatorInfo, formFactor, source] of cases) {
    assert.deepEqual(createCommunicationContext({ navigator: navigatorInfo }).access, { formFactor, source });
  }
});

test('negative mobile UA data does not imply desktop and iPad desktop mode stays a mobile hint', () => {
  const desktopModeIpad = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    platform: 'MacIntel',
    maxTouchPoints: 5,
    userAgentData: { mobile: false }
  };
  assert.equal(createCommunicationContext({ navigator: desktopModeIpad }).access.formFactor, 'mobile');
  assert.equal(createCommunicationContext({ navigator: { userAgentData: { mobile: false } } }).access.formFactor, 'unknown');
  assert.equal(createCommunicationContext({ navigator: { ...desktopModeIpad, maxTouchPoints: 0 } }).access.formFactor, 'desktop');
});

test('run completion and report generation preserve the starting context after environment changes', t => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else delete globalThis.window;
    builder._resetRunState();
  });
  const navigatorInfo = { userAgent: 'Mozilla/5.0 (Linux; Android 14; Phone)', language: 'en' };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigatorInfo });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  const profile = { ...PROFILES['whatsapp-voice'] };
  const run = createRunSnapshot({ profile });
  navigatorInfo.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  profile.id = 'raw';
  const complete = completeRunSnapshot(run);
  builder._beginRun('record', { runSnapshot: complete });
  const report = builder.build();

  assert.equal(report.communicationContext, run.communicationContext);
  assert.equal(report.communicationContext.usage, 'voice-message');
  assert.equal(report.communicationContext.access.formFactor, 'mobile');
  assert.ok(Object.isFrozen(run.communicationContext));
  assert.ok(Object.isFrozen(run.communicationContext.access));
  assert.throws(() => { run.communicationContext.access.formFactor = 'desktop'; }, TypeError);

  const storedReport = JSON.parse(JSON.stringify(report));
  let emitted;
  const off = eventBus.on(EVENTS.DIAGNOSTIC_REPORT_READY, data => { emitted = data; });
  t.after(off);
  builder.restoreReport(storedReport);
  assert.equal(emitted, storedReport);
  assert.deepEqual(builder.getLastReport().communicationContext, run.communicationContext);

  builder._beginRun('record', { runSnapshot: { runId: 'legacy', profileId: 'whatsapp-voice', category: 'record' } });
  assert.equal(builder.build().communicationContext, UNKNOWN_COMMUNICATION_CONTEXT);
  const legacyReport = { run: { id: 'restored-legacy' }, profile: { id: 'whatsapp-voice' } };
  builder.restoreReport(legacyReport);
  assert.equal(builder.getLastReport(), legacyReport);
  assert.equal(builder.getLastReport().communicationContext, undefined);
});
