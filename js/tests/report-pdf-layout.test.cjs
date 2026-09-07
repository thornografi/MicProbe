const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { jsPDF } = require('../lib/jspdf/jspdf.umd.min.js');

function createPdfCapture() {
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
    .replace(/^import .*;$/gm, '').replace('export async function ', 'async function ');
  const exporter = vm.runInNewContext(source + '\ndownloadReportPdf', {
    structuredClone, jspdf: { jsPDF: RecordedPDF },
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

function summaryFixture(id) {
  return {
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

test('free PDF contains only the summary, measurement scope and optional Premium explanation', async () => {
  const capture = createPdfCapture();
  const fixture = summaryFixture('free-summary');
  fixture.detailed = null;
  await capture.exporter(fixture);
  const text = capture.draws.map(draw => draw.value).join(' ').replace(/\s+/g, ' ');
  assert.equal(capture.doc.getNumberOfPages(), 1);
  assert.match(text, /MicProbe Diagnostic Report/);
  assert.match(text, /Summary Limited assessment/);
  assert(text.includes(fixture.free.summary));
  assert(text.includes(fixture.free.scopeSummary));
  assert(text.includes(fixture.free.scope), 'measurement limits must remain visible without Premium');
  assert(text.includes('Detailed findings and instructions are available in the app with Premium. PDF download is optional.'));
  for (const hidden of ['Findings', fixture.free.findings[0].message, 'Device & Profile', fixture.report.device.micName,
    'Your Troubleshooting Context', 'Operating system', 'Detailed Metrics', 'What to do']) {
    assert(!text.includes(hidden), `free PDF exposed detail: ${hidden}`);
  }
  assert(!text.includes('Open the Windows microphone settings'));
  await verifyOutput(capture.output);
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
