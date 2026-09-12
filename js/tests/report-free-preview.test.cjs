const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const constants = vm.runInNewContext(read('js/modules/constants.js').replaceAll('export const ', 'const ')
  + '\n({QUALITY, VU_METER})', { location: { hostname: 'localhost' } });
const evaluator = vm.runInNewContext(read('js/modules/ReportEvaluator.js').replace(/^import .*;$/gm, '')
  .replace('export default reportEvaluator;', 'reportEvaluator;'), { ...constants, structuredClone,
    usableReport: require('../modules/MeasurementValidity.js').usableReport,
    captureOutcome: require('../modules/CaptureOutcome.js').captureOutcome,
    ...require('../modules/CaptureContext.js') });
const plain = value => JSON.parse(JSON.stringify(value));

function report(metrics = {}) {
  return {
    run: { id: 'preview-a', type: 'record' },
    profile: { appliedConstraints: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } },
    audioMetrics: {
      status: 'measured', source: 'decoded-file-pcm', sampleCount: 48000, durationMs: 1000,
      signal: { rmsDb: -25, peakDb: -10, maxBlockRmsDb: -20 },
      clipping: { status: 'measured', method: 'sample-saturation', rate: 0 },
      noiseFloor: { status: 'measured', estimatedDb: -60 },
      snr: { status: 'measured', estimatedDb: 30 },
      coverage: { truncated: false },
      dropouts: { status: 'unavailable' }, guidedNoise: { status: 'measured', method: 'user-guided-file-segments' }, ...metrics,
      noiseFloor: { method: 'guided-quiet-segment', ...(metrics.noiseFloor || { status: 'measured', estimatedDb: -60 }) },
      snr: { method: 'guided-power-subtraction', ...(metrics.snr || { status: 'measured', estimatedDb: 30 }) },
      signal: { maxBlockRmsStatus: 'measured', maxBlockRmsWindowMs: 10,
        ...(metrics.signal || { rmsDb: -25, peakDb: -10, maxBlockRmsDb: -20 }) }
    }
  };
}

const CASES = [
  [{ signal: { rmsDb: -70, peakDb: -60, maxBlockRmsDb: -65 } }, 'SILENCE', 'critical', -55],
  [{ signal: { rmsDb: -55, peakDb: -48, maxBlockRmsDb: -50 } }, 'WEAK_SIGNAL', 'warning', -45],
  [{ signal: { rmsDb: -60, peakDb: -10, maxBlockRmsDb: -20 } }, 'LOW_AVERAGE_LEVEL', 'info', -45],
  [{ noiseFloor: { status: 'measured', estimatedDb: -10 } }, 'HIGH_NOISE', 'critical', -20],
  [{ noiseFloor: { status: 'measured', estimatedDb: -25 } }, 'HIGH_NOISE', 'warning', -30],
  [{ snr: { status: 'measured', estimatedDb: 3 } }, 'LOW_SNR', 'critical', 5],
  [{ snr: { status: 'measured', estimatedDb: 7 } }, 'LOW_SNR', 'warning', 10],
  [{ clipping: { status: 'measured', method: 'sample-saturation', rate: 0.1 } }, 'CLIPPING', 'critical', 0.05],
  [{ clipping: { status: 'measured', method: 'sample-saturation', rate: 0.001 } }, 'CLIPPING', 'warning', 0.01],
  [{ dropouts: { status: 'measured', count: 5 } }, 'DROPOUTS', 'critical', 5],
  [{ dropouts: { status: 'measured', count: 2 } }, 'DROPOUTS', 'warning', 2],
  [{ headroom: { peakDb: -0.3 } }, 'LOW_HEADROOM', 'info', -0.5]
];

test('free scope explains unavailable guided measurements without prescribing another test', () => {
  for (const reason of ['guided-prompts-incomplete', 'guided-segments-too-short', 'quiet-segment-not-steady', 'unknown']) {
    const result = evaluator.evaluateFree(report({ guidedNoise: { status: 'unavailable', reason } }));
    assert.match(result.scope, /comparison of quiet and speaking levels is unavailable/);
    assert.doesNotMatch(result.scope, /Repeat|try again|follow the|change your/i);
  }
});

test('short free preview preserves core findings without manufacturing a voice-quality rating', () => {
  for (const [metrics, id, severity, threshold] of CASES) {
    const result = evaluator.evaluateFree(report(metrics));
    assert.equal(result.findings.length, 1, id);
    const finding = result.findings[0];
    assert.deepEqual([finding.id, finding.severity, finding.threshold], [id, severity, threshold]);
    assert.equal(result.overall.stars, null, id);
    assert.equal(result.overall.score, severity === 'critical' ? 'critical' : severity === 'warning' ? 'fair' : 'limited');
    assert.equal(result.assessment.status, 'limited');
    assert.equal(result.assessment.speech, 'not-measured');

    const partial = evaluator.evaluateFree(report({ ...metrics, coverage: { truncated: true } }));
    assert.deepEqual(plain(partial.findings), plain(result.findings));
    assert.equal(partial.overall.stars, null);
    assert.equal(partial.assessment.status, 'limited');
  }
});

test('existing strict threshold boundaries and high-noise/SNR suppression remain unchanged', () => {
  const fixtures = [
    [{ signal: { rmsDb: -60, peakDb: -50, maxBlockRmsDb: -55 } }, 'WEAK_SIGNAL', 'warning'],
    [{ signal: { rmsDb: -45, peakDb: -40, maxBlockRmsDb: -45 } }, null],
    [{ noiseFloor: { status: 'measured', estimatedDb: -20 } }, 'HIGH_NOISE', 'warning'],
    [{ noiseFloor: { status: 'measured', estimatedDb: -30 } }, null],
    [{ snr: { status: 'measured', estimatedDb: 5 } }, 'LOW_SNR', 'warning'],
    [{ snr: { status: 'measured', estimatedDb: 10 } }, null],
    [{ clipping: { status: 'measured', method: 'sample-saturation', rate: 0.05 } }, 'CLIPPING', 'warning'],
    [{ clipping: { status: 'measured', method: 'sample-saturation', rate: 0 } }, null]
  ];
  for (const [metrics, id, severity] of fixtures) {
    const result = evaluator.evaluateFree(report(metrics));
    if (id) assert.deepEqual([result.findings[0].id, result.findings[0].severity], [id, severity]);
    else assert.equal(result.findings.length, 0);
  }
  const combined = evaluator.evaluateFree(report({
    noiseFloor: { status: 'measured', estimatedDb: -10 }, snr: { status: 'measured', estimatedDb: 3 }
  }));
  assert.deepEqual(plain(combined.findings.map(item => item.id)), ['HIGH_NOISE']);
  assert.equal(combined.overall.stars, null);
});

test('summary contains one highest-priority fact and preserves the first rule when priority ties', () => {
  const base = {
    signal: { rmsDb: -20, peakDb: -5, maxBlockRmsDb: -10 },
    noiseFloor: { status: 'measured', estimatedDb: -10 },
    clipping: { status: 'measured', method: 'sample-saturation', rate: 0.1 },
    dropouts: { status: 'measured', count: 5 }
  };
  const result = evaluator.evaluateFree(report(base));
  assert.equal(result.findings.length, 3);
  assert.equal(result.summary, result.findings.find(item => item.id === 'HIGH_NOISE').message);
  assert.equal(result.overall.stars, null);
  assert.equal((result.summary.match(/[.!?](?:\s|$)/g) || []).length, 1);
  assert.doesNotMatch(result.summary, /full scale|gaps|low level/);

  const warningOnly = evaluator.evaluateFree(report({
    ...base, noiseFloor: { status: 'measured', estimatedDb: -25 },
    clipping: { status: 'measured', method: 'sample-saturation', rate: 0.001 },
    dropouts: { status: 'unavailable' }
  }));
  assert.match(warningOnly.summary, /noise segment has a high level/);
  assert.doesNotMatch(warningOnly.summary, /distortion|interruptions/);
  assert.equal(warningOnly.findings[0].id, 'HIGH_NOISE');
  assert.equal(warningOnly.overall.stars, null);
});

test('all core finding messages are observations without action instructions', () => {
  const instructions = /\b(check|listen|repeat|compare|adjust|increase|decrease|enable|disable)\b|record while speaking|turn (?:on|off)/i;
  for (const [metrics, id] of CASES) {
    const result = evaluator.evaluateFree(report(metrics));
    for (const finding of result.findings) assert.doesNotMatch(finding.message, instructions, id);
    assert.doesNotMatch(result.summary, instructions, id);
    assert(result.summary.length < 110, `${id}: ${result.summary}`);
  }
});

test('limited preview stays short while expanded scope retains unmeasured noise, intelligibility and local-platform limits', () => {
  const input = report({ noiseFloor: { status: 'unavailable' }, snr: { status: 'unavailable' }, coverage: { truncated: true } });
  input.run.type = 'test';
  input.communicationContext = { usage: 'voice-call', access: { formFactor: 'mobile' } };
  input.profile = { approximation: true };
  const result = evaluator.evaluateFree(input);
  assert.equal(result.overall.score, 'limited');
  assert.equal(result.overall.stars, null);
  assert.equal(result.assessment.status, 'limited');
  assert.equal(result.summary, 'Unavailable measurements are not assessed.');
  assert.match(result.scopeSummary, /speech clarity and recipient audio are unmeasured/);
  assert.match(result.scopeSummary, /^First 1 s of saved audio only/);
  assert.doesNotMatch(result.summary, /looks good|excellent|all clear|controlled quiet|intelligibility/i);
  assert.match(result.scope, /Noise or signal-to-noise remains unassessed/);
  assert.match(result.scope, /first part only/);
  assert.match(result.scope, /additional encoding/);
  assert.match(result.scope, /Speech intelligibility.*are not measured/);
  assert.match(result.scope, /native app codecs, processing and networks are not reproduced/);
  assert.doesNotMatch(evaluator.evaluateFree(report()).scope, /remains unassessed/);
});

test('nonfinite noise or SNR remains explicitly unassessed in scope without changing a short issue summary', () => {
  for (const patch of [
    { noiseFloor: { status: 'measured', estimatedDb: NaN } },
    { snr: { status: 'measured', estimatedDb: Infinity } }
  ]) {
    const result = evaluator.evaluateFree(report({ ...patch, signal: { rmsDb: -55, peakDb: -48, maxBlockRmsDb: -50 } }));
    assert.equal(result.assessment.status, 'limited');
    assert.equal(result.overall.stars, null);
    assert.equal(result.summary, 'The recording has a low sound level.');
    assert.match(result.scope, /remains unassessed/);
  }
});

test('insufficient and legacy no-audio reports retain unknown outcomes without a favorable preview', () => {
  for (const audioMetrics of [undefined, {}, { status: 'preview' },
    { ...report().audioMetrics, durationMs: 100 },
    { ...report().audioMetrics, signal: { rmsDb: NaN, peakDb: -10 } }]) {
    const result = evaluator.evaluateFree({ audioMetrics });
    assert.equal(result.overall.score, 'unknown');
    assert.equal(result.overall.stars, null);
    assert.equal(result.assessment.status, 'insufficient');
    assert.match(result.summary, /not enough measured audio/);
    assert.doesNotMatch(result.summary, /No level|looks good/);
    assert.doesNotMatch(result.summary, /\b(record|try|check|adjust|increase|decrease|repeat)\b/i);
  }
  const legacy = evaluator.evaluateFree({ ...report(), run: { type: 'troubleshooting' } });
  assert.equal(legacy.overall.score, 'unknown');
  assert.equal(legacy.overall.stars, null);
  assert.equal(legacy.assessment.status, 'not-measured');
  assert.equal(legacy.findings.length, 0);
  assert.equal(legacy.summary, 'No audio was recorded for this report.');
  assert.match(legacy.scope, /No microphone, application, network or driver performance was measured/);
});

test('free summaries keep numeric evidence and cause interpretations in the detailed findings', () => {
  const fixtures = [
    report({ signal: { rmsDb: -18, peakDb: -12, maxBlockRmsDb: -15, crestFactorDb: 6 },
      ceiling: { status: 'measured', ceilingDb: -12, nearCeilingRate: 0.6, flatTopRate: 0.3 } }),
    report({ truePeak: { status: 'measured', db: 0.8 } })
  ];
  for (const input of fixtures) {
    const result = evaluator.evaluateFree(input);
    assert.match(result.summary, /possible distortion/);
    assert.doesNotMatch(result.summary, /\d|dB|gain|driver|system input|before the browser|re-encoding/i);
    assert.doesNotMatch(result.summary, /\b(check|listen|repeat|compare|adjust|increase|decrease)\b/i);
    assert.match(result.findings[0].message, /dBFS|dBTP/, 'Premium findings retain the actual evidence');
    assert.doesNotMatch(result.scope, /waveform pinned|clipping that happened before capture/);
  }
  const preview = evaluator._generateSummary([{ id: 'FUTURE_RULE', severity: 'warning',
    message: 'Increase input gain by 12 dB to fix the driver.' }]);
  assert.doesNotMatch(preview, /12|gain|driver|increase/i, 'New detailed rules cannot leak instructions into the preview');
});

test('a low sustained level summary does not claim that a brief loud moment was quiet', () => {
  const input = report({ lufs: { status: 'measured', integratedStatus: 'measured', integrated: -50 } });
  const result = evaluator.evaluateFree(input);
  assert.equal(result.findings[0].basis, 'integrated-loudness');
  assert.match(result.summary, /low sound level/);
  assert.doesNotMatch(result.summary, /loudest|peak|LUFS/);
  assert.match(result.findings[0].message, /brief louder moment/);
});

test('basic next steps follow measured findings without inviting technical experimentation', () => {
  for (const [metrics, , severity] of CASES) {
    const result = evaluator.evaluateFree(report(metrics));
    assert.ok(result.nextStep);
    assert.doesNotMatch(result.nextStep, /bitrate|sample rate|codec|buy|premium|increase.*gain/i);
    if (severity === 'info') assert.match(result.nextStep, /no setting change is needed/);
  }
  const quiet = evaluator.evaluateFree(report({ signal: { rmsDb: -55, peakDb: -48, maxBlockRmsDb: -50 } }));
  assert.match(quiet.nextStep, /selected microphone.*speaking distance/);
  const mixed = evaluator.evaluateFree(report({ signal: { rmsDb: -55, peakDb: 0, maxBlockRmsDb: -50 },
    clipping: { status: 'measured', method: 'sample-saturation', rate: 0.01 } }));
  assert.match(mixed.nextStep, /distorted.*farther.*lower/);
  assert.doesNotMatch(mixed.nextStep, /closer|increase|turn up/);
  const silent = evaluator.evaluateFree(report({ signal: { rmsDb: -80, peakDb: -70, maxBlockRmsDb: -75 } }));
  assert.match(silent.nextStep, /selected and unmuted/);
  assert.doesNotMatch(silent.nextStep, /gain|fault/);
});

test('unavailable optional measurements do not require repeating a usable recording', () => {
  const input = report({ noiseFloor: { status: 'unavailable' }, snr: { status: 'unavailable' },
    guidedNoise: { status: 'unavailable', reason: 'processing-limits-snr-estimate' } });
  const result = evaluator.evaluateFree(input);
  assert.match(result.nextStep, /no setting change is needed/);
  assert.doesNotMatch(result.nextStep, /record again|repeat|another sample/);
  const insufficient = evaluator.evaluateFree({ audioMetrics: { status: 'unavailable' } });
  assert.match(insufficient.nextStep, /selected and unmuted.*until the test finishes/);
  assert.equal(insufficient.assessment.status, 'insufficient');
});
