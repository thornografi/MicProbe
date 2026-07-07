/**
 * ReportEvaluator - Kural tabanli diagnostik degerlendirme motoru
 *
 * DiagnosticReportBuilder'in ham JSON raporunu alir, kural tabanli
 * analiz yaparak bulgular (findings) ve skor uretir.
 *
 * Iki katman:
 * - evaluateFree(report)     -> Ozet: genel skor + bulgular + summary
 * - evaluateDetailed(report) -> Detay: metrikler + constraint onerileri + profil onerileri
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
      ...this._analyzeProfileSpecific(report)
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
    if (snr != null && snr < Q.SNR_CRITICAL_DB) {
      findings.push({
        id: 'LOW_SNR', severity: 'critical', metric: 'snr', value: snr, threshold: Q.SNR_CRITICAL_DB,
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
    const runType = report.run?.type;
    const dev = runType === 'test' ? lbDev
      : runType === 'record' ? recDev
        : recDev ?? lbDev;
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

    const sourceLabel = m.source === 'remote-loopback' ? 'Post-codec loopback' : 'Mic pipeline';
    const bitrate = this._buildBitrateMetrics(report);
    const loopback = this._buildLoopbackMetrics(report);
    const lufs = m.lufs || {};
    const frequencyResponse = m.frequencyResponse || {};

    return [
      this._metric('source', 'Measured Source', sourceLabel, '', 'info'),
      this._metric('snr', 'Signal/Noise', m.snr?.estimatedDb, 'dB', this._rate(m.snr?.estimatedDb, Q.SNR_GOOD_DB, Q.SNR_WARNING_DB)),
      this._metric('noiseFloor', 'Noise Floor', m.noiseFloor?.estimatedDb, 'dBFS', this._rateReverse(m.noiseFloor?.estimatedDb, Q.NOISE_FLOOR_GOOD_DB, Q.NOISE_FLOOR_WARNING_DB)),
      this._metric('dynamicRange', 'Dynamic Range', m.dynamicRange?.db, 'dB', this._rate(m.dynamicRange?.db, 20, Q.DYNAMIC_RANGE_WARNING_DB)),
      this._metric('clipping', 'Clipping', this._percent(m.clipping?.rate), '%', this._rateReverse(m.clipping?.rate, Q.CLIPPING_RATE_WARNING, Q.CLIPPING_RATE_CRITICAL)),
      this._metric('clippingEvents', 'Clipping Events', m.clipping?.eventCount, 'events', this._rateReverse(m.clipping?.eventCount, 0, 2)),
      this._metric('dropouts', 'Audio Dropouts', m.dropouts?.count, 'count', this._rateReverse(m.dropouts?.count, 0, Q.DROPOUT_COUNT_WARNING)),
      this._metric('dropoutDuration', 'Dropout Time', m.dropouts?.totalDurationMs, 'ms', this._rateReverse(m.dropouts?.totalDurationMs, 0, 500)),
      this._metric('stability', 'Stability', m.stability?.dbStdDev, 'dB', this._rateReverse(m.stability?.dbStdDev, Q.STABILITY_GOOD_STDDEV, Q.STABILITY_WARNING_STDDEV)),
      this._metric('weakSignal', 'Weak Signal', this._percent(m.weakSignal?.rate), '%', this._rateReverse(m.weakSignal?.rate, 0.05, 0.2)),
      this._metric('lufsIntegrated', 'Integrated LUFS', lufs.integrated, 'LUFS', 'info'),
      this._metric('lufsShortTerm', 'Short-term LUFS', lufs.shortTerm, 'LUFS', 'info'),
      this._metric('frequency', 'Frequency Profile', this._interpretFrequency(m.frequencyProfile), '', 'info'),
      this._metric('frequencyBins', 'Frequency Detail', frequencyResponse.bins?.length, 'bins', 'info'),
      this._metric('frequencyResolution', 'Freq Resolution', frequencyResponse.binWidth, 'Hz/bin', 'info'),
      ...bitrate,
      ...loopback
    ];
  }

  _metric(key, label, value, unit = '', rating = 'info') {
    return {
      key,
      label,
      value: value ?? null,
      unit,
      rating: value === null || value === undefined ? 'info' : rating
    };
  }

  _rate(val, good, warn) {
    if (val === null || val === undefined) return 'info';
    return val >= good ? 'good' : val >= warn ? 'fair' : 'poor';
  }

  _rateReverse(val, good, warn) {
    if (val === null || val === undefined) return 'info';
    return val <= good ? 'good' : val <= warn ? 'fair' : 'poor';
  }

  _percent(rate) {
    return rate === null || rate === undefined ? null : +(rate * 100).toFixed(1);
  }

  _buildBitrateMetrics(report) {
    const source = report.recording || report.loopback;
    if (!source) return [];

    const actualKbps = source.actualBitrate
      ? +(source.actualBitrate / 1000).toFixed(1)
      : source.actualKbps ?? null;
    const requestedKbps = source.requestedBitrate
      ? +(source.requestedBitrate / 1000).toFixed(1)
      : source.requestedKbps ?? null;
    const deviationPct = source.bitrateDeviation !== null && source.bitrateDeviation !== undefined
      ? +(source.bitrateDeviation * 100).toFixed(1)
      : null;

    return [
      this._metric('targetBitrate', 'Target Bitrate', requestedKbps, 'kbps', 'info'),
      this._metric('actualBitrate', 'Actual Bitrate', actualKbps, 'kbps', 'info'),
      this._metric('bitrateDeviation', 'Bitrate Drift', deviationPct, '%', this._rateReverse(Math.abs(source.bitrateDeviation ?? 0), 0.1, QUALITY.BITRATE_DEVIATION_WARNING))
    ];
  }

  _buildLoopbackMetrics(report) {
    const lb = report.loopback;
    if (!lb) return [];

    return [
      this._metric('rtt', 'Loopback RTT', lb.rttMs, 'ms', this._rateReverse(lb.rttMs, 80, 150)),
      this._metric('jitter', 'Jitter', lb.jitterMs, 'ms', this._rateReverse(lb.jitterMs, 20, 40)),
      this._metric('packetLoss', 'Packet Loss', this._percent(lb.packetLossRate), '%', this._rateReverse(lb.packetLossRate, 0.005, 0.02)),
      this._metric('dtx', 'DTX State', lb.isDtxActive === null || lb.isDtxActive === undefined ? null : (lb.isDtxActive ? 'Active' : 'Inactive'), '', 'info')
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

  // === PRIVATE: Premium - Profile Specific ===

  _analyzeProfileSpecific(report) {
    const recs = [];
    const pid = report.profile?.id;
    const m = report.audioMetrics;
    if (!pid || !m) return recs;

    const Q = QUALITY;

    switch (pid) {
      case 'discord':
        if ((m.clipping?.rate ?? 0) > Q.CLIPPING_RATE_WARNING) {
          recs.push({ id: 'DISCORD_KRISP', type: 'profile', message: 'Discord-style noise processing can make clipping more obvious. Lower mic gain first, then compare with Krisp/noise suppression off in Discord.' });
        }
        if ((m.snr?.estimatedDb ?? 0) < Q.SNR_WARNING_DB) {
          recs.push({ id: 'DISCORD_NOISE', type: 'profile', message: 'Low SNR is usually a mic/room/noise issue, not a server bitrate issue. Improve input noise before testing higher Discord bitrate.' });
        }
        break;
      case 'meeting-call':
      case 'zoom':
        if ((report.profile?.constraints?.sampleRate ?? 48000) < 48000) {
          recs.push({ id: 'MEETING_SR', type: 'profile', message: 'Lower sample-rate meeting tests are useful for compatibility, but 48kHz is the better baseline for modern browser meeting calls.' });
        }
        break;
      case 'zoom-hifi':
        if ((m.noiseFloor?.estimatedDb ?? -60) > Q.NOISE_FLOOR_WARNING_DB) {
          recs.push({ id: 'HIFI_NOISE', type: 'profile', message: 'High Fidelity mode preserves more room noise because processing is reduced. Improve the room or mic placement before using this mode.' });
        }
        if ((m.clipping?.rate ?? 0) > Q.CLIPPING_RATE_WARNING) {
          recs.push({ id: 'HIFI_CLIPPING', type: 'profile', message: 'High Fidelity mode preserves clipping instead of hiding it. Reduce input gain before comparing stereo or higher bitrate.' });
        }
        break;
      case 'whatsapp-telegram-call':
        recs.push({ id: 'WHATSAPP_TELEGRAM_CALL_COMPRESSION', type: 'profile', message: 'WhatsApp and Telegram calls compress voice harder than normal meeting calls. If speech sounds smeared here but fine in Meeting Call, your mic is probably fine; the app call is the weak point.' });
        break;
      case 'whatsapp-voice':
        if ((m.noiseFloor?.estimatedDb ?? -60) > Q.NOISE_FLOOR_WARNING_DB) {
          recs.push({ id: 'WA_VOICE_NOISE', type: 'profile', message: 'Low-bitrate voice messages expose background noise quickly. Record in a quiet environment or move closer to the mic.' });
        }
        break;
      case 'telegram-voice':
        if (report.profile?.bitrate === 0) {
          recs.push({ id: 'TG_VBR_VALID', type: 'profile', message: 'VBR is valid for Opus voice messages. Use a fixed bitrate only when you need repeatable A/B comparison.' });
        }
        break;
      case 'raw':
        if (this._runCoreRules(report).length === 0) {
          recs.push({ id: 'RAW_CLEAN', type: 'profile', message: 'Raw recording is clean. Issue may come from codec, processing, or call behavior - test another profile.' });
        }
        break;
    }

    return recs;
  }
}

// Singleton
const reportEvaluator = new ReportEvaluator();
export default reportEvaluator;
