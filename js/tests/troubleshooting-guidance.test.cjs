const test = require('node:test');
const assert = require('node:assert/strict');
const { getTroubleshootingGuidance } = require('../../server/troubleshooting-guidance.js');
const { evaluatePremiumReport } = require('../../server/premium-report-evaluator.js');

function report(context = {}, usage = 'voice-call') {
  return {
    communicationContext: { usage },
    troubleshooting: {
      version: 1, os: 'unknown', osSource: 'user-selected', app: 'unknown', client: 'unknown',
      symptom: 'unknown', scope: 'unknown', trigger: 'unknown', ...context
    }
  };
}

const CASES = [
  ['GUIDE_WINDOWS_INPUT', { os: 'windows', symptom: 'no-input' }],
  ['GUIDE_WINDOWS_LOAD', { os: 'windows', symptom: 'cuts', scope: 'all-apps', trigger: 'under-load' }],
  ['GUIDE_ANDROID_WEB_INPUT', { os: 'android', client: 'web', symptom: 'no-input' }],
  ['GUIDE_IOS_APP_INPUT', { os: 'ios', app: 'whatsapp', client: 'native', symptom: 'no-input' }],
  ['GUIDE_IOS_MIC_MODE', { os: 'ios', app: 'whatsapp', client: 'native', symptom: 'noise' }],
  ['GUIDE_BLUETOOTH_CALL_CHANGE', { os: 'windows', symptom: 'bluetooth-change', trigger: 'call-start' }],
  ['GUIDE_BLUETOOTH_CALL_CHANGE', { os: 'macos', symptom: 'bluetooth-change', trigger: 'call-start' }],
  ['GUIDE_TEAMS_CALL_HEALTH', { app: 'teams', client: 'web', symptom: 'cuts', scope: 'one-app' }],
  ['GUIDE_DISCORD_IOS_BACKGROUND', { os: 'ios', app: 'discord', client: 'native', symptom: 'cuts', scope: 'one-app', trigger: 'background' }]
];

test('supported descriptions produce bounded, sourced checks and explicitly preserve their unmeasured status', () => {
  for (const [id, context] of CASES) {
    const guidance = getTroubleshootingGuidance(report(context));
    assert.equal(guidance[0]?.id, id);
    assert(guidance.length <= 2);
    for (const item of guidance) {
      assert.equal(item.category, 'troubleshooting');
      assert.equal(item.severity, 'info');
      assert.equal(item.confidence, 'low');
      assert.match(item.evidence, /^Based on your description\./);
      assert.equal(item.verifiedOn, '2026-09-05');
      assert.equal(item.message, item.reason);
      for (const field of ['reason', 'action', 'expected', 'next']) assert(item[field].length > 20, field);
      assert(item.steps.length >= 2 && item.steps.every(step => typeof step === 'string'));
      assert(item.sources.length > 0);
      for (const source of item.sources) {
        assert(source.label);
        assert.equal(new URL(source.url).protocol, 'https:');
      }
    }
  }
});

test('missing, malformed, unknown and unsupported contexts never invent a platform route', () => {
  for (const context of [undefined, null, [], 'windows', {}, { version: 2, os: 'windows', symptom: 'no-input' }]) {
    assert.deepEqual(getTroubleshootingGuidance({ troubleshooting: context }), []);
  }
  assert.deepEqual(getTroubleshootingGuidance(report()), []);
  for (const os of ['unknown', 'linux', 'chromeos', 'tv', '<script>']) {
    for (const symptom of ['no-input', 'quiet', 'distorted', 'noise', 'bluetooth-change']) {
      assert.deepEqual(getTroubleshootingGuidance(report({ os, symptom, trigger: 'call-start' })), []);
    }
  }
  for (const osSource of ['unknown', 'inferred', undefined]) {
    assert.deepEqual(getTroubleshootingGuidance(report({ os: 'windows', osSource, symptom: 'no-input' })), []);
  }
});

test('Windows latency investigation requires the reported symptom, cross-app scope and load trigger together', () => {
  const base = { os: 'windows', symptom: 'cuts', scope: 'all-apps', trigger: 'under-load' };
  for (const patch of [
    { os: 'macos' }, { os: 'android' }, { os: 'unknown' }, { symptom: 'quiet' }, { symptom: 'noise' },
    { symptom: 'unknown' }, { scope: 'one-app' }, { scope: 'unknown' }, { trigger: 'always' },
    { trigger: 'background' }, { trigger: 'unknown' }
  ]) {
    assert(!getTroubleshootingGuidance(report({ ...base, ...patch })).some(item => item.id === 'GUIDE_WINDOWS_LOAD'));
  }
  assert.equal(getTroubleshootingGuidance(report({ ...base, symptom: 'distorted' }))[0].id, 'GUIDE_WINDOWS_LOAD');
  const timingOnly = report({ os: 'windows' });
  timingOnly.system = { correlation: { findings: [{ id: 'CPU_LIKELY' }, { id: 'NETWORK_LIKELY' }] }, rafSpikes: 500 };
  assert.deepEqual(getTroubleshootingGuidance(timingOnly), []);
  assert(!JSON.stringify(evaluatePremiumReport(timingOnly)).includes('LatencyMon'));
  assert.match(JSON.stringify(getTroubleshootingGuidance(report(base))), /One spike or a listed driver alone does not prove/);
});

test('permission routes distinguish the target OS and native versus web app', () => {
  const android = { os: 'android', client: 'web', symptom: 'no-input' };
  for (const patch of [{ client: 'native' }, { client: 'unknown' }, { os: 'ios' }, { symptom: 'quiet' }]) {
    assert(!getTroubleshootingGuidance(report({ ...android, ...patch })).some(item => item.id === 'GUIDE_ANDROID_WEB_INPUT'));
  }
  const iphone = { os: 'ios', app: 'whatsapp', client: 'native', symptom: 'no-input' };
  for (const patch of [{ client: 'web' }, { client: 'unknown' }, { app: 'unknown' }, { app: 'browser' }, { os: 'macos' }]) {
    assert(!getTroubleshootingGuidance(report({ ...iphone, ...patch })).some(item => item.id === 'GUIDE_IOS_APP_INPUT'));
  }
  const windows = getTroubleshootingGuidance(report({ os: 'windows', symptom: 'no-input', client: 'web' }))[0];
  assert.match(windows.steps[2], /site's permission/);
  assert.match(getTroubleshootingGuidance(report(android))[0].steps[0], /In Chrome/);
});

test('iOS microphone modes are conditional native-app checks, including voice messages, without scoring background reduction', () => {
  const base = { os: 'ios', app: 'telegram', client: 'native', symptom: 'noise' };
  const item = getTroubleshootingGuidance(report(base, 'voice-message'))[0];
  assert.equal(item.id, 'GUIDE_IOS_MIC_MODE');
  assert.match(item.steps.join(' '), /availability depends on your device, OS version and app/);
  assert.match(item.expected, /Quieter background alone does not prove/);
  for (const patch of [{ os: 'macos' }, { os: 'android' }, { client: 'web' }, { app: 'browser' }, { app: 'unknown' }, { symptom: 'cuts' }]) {
    assert(!getTroubleshootingGuidance(report({ ...base, ...patch })).some(entry => entry.id === item.id));
  }
});

test('call-specific guides do not leak into voice messages or unknown usage', () => {
  for (const [id, context] of CASES.filter(([id]) => /TEAMS|DISCORD|BLUETOOTH/.test(id))) {
    for (const usage of ['voice-message', 'recording', 'unknown', undefined]) {
      const input = report(context);
      input.communicationContext = { usage };
      assert(!getTroubleshootingGuidance(input).some(item => item.id === id), `${id}: ${usage}`);
    }
  }
});

test('Teams guide requires Teams, explicit client, cuts and one-app scope; received statistics retain direction', () => {
  const base = { app: 'teams', client: 'native', symptom: 'cuts', scope: 'one-app' };
  for (const patch of [{ app: 'zoom' }, { app: 'discord' }, { app: 'unknown' }, { client: 'unknown' },
    { symptom: 'noise' }, { symptom: 'unknown' }, { scope: 'all-apps' }, { scope: 'unknown' }]) {
    assert(!getTroubleshootingGuidance(report({ ...base, ...patch })).some(item => item.id === 'GUIDE_TEAMS_CALL_HEALTH'));
  }
  const item = getTroubleshootingGuidance(report(base))[0];
  assert.match(item.steps.join(' '), /describe audio arriving at your client/);
  assert.match(item.steps.join(' '), /do not directly measure your voice arriving at the other person/);
});

test('Discord background and Bluetooth call-start routes exclude similar symptoms in other contexts', () => {
  const discord = CASES.at(-1)[1];
  for (const patch of [{ os: 'android' }, { app: 'whatsapp' }, { client: 'web' }, { scope: 'all-apps' },
    { symptom: 'no-input' }, { trigger: 'under-load' }, { trigger: 'unknown' }]) {
    assert(!getTroubleshootingGuidance(report({ ...discord, ...patch })).some(item => item.id === 'GUIDE_DISCORD_IOS_BACKGROUND'));
  }
  for (const os of ['windows', 'macos']) {
    const base = { os, symptom: 'bluetooth-change', trigger: 'call-start' };
    for (const patch of [{ os: 'ios' }, { os: 'android' }, { trigger: 'always' }, { trigger: 'unknown' }, { symptom: 'distorted' }]) {
      assert(!getTroubleshootingGuidance(report({ ...base, ...patch })).some(item => item.id === 'GUIDE_BLUETOOTH_CALL_CHANGE'));
    }
    assert.match(getTroubleshootingGuidance(report(base))[0].reason, /has not identified the active Bluetooth mode/);
  }
});

test('guidance never replaces insufficient-audio evidence and does not modify existing measurements or recommendations', () => {
  const partial = report(CASES[1][1]);
  const insufficient = evaluatePremiumReport(partial);
  assert.deepEqual(insufficient.recommendations.map(item => item.id), ['INSUFFICIENT_AUDIO', 'GUIDE_WINDOWS_LOAD']);
  assert.deepEqual(insufficient.metrics, evaluatePremiumReport({}).metrics);
  assert.deepEqual(evaluatePremiumReport({}), {
    metrics: [{ key: 'assessment', label: 'Assessment', value: 'Insufficient audio', unit: '', rating: 'info' }],
    recommendations: [insufficient.recommendations[0]]
  });
  partial.audioMetrics = {
    status: 'measured', sampleCount: 48000, durationMs: 1000,
    signal: { rmsDb: -25, peakDb: -10 },
    clipping: { status: 'measured', method: 'sample-saturation', rate: 0 }
  };
  const unchanged = JSON.stringify(partial);
  const guided = evaluatePremiumReport(partial);
  const baseline = evaluatePremiumReport({ ...partial, troubleshooting: undefined });
  assert.deepEqual(guided.metrics, baseline.metrics);
  assert.deepEqual(guided.recommendations.filter(item => item.category !== 'troubleshooting'), baseline.recommendations);
  assert.equal(JSON.stringify(partial), unchanged);
});

test('returned sources are independent and the Worker adapter produces identical private guidance', async () => {
  const input = report(CASES[1][1]);
  const first = getTroubleshootingGuidance(input);
  first[0].sources[0].url = 'https://invalid.example/';
  assert.match(getTroubleshootingGuidance(input)[0].sources[0].url, /^https:\/\/www.resplendence.com\//);
  const worker = await import('../../worker/premium-report-evaluator.js');
  for (const [, context] of CASES) {
    assert.deepEqual(worker.evaluatePremiumReport(report(context)), evaluatePremiumReport(report(context)));
  }
});

test('guidance-only runs return matching steps without insufficient-audio or recording requirements', () => {
  const input = { ...report(CASES[1][1]), run: { type: 'troubleshooting' } };
  const result = evaluatePremiumReport(input);
  assert.deepEqual(result.metrics, []);
  assert.deepEqual(result.recommendations, getTroubleshootingGuidance(input));
  assert(!result.recommendations.some(item => item.id === 'INSUFFICIENT_AUDIO'));
});

test('guidance-only runs with no matching route explicitly describe the catalog limit', () => {
  const result = evaluatePremiumReport({ ...report({ os: 'linux', symptom: 'quiet' }), run: { type: 'troubleshooting' } });
  assert.deepEqual(result.metrics, []);
  assert.equal(result.recommendations.length, 1);
  const item = result.recommendations[0];
  assert.equal(item.id, 'GUIDE_UNAVAILABLE');
  assert.equal(item.category, 'troubleshooting');
  assert.equal(item.severity, 'info');
  assert.equal(item.confidence, 'low');
  assert.match(item.reason, /No verified troubleshooting steps/);
  assert.doesNotMatch(item.action, /record|microphone test/i);
  assert.match(item.evidence, /No audio or system performance was measured/);
});

test('guidance-only runs ignore stale or injected measurement, spectrum and system data in both evaluators', async () => {
  const worker = await import('../../worker/premium-report-evaluator.js');
  for (const context of [CASES[1][1], { os: 'linux', symptom: 'quiet' }]) {
    const clean = { ...report(context), run: { type: 'troubleshooting' } };
    const injected = {
      ...clean,
      audioMetrics: {
        status: 'measured', sampleCount: 48000, durationMs: 1000,
        signal: { rmsDb: -70, peakDb: -60 },
        clipping: { status: 'measured', method: 'sample-saturation', rate: 0.2 },
        noiseFloor: { status: 'measured', estimatedDb: -10 }, snr: { status: 'measured', estimatedDb: 5 }
      },
      deepAnalysis: { status: 'ready', bands: { presence: -20 }, spectralFlatness: 0.8 },
      system: { correlation: { findings: [{ id: 'CPU_LIKELY' }, { id: 'TAB_HIDDEN' }] } }
    };
    const expected = evaluatePremiumReport(clean);
    assert.deepEqual(evaluatePremiumReport(injected), expected);
    assert.deepEqual(worker.evaluatePremiumReport(injected), expected);
    assert.equal(expected.overall, undefined);
    assert.deepEqual(expected.metrics, []);
  }
});

test('normal recording and call reports still retain insufficient-audio guidance', () => {
  for (const type of ['record', 'test']) {
    const input = { ...report(CASES[1][1]), run: { type } };
    const result = evaluatePremiumReport(input);
    assert.equal(result.recommendations[0].id, 'INSUFFICIENT_AUDIO');
    assert.match(result.recommendations[0].action, /^Record a short spoken sample/);
    assert.equal(result.recommendations[1].id, 'GUIDE_WINDOWS_LOAD');
    assert.equal(result.metrics[0].value, 'Insufficient audio');
  }
});

function automaticReport(os = 'windows', metrics = {}) {
  return {
    ...report({ os, osSource: 'browser-hint' }),
    run: { type: 'record' },
    audioMetrics: {
      status: 'measured', source: 'decoded-file-pcm', sampleCount: 48000, durationMs: 1000,
      signal: { rmsDb: -60, peakDb: -50, maxBlockRmsDb: -53 },
      clipping: { status: 'measured', method: 'sample-saturation', rate: 0 }, ...metrics
    }
  };
}

function canonicalFindings(input) {
  return evaluatePremiumReport({ ...input, troubleshooting: undefined }).recommendations;
}

test('recorded low level automatically selects source-backed Windows or Mac input checks without a problem description', () => {
  for (const os of ['windows', 'macos']) {
    const input = automaticReport(os);
    const result = getTroubleshootingGuidance(input, { measurementFindings: canonicalFindings(input) });
    assert.equal(result.length, 1);
    const item = result[0];
    assert.equal(item.id, os === 'windows' ? 'GUIDE_WINDOWS_RECORDED_INPUT' : 'GUIDE_MACOS_RECORDED_INPUT');
    assert.equal(item.replaces, 'LOW_RECORDED_LEVEL');
    assert.equal(item.severity, 'info');
    assert.match(item.evidence, /^Based on the saved recording and a browser hint/);
    assert.match(item.action, /If you spoke during this recording/);
    assert.match(item.steps.join(' '), /same device used for this recording/);
    assert.match(item.steps.join(' '), /offers an input-volume control/);
    assert.doesNotMatch(JSON.stringify(item), /You reported|Based on your description|LatencyMon|Call health|CallKit/);
    assert.equal(new URL(item.sources[0].url).hostname, os === 'windows' ? 'support.microsoft.com' : 'support.apple.com');
  }
});

test('sample saturation selects a conditional reduction check, with priority over any contradictory low-level finding', () => {
  const input = automaticReport('windows', {
    signal: { rmsDb: -20, peakDb: 0, maxBlockRmsDb: -10 },
    clipping: { status: 'measured', method: 'sample-saturation', rate: 0.01 }
  });
  const measurementFindings = canonicalFindings(input);
  const item = getTroubleshootingGuidance(input, { measurementFindings })[0];
  assert.equal(item.replaces, 'FULL_SCALE_SAMPLES');
  assert.match(item.action, /If speech sounds distorted/);
  assert.match(item.steps.join(' '), /lower it slightly only if speech sounds distorted/);
  assert.doesNotMatch(item.steps.join(' '), /increase it/);
  assert.equal(getTroubleshootingGuidance(input, {
    measurementFindings: [...measurementFindings, { id: 'LOW_RECORDED_LEVEL' }]
  })[0].replaces, 'FULL_SCALE_SAMPLES');
});

test('OS alone, low average from pauses, high peaks without saturation and browser timing never trigger automatic OS advice', () => {
  for (const metrics of [
    { signal: { rmsDb: -25, peakDb: -10, maxBlockRmsDb: -20 } },
    { signal: { rmsDb: -65, peakDb: -10, maxBlockRmsDb: -20 } },
    { signal: { rmsDb: -25, peakDb: -0.3, maxBlockRmsDb: -20 }, headroom: { peakDb: -0.3 } }
  ]) {
    const input = automaticReport('windows', metrics);
    input.system = { correlation: { findings: [{ id: 'CPU_LIKELY' }, { id: 'NETWORK_LIKELY' }] }, rafSpikes: 500 };
    assert.deepEqual(getTroubleshootingGuidance(input, { measurementFindings: canonicalFindings(input) }), []);
  }
  assert.deepEqual(getTroubleshootingGuidance(automaticReport()), []);
});

test('automatic OS advice excludes unknown/mobile systems, non-browser OS choices and non-file measurements', () => {
  for (const os of ['ios', 'android', 'linux', 'chromeos', 'unknown']) {
    const input = automaticReport(os);
    assert.deepEqual(getTroubleshootingGuidance(input, { measurementFindings: canonicalFindings(input) }), []);
  }
  for (const osSource of ['unknown', 'user-selected']) {
    const input = automaticReport();
    input.troubleshooting.osSource = osSource;
    assert.deepEqual(getTroubleshootingGuidance(input, { measurementFindings: canonicalFindings(input) }), []);
  }
  for (const source of ['live-analyser', 'preview', undefined]) {
    const input = automaticReport('windows', { source });
    assert.deepEqual(getTroubleshootingGuidance(input, { measurementFindings: canonicalFindings(input) }), []);
  }
  for (const [key, value] of Object.entries({ app: 'whatsapp', client: 'native', symptom: 'quiet', scope: 'one-app', trigger: 'always' })) {
    const input = automaticReport();
    input.troubleshooting[key] = value;
    assert(!getTroubleshootingGuidance(input, { measurementFindings: canonicalFindings(input) })
      .some(item => item.id === 'GUIDE_WINDOWS_RECORDED_INPUT'));
  }
});

test('invalid audio cannot produce automatic guidance from payload findings and guidance-only history remains unmeasured', () => {
  for (const metrics of [
    { status: 'unavailable' }, { sampleCount: 0 }, { durationMs: 100 },
    { signal: { rmsDb: NaN, peakDb: -50 } },
    { clipping: { status: 'unavailable', method: 'sample-saturation', rate: 0 } }
  ]) {
    const input = automaticReport('windows', metrics);
    input.measurementFindings = [{ id: 'LOW_RECORDED_LEVEL' }];
    const result = evaluatePremiumReport(input);
    assert.equal(result.recommendations[0].id, 'INSUFFICIENT_AUDIO');
    assert(!result.recommendations.some(item => item.id === 'GUIDE_WINDOWS_RECORDED_INPUT'));
  }
  const input = automaticReport();
  input.run.type = 'troubleshooting';
  assert.deepEqual(getTroubleshootingGuidance(input, { measurementFindings: [{ id: 'LOW_RECORDED_LEVEL' }] }), []);
});

test('silence-only PCM leads to conditional speaking guidance, never an inferred permission or no-input diagnosis', () => {
  const input = automaticReport('windows', { signal: { rmsDb: -180, peakDb: -180, maxBlockRmsDb: -180 } });
  const item = getTroubleshootingGuidance(input, { measurementFindings: canonicalFindings(input) })[0];
  assert.equal(item.replaces, 'LOW_RECORDED_LEVEL');
  assert.match(item.action, /^If you spoke/);
  assert.match(item.expected, /contained no speech, its low level does not justify an input-level change/);
  assert.doesNotMatch(JSON.stringify(item), /permission|no microphone input|muted|microphone access/i);
});

test('automatic enrichment preserves detailed measurements and Worker output while replacing only its generic finding', async () => {
  const worker = await import('../../worker/premium-report-evaluator.js');
  for (const os of ['windows', 'macos']) {
    const input = automaticReport(os);
    const baseline = evaluatePremiumReport({ ...input, troubleshooting: undefined });
    const guided = evaluatePremiumReport(input);
    const item = guided.recommendations.find(entry => entry.id === (os === 'windows' ? 'GUIDE_WINDOWS_RECORDED_INPUT' : 'GUIDE_MACOS_RECORDED_INPUT'));
    assert(item);
    assert.equal(item.replaces, 'LOW_RECORDED_LEVEL');
    assert(!guided.recommendations.some(entry => entry.id === item.replaces));
    assert.deepEqual(guided.metrics, baseline.metrics);
    assert.deepEqual(guided.recommendations.filter(entry => entry.category !== 'troubleshooting'),
      baseline.recommendations.filter(entry => entry.id !== item.replaces));
    assert.deepEqual(worker.evaluatePremiumReport(input), guided);
  }
});
