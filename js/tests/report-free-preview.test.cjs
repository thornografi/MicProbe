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
  .replace('export default reportEvaluator;', 'reportEvaluator;'), { ...constants });
const plain = value => JSON.parse(JSON.stringify(value));

function report(metrics = {}) {
  return {
    run: { id: 'preview-a', type: 'record' },
    audioMetrics: {
      status: 'measured', source: 'decoded-file-pcm', sampleCount: 48000, durationMs: 1000,
      signal: { rmsDb: -25, peakDb: -10, maxBlockRmsDb: -20 },
      clipping: { status: 'measured', method: 'sample-saturation', rate: 0 },
      noiseFloor: { status: 'measured', estimatedDb: -60 },
      snr: { status: 'measured', estimatedDb: 30 },
      coverage: { truncated: false },
      dropouts: { status: 'unavailable' }, ...metrics,
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
    signal: { rmsDb: -55, peakDb: -48, maxBlockRmsDb: -50 },
    noiseFloor: { status: 'measured', estimatedDb: -10 },
    clipping: { status: 'measured', method: 'sample-saturation', rate: 0.1 },
    dropouts: { status: 'measured', count: 5 }
  };
  const result = evaluator.evaluateFree(report(base));
  assert.equal(result.findings.length, 4);
  assert.equal(result.summary, result.findings.find(item => item.id === 'HIGH_NOISE').message);
  assert.equal(result.overall.stars, null);
  assert.equal((result.summary.match(/[.!?](?:\s|$)/g) || []).length, 1);
  assert.doesNotMatch(result.summary, /full scale|gaps|low level/);

  const warningOnly = evaluator.evaluateFree(report({
    ...base, noiseFloor: { status: 'measured', estimatedDb: -25 },
    clipping: { status: 'measured', method: 'sample-saturation', rate: 0.001 },
    dropouts: { status: 'unavailable' }
  }));
  assert.equal(warningOnly.summary, warningOnly.findings[0].message);
  assert.equal(warningOnly.findings[0].id, 'WEAK_SIGNAL');
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
  assert.equal(result.summary, 'No low-level, pinned-ceiling, true-peak or full-scale sample flags were detected.');
  assert.match(result.scopeSummary, /speech clarity and recipient audio are unmeasured/);
  assert.match(result.scopeSummary, /^First 1 s of saved audio only/);
  assert.doesNotMatch(result.summary, /looks good|excellent|all clear|controlled quiet|intelligibility/i);
  assert.match(result.scope, /Noise or signal-to-noise remains unassessed without controlled quiet and speaking segments/);
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
    assert.equal(result.summary, 'Even the loudest part of this recording has a low level.');
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
  }
  const legacy = evaluator.evaluateFree({ ...report(), run: { type: 'troubleshooting' } });
  assert.equal(legacy.overall.score, 'unknown');
  assert.equal(legacy.overall.stars, null);
  assert.equal(legacy.assessment.status, 'not-measured');
  assert.equal(legacy.findings.length, 0);
  assert.equal(legacy.summary, 'No audio was recorded for this report.');
  assert.match(legacy.scope, /No microphone, application, network or driver performance was measured/);
});
