const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const constants = vm.runInNewContext(read('js/modules/constants.js').replaceAll('export const ', 'const ')
  + '\n({QUALITY, VU_METER})', { location: { hostname: 'localhost' } });
function freeEvaluator() {
  return vm.runInNewContext(read('js/modules/ReportEvaluator.js').replace(/^import .*;$/gm, '')
    .replace('export default reportEvaluator;', 'reportEvaluator;'), { ...constants });
}
const server = require('../../server/premium-report-evaluator.js').evaluatePremiumReport;
let worker;
test.before(async () => {
  ({ evaluatePremiumReport: worker } = await import('../../worker/premium-report-evaluator.js'));
});

function report(overrides = {}) {
  return {
    sessionId: 'same-session', run: { id: 'run-a', type: 'record' },
    profile: { id: 'raw', constraints: { noiseSuppression: false } },
    audioMetrics: {
      status: 'measured', source: 'decoded-file-pcm', sampleCount: 336000, durationMs: 7000,
      signal: { rmsDb: -23, peakDb: -10 }, coverage: { truncated: false },
      noiseFloor: { status: 'unavailable', estimatedDb: null },
      snr: { status: 'unavailable', estimatedDb: null },
      clipping: { status: 'measured', method: 'sample-saturation', rate: 0, eventCount: 0 },
      headroom: { peakDb: -10, db: 10 },
      dropouts: { status: 'unavailable', count: null, totalDurationMs: null },
      silence: { count: 0, totalDurationMs: 0 },
      lufs: { integrated: -23, shortTerm: -23 }, ...overrides
    }
  };
}

test('empty, preview, short and nonfinite measurements stay insufficient in free and premium', () => {
  for (const m of [null, {}, { status: 'preview', sampleCount: 0 },
    { status: 'measured', sampleCount: 0, durationMs: 7000, signal: { rmsDb: -180 } },
    { status: 'measured', sampleCount: 100, durationMs: 20, signal: { rmsDb: -20 } },
    { status: 'measured', sampleCount: 100000, durationMs: 7000, signal: { rmsDb: NaN } }]) {
    const r = { audioMetrics: m };
    const free = freeEvaluator().evaluateFree(r);
    assert.equal(free.overall.score, 'unknown');
    assert.equal(free.overall.stars, null);
    assert.doesNotMatch(free.summary, /looks good|No issues detected/);
    assert.equal(server(r).recommendations[0].id, 'INSUFFICIENT_AUDIO');
    assert.deepEqual(plain(server(r)), plain(worker(r)));
  }
});

test('unmeasured SNR/noise stay null, generate no bad-noise claim, and cannot earn a complete score', () => {
  const r = report();
  r.profile.id = 'discord';
  const free = freeEvaluator().evaluateFree(r);
  assert.equal(free.overall.score, 'limited');
  assert.equal(free.overall.stars, null);
  assert.equal(free.findings.length, 0);
  const premium = server(r);
  for (const key of ['snr', 'noiseFloor', 'dropouts']) {
    const m = premium.metrics.find(m => m.key === key);
    assert.equal(m.value, null);
    assert.equal(m.rating, 'info');
  }
  assert(!premium.recommendations.some(r => r.id === 'MEASURED_LOW_SNR'));
});

test('supplied noise and SNR measurements are not perceptual calibration; critical findings remain visible', () => {
  const r = report({ noiseFloor: { status: 'measured', estimatedDb: -60 }, snr: { status: 'measured', estimatedDb: 30 } });
  assert.equal(freeEvaluator().evaluateFree(r).overall.stars, null);
  r.audioMetrics.headroom.peakDb = -0.3;
  let free = freeEvaluator().evaluateFree(r);
  assert.equal(free.findings[0].id, 'LOW_HEADROOM');
  assert.equal(free.findings[0].severity, 'info');
  assert.equal(free.overall.stars, null);
  r.audioMetrics.clipping.rate = 0.2;
  free = freeEvaluator().evaluateFree(r);
  assert.equal(free.overall.score, 'critical');
  assert.equal(free.overall.stars, null);
  assert(!free.findings.some(f => f.id === 'LOW_HEADROOM'));
  r.audioMetrics.signal = { rmsDb: -180, peakDb: -180, maxBlockRmsDb: -180 };
  assert(freeEvaluator().evaluateFree(r).findings.some(f => f.id === 'SILENCE' && f.severity === 'critical'));
});

test('uncontrolled low-level estimates and pauses cannot become noise or connection diagnoses', () => {
  const r = report({
    noiseFloor: { status: 'unavailable', estimatedDb: -10 },
    snr: { status: 'unavailable', estimatedDb: 0 },
    silence: { count: 10, totalDurationMs: 3000 },
    dropouts: { status: 'unavailable', count: 20 }
  });
  assert.equal(freeEvaluator().evaluateFree(r).findings.length, 0);
  const detailed = server(r);
  assert.equal(detailed.metrics.find(m => m.key === 'noiseFloor').value, null);
  assert(!detailed.recommendations.some(r => r.id === 'MEASURED_NOISE' || r.id === 'MEASURED_LOW_SNR'));
  assert.doesNotMatch(JSON.stringify(detailed), /connection is unstable|Check your connection or USB|low-quality mic|better mic/);
});

test('bitrate differences stay observations; local test and file coverage are explicit', () => {
  const r = report();
  r.run.type = 'test';
  r.loopback = { bitrateDeviation: -0.8, requestedKbps: 128, actualKbps: 24 };
  r.recording = { bitrateDeviation: 0, requestedBitrate: 1000, actualBitrate: 1000 };
  r.audioMetrics.coverage.truncated = true;
  const free = freeEvaluator().evaluateFree(r);
  assert(!free.findings.some(f => f.id === 'CODEC_LOSS'));
  assert.match(free.scope, /first part only/);
  assert.match(free.scope, /additional encoding/);
  const bitrate = server(r).metrics.find(m => m.key === 'bitrateDeviation');
  assert.equal(bitrate.value, -80);
  assert.equal(bitrate.rating, 'info');
});

test('spectrum/system observations never diagnose hardware quality or CPU/network cause; server/Worker agree', () => {
  const fixtures = [report(), report({ signal: { rmsDb: -180, peakDb: -180 } }), report({ headroom: { peakDb: -0.2, db: 0.2 } })];
  fixtures[0].deepAnalysis = { status: 'ready', bands: { presence: -30 }, spectralFlatness: 0.7, noiseFloorDb: -10 };
  fixtures[0].system = { correlation: { findings: [{ id: 'CPU_LIKELY', message: 'CPU overload!' }, { id: 'TAB_HIDDEN' }] } };
  for (const r of fixtures) assert.deepEqual(plain(server(r)), plain(worker(r)));
  const result = server(fixtures[0]);
  assert(result.recommendations.some(r => r.id === 'LOW_TREBLE_ENERGY'));
  assert.doesNotMatch(JSON.stringify(result), /CPU overload|low-quality|better mic|MIC_SELF_NOISE|MIC_NARROWBAND/);
});

test('voice-call and voice-message results are identical across mobile, desktop and unknown access', () => {
  const evaluator = freeEvaluator();
  const fixtures = [report(), report({ headroom: { peakDb: -0.3, db: 0.3 } }),
    report({ signal: { rmsDb: -70, peakDb: -20, maxBlockRmsDb: -23 } }),
    report({ signal: { rmsDb: -50, peakDb: -47, maxBlockRmsDb: -50 } }),
    report({ clipping: { status: 'measured', method: 'sample-saturation', rate: 0.2 } })];
  for (const r of fixtures) {
    let expected;
    for (const usage of ['voice-call', 'voice-message']) for (const formFactor of ['mobile', 'desktop', 'unknown']) {
      r.communicationContext = { usage, access: { formFactor, source: 'user-agent' }, client: 'browser' };
      r.profile = { id: usage === 'voice-call' ? 'whatsapp-telegram-call' : 'whatsapp-voice', approximation: true };
      r.run.type = usage === 'voice-call' ? 'test' : 'record';
      r.deepAnalysis = { status: 'ready', bands: { presence: -40 } };
      r.loopback = { requestedKbps: 128, actualKbps: 16, bitrateDeviation: -0.875 };
      r.recording = { requestedKbps: 128, actualKbps: 16, bitrateDeviation: -0.875 };
      const free = evaluator.evaluateFree(r);
      const decision = plain({ overall: free.overall, findings: free.findings });
      if (!expected) expected = decision;
      assert.deepEqual(decision, expected);
      assert.equal(free.overall.stars, null, 'partial checks cannot become a general voice-quality rating');
      assert.match(free.scope, /Speech intelligibility.*not measured/);
      assert.match(free.scope, /native app codecs/);
      assert.equal(/browser \(inferred\)/.test(free.scope), formFactor !== 'unknown');
      const premium = server(r);
      assert.deepEqual(plain(premium), plain(worker(r)));
      for (const id of ['LOW_HEADROOM', 'LOW_AVERAGE_LEVEL', 'LOW_TREBLE_ENERGY']) {
        const observation = premium.recommendations.find(item => item.id === id);
        if (observation) {
          assert.equal(observation.severity, 'info');
          assert.equal(observation.category, 'observation');
        }
      }
      assert.equal(premium.metrics.find(item => item.key === 'actualBitrate').rating, 'info');
    }
  }
});

test('padding the same PCM with pauses cannot lower its level assessment, but quiet audio remains flagged', async () => {
  const { analyzePcm } = await import('../modules/utils/pcmAnalysis.js');
  const sampleRate = 16000;
  const sample = Float32Array.from({ length: sampleRate }, (_, i) => 10 ** (-34 / 20) * Math.sin(2 * Math.PI * 220 * i / sampleRate));
  const padded = new Float32Array(sampleRate * 30); padded.set(sample, sampleRate * 5);
  const evaluator = freeEvaluator();
  const recorded = pcm => report(analyzePcm([pcm], sampleRate));
  const continuous = recorded(sample), paused = recorded(padded);
  assert(paused.audioMetrics.signal.rmsDb < -45);
  assert.deepEqual(plain(evaluator.evaluateFree(paused).overall), plain(evaluator.evaluateFree(continuous).overall));
  assert(!evaluator.evaluateFree(paused).findings.some(f => ['WEAK_SIGNAL', 'SILENCE'].includes(f.id)));
  assert.equal(evaluator.evaluateFree(paused).findings.find(f => f.id === 'LOW_AVERAGE_LEVEL').severity, 'info');
  assert(!server(paused).recommendations.some(f => f.id === 'LOW_RECORDED_LEVEL'));
  const quiet = recorded(sample.map(value => value * 0.25));
  assert(evaluator.evaluateFree(quiet).findings.some(f => f.id === 'WEAK_SIGNAL' && f.severity === 'warning'));
  assert(server(quiet).recommendations.some(f => f.id === 'LOW_RECORDED_LEVEL' && f.severity === 'warning'));
  const silent = recorded(new Float32Array(sampleRate));
  assert(evaluator.evaluateFree(silent).findings.some(f => f.id === 'SILENCE' && f.severity === 'critical'));
});

test('legacy averages and ungraded format measurements do not manufacture a voice-quality penalty', () => {
  const r = report({ signal: { rmsDb: -65, peakDb: -20 },
    lufs: { integrated: -40, shortTerm: -40 }, channels: [{ rmsDb: -65 }],
    dynamicRange: { status: 'measured', db: 1 }, stability: { status: 'measured', dbStdDev: 20 } });
  const free = freeEvaluator().evaluateFree(r);
  assert.equal(free.overall.score, 'limited');
  assert(free.findings.every(f => f.severity === 'info'));
  const detailed = server(r);
  assert(!detailed.recommendations.some(f => f.id === 'LOW_RECORDED_LEVEL'));
  for (const key of ['lufsIntegrated', 'dynamicRange', 'stability']) {
    assert.equal(detailed.metrics.find(m => m.key === key).rating, 'info');
  }
});

test('fixed-window decisions and Premium guidance do not depend on transient position', async () => {
  const { analyzePcm } = await import('../modules/utils/pcmAnalysis.js');
  const sampleRate = 48000, length = sampleRate * 3 + 1;
  const evaluator = freeEvaluator();
  const results = [sampleRate, length - 1].map(position => {
    const pcm = Float32Array.from({ length }, (_, i) => 10 ** (-65 / 20) * Math.sin(2 * Math.PI * 1000 * i / sampleRate));
    pcm[position] = 0.1;
    const r = report(analyzePcm([pcm], sampleRate));
    return { free: evaluator.evaluateFree(r), detailed: server(r) };
  });
  for (const result of results) {
    // A -65 dBFS tone with one spike is quiet almost everywhere: the gated loudness
    // reports silence even though the loudest 10 ms window only reads "weak".
    const level = result.free.findings.find(f => ['SILENCE', 'WEAK_SIGNAL'].includes(f.id));
    assert.equal(level?.id, 'SILENCE');
    assert.equal(level.basis, 'integrated-loudness');
    assert(result.detailed.recommendations.some(f => f.id === 'LOW_RECORDED_LEVEL' && f.severity === 'critical'));
    assert.equal(result.free.overall.stars, null);
  }
  // The decision is position-independent. The gated loudness value itself may differ
  // by a fraction of a dB when the spike lands inside or outside a complete 400 ms block.
  const decision = free => plain({ ...free, findings: free.findings.map(({ value, ...rest }) => rest) });
  assert.deepEqual(decision(results[0].free), decision(results[1].free));
});

test('legacy unequal-window maxima cannot drive or appear as current fixed-window measurements', () => {
  const r = report({ signal: { rmsDb: -65, peakDb: -20, maxBlockRmsDb: -50 } });
  assert(!freeEvaluator().evaluateFree(r).findings.some(f => f.id === 'WEAK_SIGNAL'));
  const detailed = server(r);
  assert(!detailed.recommendations.some(f => f.id === 'LOW_RECORDED_LEVEL'));
  assert.equal(detailed.metrics.find(m => m.key === 'maxBlockRms').value, null);
  assert.equal(detailed.metrics.find(m => m.key === 'levelWindowMs').value, null);
});

test('Premium separates actual RTP, saved file, requested targets and unknown recipient quality', () => {
  const r = report(); r.run.type = 'test';
  r.profile = { approximation: true, evidence: { verifiedAt: '2026-09-05' } };
  r.loopback = { requestedKbps: 64, actualKbps: 24,
    senderCodec: { mimeType: 'audio/opus' }, receiverCodec: { mimeType: 'audio/PCMU' } };
  r.recording = { mimeType: 'audio/webm;codecs=opus', encoderReportedBitrate: 32000, actualBitrate: 35000 };
  const detailed = server(r), metrics = Object.fromEntries(detailed.metrics.map(m => [m.key, m]));
  assert.equal(metrics.senderCodec.value, 'audio/opus');
  assert.equal(metrics.receiverCodec.value, 'audio/PCMU');
  assert.equal(metrics.fileMimeType.value, 'audio/webm;codecs=opus');
  assert.equal(metrics.targetBitrate.value, 64);
  assert.equal(metrics.actualBitrate.value, 24);
  assert.equal(metrics.fileEncoderBitrate.value, 32);
  assert.match(metrics.fileEncoderBitrate.label, /Target.*reported/);
  for (const key of ['speechAssessment', 'recipientAssessment']) assert.equal(metrics[key].value, 'Not measured');
  for (const key of ['targetClientVersion', 'targetClientCodec']) assert.equal(metrics[key].value, null);
  assert.equal(metrics.platformEvidenceDate.value, '2026-09-05');
  assert.deepEqual(plain(detailed), plain(worker(r)));
  r.loopback = {}; r.recording = {}; r.profile.evidence = null;
  for (const key of ['senderCodec', 'receiverCodec', 'fileMimeType', 'fileEncoderBitrate', 'platformEvidenceDate']) {
    assert.equal(server(r).metrics.find(m => m.key === key).value, null);
  }
});

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function uiHarness(fetchDetailedReport, loadPdf) {
  const premiumAccess = { isUnlocked: () => premiumAccess.unlocked, unlocked: true, fetchDetailedReport };
  let code = read('js/ui/ReportPanelUI.js').replace(/^import[\s\S]*?from [^;]+;\r?\n/gm, '');
  code = code.replace("import('../modules/ReportPdfExporter.js')", 'loadPdf()')
    .replace('const reportPanelUI = new ReportPanelUI();', '')
    .replace('export default reportPanelUI;', 'ReportPanelUI;');
  const UI = vm.runInNewContext(code, { premiumAccess, reportEvaluator: freeEvaluator(), structuredClone,
    log: { ui() {}, warning() {}, error() {} }, eventBus: { emit() {} }, EVENTS: {}, loadPdf });
  const ui = Object.create(UI.prototype);
  Object.assign(ui, { currentReport: null, _lastDetailed: null, _detailedReport: null, _premiumRequestId: 0, _pendingPremiumReport: null,
    rendered: null, _renderMetrics(value) { this.rendered = value; }, _renderRecommendations() {}, _setPremiumStatus() {},
    _renderScoreBadge() {}, _renderOverall() {}, _renderFindings() {}, _syncPremiumState() {}, open() {}, downloadBtn: { disabled: false } });
  return { ui, premiumAccess };
}

test('reversed premium responses and stale failures cannot replace the latest report or its PDF data', async () => {
  const a = deferred(), b = deferred();
  const { ui } = uiHarness(r => r.run.id === 'run-a' ? a.promise : b.promise);
  const original = report();
  ui._renderReport(original);
  const pa = ui._renderPremiumDetails();
  original.run.id = 'mutated-outside-ui';
  const latest = report(); latest.run.id = 'run-b';
  ui._renderReport(latest);
  const pb = ui._renderPremiumDetails();
  b.resolve({ metrics: ['B'], recommendations: [] }); await pb;
  a.resolve({ metrics: ['A'], recommendations: [] }); await pa;
  assert.deepEqual(ui.rendered, ['B']);
  assert.equal(ui._detailedReport.run.id, 'run-b');
  const stale = deferred();
  const h = uiHarness(() => stale.promise);
  h.ui._renderReport(report()); const pending = h.ui._renderPremiumDetails();
  h.ui._renderReport(latest); h.ui.rendered = ['latest'];
  stale.reject(new Error('old request failed')); await pending;
  assert.deepEqual(h.ui.rendered, ['latest']);
});

test('a pending premium response cannot restore details after entitlement locks', async () => {
  const response = deferred();
  const { ui, premiumAccess } = uiHarness(() => response.promise);
  ui._renderReport(report()); const pending = ui._renderPremiumDetails();
  premiumAccess.unlocked = false; ui._clearPremiumDetails();
  response.resolve({ metrics: ['locked'], recommendations: [] }); await pending;
  assert.equal(ui._lastDetailed, null);
});

test('a successful premium retry reveals the same report only after an authorized response', async () => {
  let attempt = 0;
  const { ui } = uiHarness(async () => { if (++attempt === 1) throw new Error('temporary'); return { metrics: ['retry'], recommendations: [] }; });
  const classes = () => { const values = new Set(); return { add: value => values.add(value), remove: value => values.delete(value), contains: value => values.has(value) }; };
  ui.detailedEl = { classList: classes() }; ui.premiumOverlayEl = { classList: classes(), hidden: false };
  ui.premiumCtaEl = { disabled: false };
  ui._renderReport(report()); await ui._renderPremiumDetails();
  assert.equal(ui.detailedEl.hidden, true);
  assert.equal(ui.premiumCtaEl.textContent, 'Retry instructions');
  await ui._startPremiumCheckout();
  assert.equal(ui.detailedEl.hidden, false);
  assert.equal(ui.premiumCtaEl.disabled, false);
  assert.equal(ui.premiumOverlayEl.hidden, true);
  assert.deepEqual(ui.rendered, ['retry']);
});

test('account change clears an old report before syncing the new premium state', () => {
  const { ui } = uiHarness(async () => ({}));
  const order = [];
  ui._premiumOwnerId = 'A'; ui.clearReport = () => order.push('clear'); ui._syncPremiumState = () => order.push('sync');
  ui._onPremiumState({ userId: 'B' });
  assert.deepEqual(order, ['clear', 'sync']);
});

test('locked legacy purchase errors remain actionable when the report is reopened', () => {
  const { ui, premiumAccess } = uiHarness(async () => ({}));
  premiumAccess.unlocked = false;
  const lastError = 'Open Sign in, then Restore an earlier purchase using your license key.';
  premiumAccess.getState = () => ({ lastError });
  delete ui._syncPremiumState;
  ui._setPremiumStatus = value => { ui.statusMessage = value; };
  ui._onPremiumState({ lastError });
  assert.equal(ui.statusMessage, lastError);
  ui.statusMessage = '';
  ui._syncPremiumState();
  assert.equal(ui.statusMessage, lastError);
  ui._onPremiumState({ lastError: '' });
  assert.equal(ui.statusMessage, '');
});

test('PDF lazy-load captures one report and matching premium details before another report arrives', async () => {
  const loader = deferred(); let downloaded;
  const { ui } = uiHarness(() => Promise.resolve({}), () => loader.promise);
  ui._renderReport(report());
  ui._detailedReport = ui.currentReport;
  ui._lastDetailed = { metrics: ['A'], recommendations: [] };
  const pending = ui._downloadPdf();
  const next = report(); next.run.id = 'run-b'; ui._renderReport(next);
  loader.resolve({ downloadReportPdf: async payload => { downloaded = payload; } }); await pending;
  assert.equal(downloaded.report.run.id, 'run-a');
  assert.deepEqual(downloaded.detailed.metrics, ['A']);
  assert.equal(ui.downloadBtn.disabled, false);
});

test('PDF findings preserve insufficient and limited outcomes, and unknown scores have no stars', () => {
  const code = read('js/modules/ReportPdfExporter.js').replace(/^import .*;$/gm, '').replace('export async function ', 'async function ');
  const pdf = vm.runInNewContext(code + '\n({writeFindings, writeOverall})');
  for (const r of [{ audioMetrics: null }, report()]) {
    const free = freeEvaluator().evaluateFree(r), text = [];
    const writer = { sectionTitle() {}, body(value) { text.push(value); } };
    pdf.writeFindings(writer, free); pdf.writeOverall(writer, free);
    assert.doesNotMatch(text.join(' '), /looks good|No issues detected|0\/5/);
    assert(text.includes(free.summary));
  }
  const { ui } = uiHarness(() => Promise.resolve({}));
  assert.equal(ui._buildStars(null), '');
});

test('measured observations retain neutral presentation inside the premium report and PDF', () => {
  const r = report({ headroom: { peakDb: -0.3, db: 0.3 } });
  const free = freeEvaluator().evaluateFree(r);
  const { ui } = uiHarness(() => Promise.resolve({}));
  delete ui._renderFindings;
  let items;
  ui.findingsEl = { replaceChildren(...values) { items = values; } };
  ui._createIconTextItem = (className, icon, message) => ({ className, icon, message });
  ui._renderFindings(free);
  assert.equal(items[0].className, 'finding-item finding-item--info');
  assert.equal(items[0].icon, 'i');
  assert.match(items[0].message, /^Observation:/);
  const code = read('js/modules/ReportPdfExporter.js').replace(/^import .*;$/gm, '').replace('export async function ', 'async function ');
  const pdf = vm.runInNewContext(code + '\n({writeFindings, writeOverall})');
  const text = [], writer = { sectionTitle() {}, body(value) { text.push(value); } };
  pdf.writeFindings(writer, free); pdf.writeOverall(writer, free);
  assert.doesNotMatch(text.join(' '), /WARNING|4\/5/);
  assert.match(text.join(' '), /INFO|Observation/i);
});

test('premium PDF separates observations and test scope from corrective advice', () => {
  const r = report({ headroom: { peakDb: -0.3, db: 0.3 } });
  r.profile = { approximation: true };
  r.deepAnalysis = { status: 'ready', bands: { presence: -40 } };
  const detailed = server(r);
  const code = read('js/modules/ReportPdfExporter.js').replace(/^import .*;$/gm, '').replace('export async function ', 'async function ');
  const pdf = vm.runInNewContext(code + '\n({writeRecommendations})');
  const text = [], writer = { sectionTitle() {}, gap() {}, body(value) { text.push(value); }, small(value) { text.push(value); } };
  pdf.writeRecommendations(writer, detailed.recommendations);
  assert(text.includes('Test scope'));
  assert(text.includes('Observations — no quality penalty'));
  assert(!text.includes('observation'));
  assert.doesNotMatch(text.join(' '), /Fix:/);
  for (const id of ['LOW_HEADROOM', 'LOW_TREBLE_ENERGY']) {
    const item = detailed.recommendations.find(item => item.id === id);
    assert(item, id);
    assert(text.includes(item.action));
  }
});

test('problem descriptions never change audio scoring and guide-only reports never assess stale audio', () => {
  const measured = report();
  const evaluator = freeEvaluator();
  const expected = plain(evaluator.evaluateFree(measured));
  for (const os of ['windows', 'ios', 'android', 'unknown']) {
    measured.troubleshooting = { version: 1, os, osSource: 'user-selected', symptom: 'cuts', scope: 'all-apps', trigger: 'under-load' };
    assert.deepEqual(plain(evaluator.evaluateFree(measured)), expected);
  }
  measured.run.type = 'troubleshooting';
  const guide = evaluator.evaluateFree(measured);
  assert.equal(guide.overall.stars, null);
  assert.equal(guide.assessment.status, 'not-measured');
  assert.equal(guide.findings.length, 0);
  assert.doesNotMatch(guide.summary, /Record a short|looks good/);
});

test('PDF guide preserves steps, evidence and sources without suggesting a measured finding', async () => {
  const { describeTroubleshootingContext } = await import('../modules/TroubleshootingContext.js');
  const r = { run: { type: 'troubleshooting' }, troubleshooting: { version: 1, os: 'windows', osSource: 'user-selected', symptom: 'no-input' } };
  const code = read('js/modules/ReportPdfExporter.js').replace(/^import .*;$/gm, '').replace('export async function ', 'async function ');
  const pdf = vm.runInNewContext(code + '\n({writeTroubleshootingContext, writeRecommendations, writeFindings, writeOverall})', { describeTroubleshootingContext });
  const text = [], writer = { sectionTitle(value) { text.push(value); }, gap() {}, body(value) { text.push(value); },
    small(value) { text.push(value); }, keyValue(key, value) { text.push(`${key}: ${value}`); } };
  const free = freeEvaluator().evaluateFree(r), detailed = server(r);
  pdf.writeOverall(writer, free); pdf.writeFindings(writer, free);
  pdf.writeTroubleshootingContext(writer, r); pdf.writeRecommendations(writer, detailed.recommendations);
  assert.match(text.join(' '), /Windows \(you selected\)/);
  assert(!text.includes('Findings'));
  assert(!text.includes('Overall Score'));
  for (const item of detailed.recommendations) {
    assert(text.includes(item.evidence));
    for (const step of item.steps) assert(text.some(line => line.endsWith(step)));
    for (const source of item.sources) assert(text.some(line => line.includes(source.url)));
    assert(text.some(line => line.endsWith(item.expected)));
    assert(text.some(line => line.endsWith(item.next)));
  }
});
