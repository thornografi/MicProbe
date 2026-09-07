/**
 * ReportPdfExporter - Diagnostik raporu PDF olarak indirir
 *
 * jsPDF vendored UMD build (js/lib/jspdf/) lazy-load edilir: dosya yalnizca
 * kullanici "Download PDF" butonuna bastiginda cekilir, ilk sayfa yukune girmez.
 * Icerik metin/vektor tabanli uretilir (raster degil) - secilebilir, kucuk dosya.
 *
 * NOT: Standart PDF fontlari (helvetica) WinAnsi kodludur; ASCII disi semboller
 * (yildiz, ok, check) kullanilamaz. Ikonlar ASCII karsiliklariyla yazilir.
 */
import { downloadBlob } from './utils/download.js';
import { describeTroubleshootingContext } from './TroubleshootingContext.js';

// Sayfa olcumleri (pt, A4)
const PAGE = {
  MARGIN_X: 48,
  MARGIN_TOP: 56,
  MARGIN_BOTTOM: 56,
  LINE_GAP: 4,
  SECTION_GAP: 18
};

const FONT_SIZES = {
  TITLE: 20,
  SECTION: 13,
  BODY: 10,
  SMALL: 8.5
};

const SEVERITY_PREFIX = { critical: '[!]', warning: '[~]', info: '[Observation]', good: '[OK]' };

/**
 * jsPDF constructor'ini lazy yukler (UMD build globalThis.jspdf'i set eder)
 * @returns {Promise<Function>} jsPDF constructor
 */
async function loadJsPDF() {
  if (!globalThis.jspdf?.jsPDF) {
    await import('../lib/jspdf/jspdf.umd.min.js');
  }
  const ctor = globalThis.jspdf?.jsPDF;
  if (!ctor) throw new Error('jsPDF library could not be loaded');
  return ctor;
}

/**
 * Raporu PDF olarak olusturup indirir
 * @param {Object} params
 * @param {Object} params.report - DiagnosticReportBuilder.build() ciktisi
 * @param {Object} params.free - ReportEvaluator.evaluateFree() ciktisi (overall/summary/findings)
 * @param {Object|null} params.detailed - Premium detay (metrics/recommendations) veya null (kilitli)
 */
export async function downloadReportPdf({ report, free, detailed = null }) {
  ({ report, free, detailed } = structuredClone({ report, free, detailed }));
  const JsPDF = await loadJsPDF();
  const doc = new JsPDF({ unit: 'pt', format: 'a4' });
  const writer = createWriter(doc);

  writeHeader(writer, report);
  writeOverall(writer, free);
  if (detailed) writeFindings(writer, free);
  if (free.scope) {
    writer.sectionTitle('What Was Measured');
    writer.body(free.scope);
  }
  if (detailed) {
    if (report.run?.type !== 'troubleshooting') writeDeviceProfile(writer, report);
    writeTroubleshootingContext(writer, report);
    if (report.run?.type !== 'troubleshooting') writeDetailedMetrics(writer, detailed.metrics || []);
    writeRecommendations(writer, detailed.recommendations || []);
  } else {
    writer.gap();
    writer.body('Detailed findings and instructions are available in the app with Premium. PDF download is optional.');
  }
  writeFooter(doc);

  const filename = `mic-probe-report-${report.run?.id || report.sessionId || 'unknown'}.pdf`;
  downloadBlob(doc.output('blob'), filename);
}

/**
 * Y-imleci + sayfa tasmasini yoneten kucuk yazici yardimcisi
 * @param {Object} doc - jsPDF instance
 */
function createWriter(doc) {
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  const maxWidth = pageWidth - PAGE.MARGIN_X * 2;
  let y = PAGE.MARGIN_TOP;

  const ensureSpace = (needed) => {
    if (y + needed > pageHeight - PAGE.MARGIN_BOTTOM) {
      doc.addPage();
      y = PAGE.MARGIN_TOP;
    }
  };

  const writeLines = (text, { size = FONT_SIZES.BODY, style = 'normal', indent = 0, color = 40 } = {}) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    doc.setTextColor(color);
    const lines = doc.splitTextToSize(String(text), maxWidth - indent);
    const lineHeight = size + PAGE.LINE_GAP;
    for (const line of lines) {
      ensureSpace(lineHeight);
      doc.text(line, PAGE.MARGIN_X + indent, y);
      y += lineHeight;
    }
  };

  return {
    doc,
    maxWidth,
    get y() { return y; },
    set y(val) { y = val; },
    ensureSpace,
    gap(px = PAGE.SECTION_GAP) { y += px; },
    title(text) { writeLines(text, { size: FONT_SIZES.TITLE, style: 'bold', color: 20 }); },
    sectionTitle(text) {
      ensureSpace(FONT_SIZES.SECTION + PAGE.SECTION_GAP);
      y += PAGE.SECTION_GAP;
      writeLines(text, { size: FONT_SIZES.SECTION, style: 'bold', color: 20 });
      // Baslik alti ayirici cizgi
      doc.setDrawColor(200);
      doc.line(PAGE.MARGIN_X, y - 2, PAGE.MARGIN_X + maxWidth, y - 2);
      y += 12;
    },
    body(text, opts = {}) { writeLines(text, { ...opts, size: opts.size || FONT_SIZES.BODY }); },
    small(text, opts = {}) { writeLines(text, { ...opts, size: FONT_SIZES.SMALL, color: 110 }); },
    keyValue(label, value) {
      const size = FONT_SIZES.BODY;
      const lineHeight = size + PAGE.LINE_GAP;
      const labelWidth = 150;
      const columnGap = 12;
      doc.setFontSize(size);
      doc.setFont('helvetica', 'bold');
      const labels = doc.splitTextToSize(`${label}:`, labelWidth);
      doc.setFont('helvetica', 'normal');
      const values = doc.splitTextToSize(String(value), maxWidth - labelWidth - columnGap);
      const rows = Math.max(labels.length, values.length);
      // Keep ordinary rows together; very long values continue safely on later pages.
      ensureSpace(Math.min(rows * lineHeight, pageHeight - PAGE.MARGIN_TOP - PAGE.MARGIN_BOTTOM));
      for (let row = 0; row < rows; row++) {
        ensureSpace(lineHeight);
        if (labels[row]) {
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(70);
          doc.text(labels[row], PAGE.MARGIN_X, y);
        }
        if (values[row]) {
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(40);
          doc.text(values[row], PAGE.MARGIN_X + labelWidth + columnGap, y);
        }
        y += lineHeight;
      }
    }
  };
}

function writeHeader(writer, report) {
  writer.title('MicProbe Diagnostic Report');
  const generated = report.generatedAt ? new Date(report.generatedAt).toLocaleString() : '-';
  writer.small(`Generated: ${generated}    Session: ${report.sessionId || '-'}`);
}

function writeOverall(writer, free) {
  const overall = free.overall || {};
  writer.sectionTitle('Summary');
  const stars = typeof overall.stars === 'number' ? ` (${overall.stars}/5)` : '';
  writer.body(`${overall.label || 'Unknown'}${stars}`, { style: 'bold', size: 12 });
  if (free.summary) writer.body(free.summary);
  if (free.scopeSummary) writer.body(free.scopeSummary);
}

function writeFindings(writer, free) {
  if (free.assessment?.status === 'not-measured') return;
  const findings = free.findings || [];
  writer.sectionTitle('Findings');
  if (!findings.length) {
    writer.body(free.summary || 'There is not enough measured audio to assess this recording.');
    return;
  }
  for (const f of findings) {
    const prefix = SEVERITY_PREFIX[f.severity] || SEVERITY_PREFIX.info;
    writer.body(`${prefix} ${f.message}`, { indent: 0 });
  }
}

function writeDeviceProfile(writer, report) {
  const device = report.device || {};
  const profile = report.profile || {};
  writer.sectionTitle('Device & Profile');
  writer.keyValue('Microphone', device.micName || '-');
  writer.keyValue('Channels', device.channelCount === 2 ? 'Stereo' : device.channelCount === 1 ? 'Mono' : '-');
  writer.keyValue('Sample Rate', device.sampleRate ? `${device.sampleRate} Hz` : '-');
  writer.keyValue('Profile', profile.label || profile.id || '-');
  writer.keyValue('Category', profile.category || '-');
  writer.keyValue('Pipeline', profile.pipeline || '-');
  writer.keyValue('Encoder', profile.encoder || '-');
  if (profile.bitrate) {
    // Config'te bitrate bps cinsinden tutulur (orn. 64000) - kbps'e cevir
    const kbps = profile.bitrate >= 1000 ? Math.round(profile.bitrate / 1000) : profile.bitrate;
    writer.keyValue('Bitrate', `${kbps} kbps`);
  }
}

function writeDetailedMetrics(writer, metrics) {
  writer.sectionTitle('Detailed Metrics');
  if (!metrics.length) {
    writer.body('No metric data available for this run.');
    return;
  }
  for (const m of metrics) {
    const value = m.value != null ? `${m.value}${m.unit ? ` ${m.unit}` : ''}` : '--';
    const rating = m.rating ? `  [${m.rating}]` : '';
    writer.keyValue(m.label || '-', `${value}${rating}`);
  }
}

function writeTroubleshootingContext(writer, report) {
  if (!report.troubleshooting || report.troubleshooting.symptom === 'unknown') return;
  const rows = describeTroubleshootingContext(report.troubleshooting);
  if (!rows.length) return;
  writer.sectionTitle('Your Troubleshooting Context');
  writer.body('Your description and target system guide these steps; they are not measured audio findings.');
  // Shared form labels can exceed the fixed-width metric label column.
  for (const [label, value] of rows) writer.body(`${label}: ${value}`);
}

function writeRecommendations(writer, recommendations) {
  writer.sectionTitle('What to do');
  if (!recommendations.length) {
    writer.body('No additional recommendations found.');
    return;
  }

  // ReportPanelUI._renderRecommendations ile ayni kategori gruplama/sirasi
  const CATEGORY_LABELS = {
    troubleshooting: 'Steps for your system and app', setting: 'Settings', microphone: 'Microphone', system: 'System / Performance',
    environment: 'Environment', profile: 'Test scope', observation: 'Observations — no quality penalty'
  };
  const ORDER = ['troubleshooting', 'setting', 'microphone', 'system', 'environment', 'observation', 'profile'];

  const groups = {};
  for (const r of recommendations) {
    const cat = r.category || 'profile';
    (groups[cat] = groups[cat] || []).push(r);
  }
  const cats = Object.keys(groups).sort(
    (a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99)
  );

  for (const cat of cats) {
    writer.gap(8);
    writer.body(CATEGORY_LABELS[cat] || cat, { style: 'bold', size: 11 });
    for (const r of groups[cat]) {
      const confidence = r.confidence ? ` (confidence: ${r.confidence})` : '';
      writer.body(`- ${r.reason || r.message || ''}${confidence}`, { indent: 8 });
      if (r.evidence) writer.small(r.evidence, { indent: 16 });
      if (r.action) writer.small(r.action, { indent: 16 });
      for (const [index, step] of (r.steps || []).entries()) writer.body(`${index + 1}. ${step}`, { indent: 16 });
      if (r.expected) writer.small(`What to check: ${r.expected}`, { indent: 16 });
      if (r.next) writer.small(`If it continues: ${r.next}`, { indent: 16 });
      for (const source of r.sources || []) writer.small(`${source.label}: ${source.url}`, { indent: 16 });
    }
  }
}

function writeFooter(doc) {
  const pageCount = doc.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(FONT_SIZES.SMALL);
    doc.setTextColor(150);
    doc.text('Generated by MicProbe', PAGE.MARGIN_X, pageHeight - 28);
    doc.text(`Page ${i} / ${pageCount}`, pageWidth - PAGE.MARGIN_X, pageHeight - 28, { align: 'right' });
  }
}
