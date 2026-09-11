const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { jsPDF } = require('../lib/jspdf/jspdf.umd.min.js');
const { normalizeEnvironment, OS_NAMES, BROWSER_NAMES } = require('../modules/EnvironmentContext.js');

function createPdfCapture({ formatReviewDifference, formatPlatformComparison } = {}) {
  const draws = [];
  let doc, output;
  function RecordedPDF(options) {
    doc = new jsPDF(options);
    const text = doc.text.bind(doc);
    doc.text = (value, x, y, options) => {
      draws.push({ value, x, y, width: doc.getTextWidth(String(value)), page: doc.internal.getCurrentPageInfo().pageNumber });
      return text(value, x, y, options);
    };
    return doc;
  }
  const source = fs.readFileSync(path.join(__dirname, '../modules/ReportPdfExporter.js'), 'utf8')
    .replace(/^import .*;$/gm, '').replaceAll('import.meta.url', JSON.stringify('http://localhost:8080/js/modules/ReportPdfExporter.js'))
    .replace('export async function ', 'async function ');
  const exporter = vm.runInNewContext(source + '\ndownloadReportPdf', {
    ...require('../modules/MeasurementValue.js'),
    structuredClone, jspdf: { jsPDF: RecordedPDF }, formatReviewDifference, formatPlatformComparison,
    normalizeEnvironment, OS_NAMES, BROWSER_NAMES,
    describeTroubleshootingContext: () => [['Operating system', 'Windows'], ['Problem', 'Speech is quiet']],
    downloadBlob: (blob, filename) => { output = { blob, filename }; }
  });
  return { draws, exporter, get doc() { return doc; }, get output() { return output; } };
}

async function verifyOutput(output) {
  const bytes = Buffer.from(await output.blob.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  if (process.env.MICPROBE_PDF_QA_DIR) {
    fs.mkdirSync(process.env.MICPROBE_PDF_QA_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MICPROBE_PDF_QA_DIR, output.filename), bytes);
  }
}

test('PDF uses accepted summary and small nonzero metrics, without old review questions or comparisons', async () => {
  const capture = createPdfCapture(), params = summaryFixture('accepted-pdf');
  params.detailed = { summary: { ...params.free, summary: 'Accepted independent result.' },
    findings: [{ severity: 'warning', message: 'A measured peak finding.' }],
    metrics: [{ label: 'Full-scale samples', value: 0.00003, unit: '%' }], recommendations: [],
    review: { runId: 'accepted-pdf', state: { comparison: { runId: 'other' } }, decision: { title: 'Old interactive result' } } };
  params.free.summary = 'A stale recalculated summary';
  await capture.exporter(params);
  const text = capture.draws.map(draw => draw.value).join('\n');
  assert.match(text, /Accepted independent result/);
  assert.match(text, /0\.00003 %/);
  assert.doesNotMatch(text, /Old interactive result|A stale recalculated summary|Saved version|user-reported/);
  await verifyOutput(capture.output);
});

test('PDF displays independent-1 scope characters as text without changing the accepted result', async () => {
  const capture = createPdfCapture(), params = summaryFixture('legacy-scope-pdf');
  const sentence = 'Details for this earlier recording were prepared when it was reopened.';
  params.detailed.summary = { ...params.free, scope: [...params.free.scope, sentence] };
  const accepted = structuredClone(params.detailed);
  await capture.exporter(params);
  const text = capture.draws.map(draw => draw.value).join(' ').replace(/\s+/g, ' ');
  assert.ok(text.includes(`${params.free.scope} ${sentence}`));
  assert.deepEqual(params.detailed, accepted);
  await verifyOutput(capture.output);
});

function summaryFixture(id) {
  return {
    canDownload: () => true,
    report: {
      generatedAt: '2026-09-05T12:00:00Z', run: { id, type: 'record' }, sessionId: id,
      device: { micName: 'Fixture microphone 733', channelCount: 1, sampleRate: 48000 },
      profile: { id: 'raw', label: 'Raw Recording', category: 'record' },
      troubleshooting: { symptom: 'quiet' }
    },
    free: {
      overall: { label: 'Limited assessment', stars: null },
      summary: 'The saved recording is quiet.',
      scopeSummary: 'Saved audio only; speech clarity and recipient audio are unmeasured.',
      scope: 'Saved audio only. The recipient app and system drivers were not measured.',
      findings: [{ severity: 'warning', message: 'The loudest short window is low. Compare the input level.' }]
    },
    detailed: {
      metrics: [{ label: 'Loudest Short-window Level', value: -48, unit: 'dBFS', rating: 'warning' }],
      recommendations: [{
        category: 'troubleshooting', reason: 'Check the input level in Windows.',
        steps: ['Open the Windows microphone settings and check the selected input.'],
        expected: 'The input meter responds when you speak.'
      }]
    }
  };
}

test('PDF refuses missing details or authorization without creating a document', async () => {
  const capture = createPdfCapture();
  const fixture = summaryFixture('free-summary');
  for (const missing of [{ detailed: null }, { canDownload: undefined }, { canDownload: () => false }]) {
    assert.equal(await capture.exporter({ ...fixture, ...missing }), false);
  }
  assert.equal(capture.doc, undefined);
  assert.equal(capture.output, undefined);
});

test('PDF rechecks authorization after the library loads', async () => {
  const capture = createPdfCapture();
  let unlocked = true;
  const pending = capture.exporter({ ...summaryFixture('revoked'), canDownload: () => unlocked });
  unlocked = false;
  assert.equal(await pending, false);
  assert.equal(capture.doc, undefined);
  assert.equal(capture.output, undefined);
});

test('Premium PDF retains findings, device context, metrics and instructions as optional app content', async () => {
  const capture = createPdfCapture();
  const fixture = summaryFixture('premium-details');
  await capture.exporter(fixture);
  const text = capture.draws.map(draw => draw.value).join(' ').replace(/\s+/g, ' ');
  for (const visible of ['Summary', 'Findings', fixture.free.findings[0].message, fixture.free.scope,
    'Device & Profile', fixture.report.device.micName, 'Your Troubleshooting Context', 'Operating system: Windows',
    'Detailed Metrics', 'Loudest Short-window Level', 'What to do', fixture.detailed.recommendations[0].reason,
    fixture.detailed.recommendations[0].steps[0]]) {
    assert(text.includes(visible), `Premium PDF lost detail: ${visible}`);
  }
  assert(!text.includes('available in the app with Premium'));
  await verifyOutput(capture.output);
});

test('real PDF font metrics keep long labels and values inside separate columns across pages', async () => {
  const capture = createPdfCapture();
  const { draws, exporter } = capture;
  const longLabel = 'Loudest Short-window Level with a longer diagnostic description';
  const longValue = 'Long microphone identity and recorded parameter value '.repeat(180);
  await exporter({
    canDownload: () => true,
    report: { generatedAt: '2026-09-05T12:00:00Z', run: { id: 'layout-regression', type: 'record' },
      device: { micName: 'USB Audio Interface with a long hardware identity and input channel description '.repeat(5) },
      profile: { id: 'raw', label: 'Raw Recording' } },
    free: { overall: { label: 'Limited assessment' }, summary: 'PDF layout regression fixture.', findings: [], scope: 'Saved audio sample.' },
    detailed: { metrics: [
      { label: 'Loudest Short-window Level', value: '-18.5', unit: 'dBFS', rating: 'info' },
      { label: longLabel, value: longValue },
      { label: 'Final metric', value: 'Visible after the long value' }
    ], recommendations: [] }
  });
  const { doc, output } = capture;
  assert(doc.getNumberOfPages() >= 3, 'a multi-page value must actually exercise pagination');
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const content = draws.filter(draw => draw.y !== pageHeight - 28);
  for (const draw of content) {
    assert(draw.x >= 48 && draw.x + draw.width <= pageWidth - 48 + 0.1, `outside horizontal margins: ${draw.value}`);
    assert(draw.y >= 56 && draw.y <= pageHeight - 56, `outside vertical margins: ${draw.value}`);
  }
  for (const value of content.filter(draw => draw.x === 210)) {
    const labels = content.filter(draw => draw.page === value.page && draw.y === value.y && draw.x === 48);
    for (const label of labels) assert(label.x + label.width <= value.x - 12 + 0.1, 'label collides with its value');
  }
  assert(content.some(draw => draw.value === 'Loudest Short-window Level:'));
  assert(content.some(draw => draw.value === 'Visible after the long value'));
  assert.equal(output.filename, 'mic-probe-report-layout-regression.pdf');
  await verifyOutput(output);
});

test('independent PDF keeps capture hints, applied settings and bounded system observations', async () => {
  const { reviewReport } = await import('./review-fixtures.mjs');
  const report = reviewReport('capture-context-pdf');
  report.environment = { version: 1, os: 'windows', browser: 'chrome', browserMajor: 145, formFactor: 'desktop' };
  report.profile.requestedConstraints = { ...report.profile.appliedConstraints, sampleRate: 44100 };
  report.profile.appliedConstraints.autoGainControl = true;
  report.captureContext = { capabilities: { sampleRateRange: { min: 48000, max: 48000 }, agcSupported: [true] } };
  report.system = { runId: report.run.id, tabWasHidden: true };
  const evaluation = require('../../server/independent-report.js').evaluateIndependentReport(report);
  const capture = createPdfCapture();
  await capture.exporter({ report, free: { ...evaluation.public, findings: evaluation.detailed.findings },
    detailed: evaluation.detailed, canDownload: () => true });
  const text = capture.draws.map(draw => draw.value).join(' ').replace(/\s+/g, ' ');
  const labelText = capture.draws.filter(draw => draw.x === 48).map(draw => draw.value).join(' ');
  assert.ok(labelText.includes('Recording System (Browser Hint)'));
  for (const phrase of ['Chrome 145', 'Automatic gain control was active',
    'did not report support', 'background during part of the run', 'Windows Settings']) assert.ok(text.includes(phrase), phrase);
  await verifyOutput(capture.output);
});
