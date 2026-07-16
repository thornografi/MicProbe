/**
 * ReportEvaluator - Kural tabanli diagnostik degerlendirme motoru
 *
 * DiagnosticReportBuilder'in ham JSON raporunu alir, kural tabanli
 * analiz yaparak bulgular (findings) ve skor uretir.
 *
 * Client tarafinda sadece free katman tutulur. Premium detaylar server/Worker
 * endpointinden gelir; odeme yapilmadan client bundle'da uretilmez.
 */
import { QUALITY } from './constants.js';

class ReportEvaluator {
  constructor() {
    // OCP: kurallar registry — davranis birebir korunur, yeni free-tier kurali registerRule ile eklenir.
    // Her kural (report) => finding | null. Free katman YALNIZCA audioMetrics (+ codec icin recording/loopback) okur;
    // system/deepAnalysis'e DOKUNMAZ (premium mantik free bundle'a sizmaz).
    this._rules = [
      (r) => this._ruleSignal(r),
      (r) => this._ruleNoise(r),
      (r) => this._ruleSnr(r),
      (r) => this._ruleClipping(r),
      (r) => this._ruleDropout(r),
      (r) => this._ruleCodec(r)
    ];
  }

  registerRule(fn) {
    this._rules.push(fn);
  }

  // === PUBLIC API ===

  /**
   * Free katman: Ozet degerlendirme
   * @param {Object} report - DiagnosticReportBuilder.build() ciktisi
   * @returns {{ overall, findings, summary }}
   */
  evaluateFree(report) {
    if (!report?.audioMetrics) {
      return { overall: { score: 'unknown', stars: 0, label: 'No Data', color: 'muted' }, findings: [], summary: 'No test data found.' };
    }
    const findings = this._runCoreRules(report);
    const overall = this._calculateOverall(findings);
    const summary = this._generateSummary(findings);
    return { overall, findings, summary };
  }

  // === PRIVATE: Core Rules (OCP registry — davranis birebir) ===

  _runCoreRules(report) {
    return this._rules.map(fn => fn(report)).filter(Boolean);
  }

  // Kural 1+2: Sessizlik / Zayif sinyal (mutually exclusive)
  _ruleSignal(report) {
    const m = report.audioMetrics; const Q = QUALITY;
    if (m.snr?.signalDb < Q.SILENCE_DB) {
      return { id: 'SILENCE', severity: 'critical', metric: 'signalDb', value: m.snr.signalDb, threshold: Q.SILENCE_DB,
        message: 'Microphone is nearly silent. Make sure the correct device is selected and not muted.' };
    }
    if (m.snr?.signalDb < Q.WEAK_SIGNAL_DB) {
      return { id: 'WEAK_SIGNAL', severity: 'critical', metric: 'signalDb', value: m.snr.signalDb, threshold: Q.WEAK_SIGNAL_DB,
        message: 'Microphone signal is very weak. Speak closer to the mic or increase input level.' };
    }
    return null;
  }

  // Kural 3: Yuksek gurultu
  _ruleNoise(report) {
    const m = report.audioMetrics; const Q = QUALITY;
    const nf = m.noiseFloor?.estimatedDb;
    if (nf != null && nf > Q.NOISE_FLOOR_CRITICAL_DB) {
      return { id: 'HIGH_NOISE', severity: 'critical', metric: 'noiseFloor', value: nf, threshold: Q.NOISE_FLOOR_CRITICAL_DB,
        message: 'Background noise is too high — audio may be unintelligible.' };
    }
    if (nf != null && nf > Q.NOISE_FLOOR_WARNING_DB) {
      return { id: 'HIGH_NOISE', severity: 'warning', metric: 'noiseFloor', value: nf, threshold: Q.NOISE_FLOOR_WARNING_DB,
        message: 'Background noise is high.' };
    }
    return null;
  }

  // Kural 4: Dusuk SNR
  _ruleSnr(report) {
    const m = report.audioMetrics; const Q = QUALITY;
    const snr = m.snr?.estimatedDb;
    if (snr != null && snr < Q.SNR_CRITICAL_DB) {
      return { id: 'LOW_SNR', severity: 'critical', metric: 'snr', value: snr, threshold: Q.SNR_CRITICAL_DB,
        message: 'Signal is buried in noise.' };
    }
    if (snr != null && snr < Q.SNR_WARNING_DB) {
      return { id: 'LOW_SNR', severity: 'warning', metric: 'snr', value: snr, threshold: Q.SNR_WARNING_DB,
        message: 'Signal-to-noise ratio is low — audio quality is mediocre.' };
    }
    return null;
  }

  // Kural 5: Clipping
  _ruleClipping(report) {
    const m = report.audioMetrics; const Q = QUALITY;
    const cr = m.clipping?.rate;
    if (cr != null && cr > Q.CLIPPING_RATE_CRITICAL) {
      return { id: 'CLIPPING', severity: 'critical', metric: 'clippingRate', value: cr, threshold: Q.CLIPPING_RATE_CRITICAL,
        message: 'Severe audio clipping. Lower the microphone input level.' };
    }
    if (cr != null && cr > Q.CLIPPING_RATE_WARNING) {
      return { id: 'CLIPPING', severity: 'warning', metric: 'clippingRate', value: cr, threshold: Q.CLIPPING_RATE_WARNING,
        message: 'Audio is occasionally clipping. Lower the microphone level.' };
    }
    return null;
  }

  // Kural 6: Dropout
  _ruleDropout(report) {
    const m = report.audioMetrics; const Q = QUALITY;
    const dc = m.dropouts?.count;
    if (dc != null && dc >= Q.DROPOUT_COUNT_CRITICAL) {
      return { id: 'DROPOUTS', severity: 'critical', metric: 'dropoutCount', value: dc, threshold: Q.DROPOUT_COUNT_CRITICAL,
        message: 'Frequent audio dropouts. Microphone connection is unstable.' };
    }
    if (dc != null && dc >= Q.DROPOUT_COUNT_WARNING) {
      return { id: 'DROPOUTS', severity: 'warning', metric: 'dropoutCount', value: dc, threshold: Q.DROPOUT_COUNT_WARNING,
        message: 'Audio dropouts detected. Check your connection or USB port.' };
    }
    return null;
  }

  // Kural 7: Codec kaybi
  _ruleCodec(report) {
    const Q = QUALITY;
    const recDev = report.recording?.bitrateDeviation;
    const lbDev = report.loopback?.bitrateDeviation;
    const runType = report.run?.type;
    const dev = runType === 'test' ? lbDev
      : runType === 'record' ? recDev
        : recDev ?? lbDev;
    if (dev != null && dev < -Q.BITRATE_DEVIATION_WARNING) {
      return { id: 'CODEC_LOSS', severity: 'warning', metric: 'bitrateDeviation', value: dev, threshold: -Q.BITRATE_DEVIATION_WARNING,
        message: 'Codec failed to reach target bitrate. Actual audio quality is below desired level.' };
    }
    return null;
  }

  // === PRIVATE: Scoring ===

  _calculateOverall(findings) {
    const criticalCount = findings.filter(f => f.severity === 'critical').length;
    const warningCount = findings.filter(f => f.severity === 'warning').length;

    if (criticalCount === 0 && warningCount === 0) {
      return { score: 'good', stars: 5, label: 'Excellent', color: 'success' };
    }

    // Agirlikli puanlama: her critical = -2, her warning = -0.5
    const rawScore = 5 - (criticalCount * 2) - (warningCount * 0.5);
    const stars = Math.max(1, Math.min(5, Math.round(rawScore)));

    if (stars >= 4) return { score: 'good', stars, label: 'Good', color: 'success' };
    if (stars >= 3) return { score: 'fair', stars, label: 'Fair', color: 'warning' };
    if (stars >= 2) return { score: 'poor', stars, label: 'Poor', color: 'warning' };
    return { score: 'critical', stars: 1, label: 'Critical', color: 'danger' };
  }

  _generateSummary(findings) {
    if (findings.length === 0) return 'Your audio quality looks good. No issues detected.';
    const critical = findings.filter(f => f.severity === 'critical');
    if (critical.length > 0) return critical.map(f => f.message).join(' ');
    return findings.map(f => f.message).join(' ');
  }

}

// Singleton
const reportEvaluator = new ReportEvaluator();
export default reportEvaluator;
