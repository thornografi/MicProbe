/**
 * ReportEvaluator - Kural tabanli diagnostik degerlendirme motoru
 *
 * DiagnosticReportBuilder'in ham JSON raporunu alir, kural tabanli
 * analiz yaparak bulgular (findings) ve skor uretir.
 *
 * Iki katman:
 * - evaluateFree(report)     -> Ozet: genel skor + bulgular + summary
 * - evaluateDetailed(report) -> Detay: metrikler + constraint onerileri + platform onerileri
 */
import { QUALITY } from './constants.js';

class ReportEvaluator {

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

  /**
   * Premium katman: Detayli degerlendirme
   * @param {Object} report - DiagnosticReportBuilder.build() ciktisi
   * @returns {{ overall, findings, summary, metrics, recommendations }}
   */
  evaluateDetailed(report) {
    const free = this.evaluateFree(report);
    const metrics = this._formatDetailedMetrics(report);
    const recommendations = [
      ...this._analyzeConstraintCorrelation(report),
      ...this._analyzePlatformSpecific(report)
    ];
    return { ...free, metrics, recommendations };
  }

  // === PRIVATE: Core Rules ===

  _runCoreRules(report) {
    const findings = [];
    const m = report.audioMetrics;
    const Q = QUALITY;

    // Kural 1: Sessizlik
    if (m.snr?.signalDb < Q.SILENCE_DB) {
      findings.push({
        id: 'SILENCE', severity: 'critical', metric: 'signalDb', value: m.snr.signalDb, threshold: Q.SILENCE_DB,
        message: 'Microphone is nearly silent. Make sure the correct device is selected and not muted.'
      });
    }
    // Kural 2: Zayif sinyal (sessizlik degilse)
    else if (m.snr?.signalDb < Q.WEAK_SIGNAL_DB) {
      findings.push({
        id: 'WEAK_SIGNAL', severity: 'critical', metric: 'signalDb', value: m.snr.signalDb, threshold: Q.WEAK_SIGNAL_DB,
        message: 'Microphone signal is very weak. Speak closer to the mic or increase input level.'
      });
    }

    // Kural 3: Yuksek gurultu
    const nf = m.noiseFloor?.estimatedDb;
    if (nf != null && nf > Q.NOISE_FLOOR_CRITICAL_DB) {
      findings.push({
        id: 'HIGH_NOISE', severity: 'critical', metric: 'noiseFloor', value: nf, threshold: Q.NOISE_FLOOR_CRITICAL_DB,
        message: 'Background noise is too high — audio may be unintelligible.'
      });
    } else if (nf != null && nf > Q.NOISE_FLOOR_WARNING_DB) {
      findings.push({
        id: 'HIGH_NOISE', severity: 'warning', metric: 'noiseFloor', value: nf, threshold: Q.NOISE_FLOOR_WARNING_DB,
        message: 'Background noise is high.'
      });
    }

    // Kural 4: Dusuk SNR
    const snr = m.snr?.estimatedDb;
    if (snr != null && snr < 5) {
      findings.push({
        id: 'LOW_SNR', severity: 'critical', metric: 'snr', value: snr, threshold: 5,
        message: 'Signal is buried in noise.'
      });
    } else if (snr != null && snr < Q.SNR_WARNING_DB) {
      findings.push({
        id: 'LOW_SNR', severity: 'warning', metric: 'snr', value: snr, threshold: Q.SNR_WARNING_DB,
        message: 'Signal-to-noise ratio is low — audio quality is mediocre.'
      });
    }

    // Kural 5: Clipping
    const cr = m.clipping?.rate;
    if (cr != null && cr > Q.CLIPPING_RATE_CRITICAL) {
      findings.push({
        id: 'CLIPPING', severity: 'critical', metric: 'clippingRate', value: cr, threshold: Q.CLIPPING_RATE_CRITICAL,
        message: 'Severe audio clipping. Lower the microphone input level.'
      });
    } else if (cr != null && cr > Q.CLIPPING_RATE_WARNING) {
      findings.push({
        id: 'CLIPPING', severity: 'warning', metric: 'clippingRate', value: cr, threshold: Q.CLIPPING_RATE_WARNING,
        message: 'Audio is occasionally clipping. Lower the microphone level.'
      });
    }

    // Kural 6: Dropout
    const dc = m.dropouts?.count;
    if (dc != null && dc >= Q.DROPOUT_COUNT_CRITICAL) {
      findings.push({
        id: 'DROPOUTS', severity: 'critical', metric: 'dropoutCount', value: dc, threshold: Q.DROPOUT_COUNT_CRITICAL,
        message: 'Frequent audio dropouts. Microphone connection is unstable.'
      });
    } else if (dc != null && dc >= Q.DROPOUT_COUNT_WARNING) {
      findings.push({
        id: 'DROPOUTS', severity: 'warning', metric: 'dropoutCount', value: dc, threshold: Q.DROPOUT_COUNT_WARNING,
        message: 'Audio dropouts detected. Check your connection or USB port.'
      });
    }

    // Kural 7: Codec kaybi
    const recDev = report.recording?.bitrateDeviation;
    const lbDev = report.loopback?.bitrateDeviation;
    const dev = recDev ?? lbDev;
    if (dev != null && dev < -Q.BITRATE_DEVIATION_WARNING) {
      findings.push({
        id: 'CODEC_LOSS', severity: 'warning', metric: 'bitrateDeviation', value: dev, threshold: -Q.BITRATE_DEVIATION_WARNING,
        message: 'Codec failed to reach target bitrate. Actual audio quality is below desired level.'
      });
    }

    return findings;
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

  // === PRIVATE: Premium - Detailed Metrics ===

  _formatDetailedMetrics(report) {
    const m = report.audioMetrics;
    if (!m) return null;
    const Q = QUALITY;

    const rate = (val, good, warn) => val >= good ? 'good' : val >= warn ? 'fair' : 'poor';
    const rateReverse = (val, good, warn) => val <= good ? 'good' : val <= warn ? 'fair' : 'poor';

    return [
      { key: 'snr', label: 'Signal/Noise', value: m.snr?.estimatedDb, unit: 'dB', rating: rate(m.snr?.estimatedDb ?? 0, Q.SNR_GOOD_DB, Q.SNR_WARNING_DB) },
      { key: 'noiseFloor', label: 'Noise Floor', value: m.noiseFloor?.estimatedDb, unit: 'dBFS', rating: rateReverse(m.noiseFloor?.estimatedDb ?? 0, Q.NOISE_FLOOR_GOOD_DB, Q.NOISE_FLOOR_WARNING_DB) },
      { key: 'dynamicRange', label: 'Dynamic Range', value: m.dynamicRange?.db, unit: 'dB', rating: rate(m.dynamicRange?.db ?? 0, 20, Q.DYNAMIC_RANGE_WARNING_DB) },
      { key: 'clipping', label: 'Clipping', value: m.clipping?.rate != null ? +(m.clipping.rate * 100).toFixed(1) : null, unit: '%', rating: rateReverse(m.clipping?.rate ?? 0, Q.CLIPPING_RATE_WARNING, Q.CLIPPING_RATE_CRITICAL) },
      { key: 'dropouts', label: 'Audio Dropouts', value: m.dropouts?.count, unit: 'count', rating: rateReverse(m.dropouts?.count ?? 0, 0, Q.DROPOUT_COUNT_WARNING) },
      { key: 'stability', label: 'Stability', value: m.stability?.dbStdDev, unit: 'dB', rating: rateReverse(m.stability?.dbStdDev ?? 0, Q.STABILITY_GOOD_STDDEV, Q.STABILITY_WARNING_STDDEV) },
      { key: 'frequency', label: 'Frequency Profile', value: this._interpretFrequency(m.frequencyProfile), unit: '', rating: 'info' }
    ];
  }

  _interpretFrequency(fp) {
    if (!fp) return 'No data';
    const bands = { 'Bass': fp.subBass, 'Low-Mid': fp.lowMid, 'High-Mid': fp.highMid, 'Treble': fp.presence };
    const max = Object.entries(bands).reduce((a, b) => (b[1] ?? 0) > (a[1] ?? 0) ? b : a);
    return `${max[0]} dominant`;
  }

  // === PRIVATE: Premium - Constraint Correlation ===

  _analyzeConstraintCorrelation(report) {
    const recs = [];
    const c = report.profile?.constraints;
    const m = report.audioMetrics;
    if (!c || !m) return recs;

    const Q = QUALITY;

    // NS kapali + gurultu yuksek
    if (c.noiseSuppression === false && (m.noiseFloor?.estimatedDb ?? -60) > Q.NOISE_FLOOR_WARNING_DB) {
      recs.push({ id: 'NS_OFF_NOISY', type: 'constraint', message: 'Noise Suppression is off and background noise is high. Try enabling NS.' });
    }
    // NS acik ama hala gurultulu
    if (c.noiseSuppression === true && (m.noiseFloor?.estimatedDb ?? -60) > Q.NOISE_FLOOR_WARNING_DB) {
      recs.push({ id: 'NS_ON_STILL_NOISY', type: 'constraint', message: 'NS is on but noise is still high. Physical sound isolation may be needed.' });
    }
    // AGC kapali + sinyal zayif
    if (c.autoGainControl === false && (m.snr?.signalDb ?? 0) < Q.WEAK_SIGNAL_DB) {
      recs.push({ id: 'AGC_OFF_WEAK', type: 'constraint', message: 'Auto Gain Control is off and signal is weak. Try enabling AGC.' });
    }
    // AGC acik + clipping
    if (c.autoGainControl === true && (m.clipping?.rate ?? 0) > Q.CLIPPING_RATE_WARNING) {
      recs.push({ id: 'AGC_ON_CLIPPING', type: 'constraint', message: 'AGC is on but clipping is occurring. Your mic input may be physically too loud.' });
    }
    // EC kapali + loopback
    if (c.echoCancellation === false && report.profile?.loopback) {
      recs.push({ id: 'EC_OFF_LOOPBACK', type: 'constraint', message: 'Echo Cancellation is off. You may hear echo if using speakers.' });
    }
    // ScriptProcessor + dropout
    if (report.profile?.pipeline === 'scriptprocessor' && (m.dropouts?.count ?? 0) > 0) {
      recs.push({ id: 'SP_DROPOUT', type: 'constraint', message: 'ScriptProcessor pipeline is prone to audio dropouts. Try the Worklet pipeline.' });
    }

    return recs;
  }

  // === PRIVATE: Premium - Platform Specific ===

  _analyzePlatformSpecific(report) {
    const recs = [];
    const pid = report.profile?.id;
    const m = report.audioMetrics;
    if (!pid || !m) return recs;

    const Q = QUALITY;

    switch (pid) {
      case 'discord':
        if ((m.clipping?.rate ?? 0) > Q.CLIPPING_RATE_WARNING) {
          recs.push({ id: 'DISCORD_KRISP', type: 'platform', message: 'Discord Krisp noise suppression may worsen clipping. Disable Krisp in Discord Voice Settings.' });
        }
        if ((m.snr?.estimatedDb ?? 0) < Q.SNR_WARNING_DB) {
          recs.push({ id: 'DISCORD_BITRATE', type: 'platform', message: 'To improve audio quality in Discord, raise the bitrate in Server Settings > Audio Quality.' });
        }
        break;
      case 'whatsapp-voice':
        if ((m.noiseFloor?.estimatedDb ?? -60) > Q.NOISE_FLOOR_WARNING_DB) {
          recs.push({ id: 'WA_VOICE_NOISE', type: 'platform', message: 'WhatsApp voice message noise suppression is limited. Record in a quiet environment.' });
        }
        break;
      case 'whatsapp-call':
        recs.push({ id: 'WA_CALL_BITRATE', type: 'platform', message: 'WhatsApp Web calls run at low bitrate (24kbps). Noise is more noticeable at this level.' });
        break;
      case 'zoom':
        if (report.profile?.constraints?.sampleRate === 16000) {
          recs.push({ id: 'ZOOM_SR', type: 'platform', message: 'Zoom offers limited audio quality at 16kHz. Try selecting 48kHz for better quality.' });
        }
        break;
      case 'telegram-voice':
        if (report.profile?.bitrate === 0) {
          recs.push({ id: 'TG_VBR', type: 'platform', message: 'Telegram is in VBR mode. Select a fixed bitrate for consistent quality.' });
        }
        break;
      case 'raw':
        if (this._runCoreRules(report).length === 0) {
          recs.push({ id: 'RAW_CLEAN', type: 'platform', message: 'Raw recording is clean. Issue may be platform-specific codec or settings — test other profiles.' });
        }
        break;
    }

    return recs;
  }
}

// Singleton
const reportEvaluator = new ReportEvaluator();
export default reportEvaluator;
