/**
 * ReportEvaluator - Kural tabanli diagnostik degerlendirme motoru
 *
 * DiagnosticReportBuilder'in ham JSON raporunu alir, kural tabanli
 * analiz yaparak bulgular (findings) ve skor uretir.
 *
 * Client tarafinda sadece free katman tutulur. Premium detaylar server/Worker
 * endpointinden gelir; odeme yapilmadan client bundle'da uretilmez.
 */
import { QUALITY, VU_METER } from './constants.js';
import { usableReport } from './MeasurementValidity.js';
import { getConstraintMismatches, getAppliedConstraints } from './CaptureContext.js';

class ReportEvaluator {
  constructor() {
    // Each rule assesses measured audio; premium interpretation stays server-side.
    this._rules = [
      (r) => this._ruleSignal(r),
      (r) => this._ruleNoise(r),
      (r) => this._ruleSnr(r),
      (r) => this._ruleClipping(r),
      (r) => this._ruleTruePeak(r),
      (r) => this._ruleHeadroom(r),
      (r) => this._ruleDropout(r),
      (r) => this._ruleChannelLayout(r),
      (r) => this._ruleAppliedSettings(r),
      (r) => this._ruleGainControl(r)
    ];
  }

  registerRule(fn) {
    this._rules.push(fn);
  }

  // === PUBLIC API ===

  /**
   * Free katman: Ozet degerlendirme
   * @param {Object} report - DiagnosticReportBuilder.build() ciktisi
   * @returns {{ overall, findings, summary, scopeSummary, scope, assessment }} Olcum kapsami ve yeterlilik durumu dahil.
   */
  evaluateFree(report, platform = null) {
    if (report?.run?.type === 'troubleshooting') {
      return { overall: { score: 'unknown', stars: null, label: 'Troubleshooting only', color: 'muted' }, findings: [],
        summary: 'No audio was recorded for this report.',
        assessment: { status: 'not-measured' }, scope: 'No microphone, application, network or driver performance was measured in this troubleshooting report.' };
    }
    const checked = usableReport(report);
    report = checked.report;
    const m = report.audioMetrics;
    if (!checked.valid) {
      return { overall: { score: 'unknown', stars: null, label: 'Insufficient audio', color: 'muted' }, findings: [],
        summary: 'There is not enough measured audio to assess this recording.',
        assessment: { status: 'insufficient' }, scope: this._buildScope(report) };
    }
    const classified = this._rules.map(rule => rule(report)).filter(Boolean).map(finding => platform?.status === 'compared'
      && platform.expectedFindingIds?.includes(finding.id)
      ? { ...finding, severity: 'info', expectation: 'within-reference', message: `${finding.message} This characteristic is within the validated range for this local scenario.` }
      : finding);
    const findings = classified.filter(finding => finding.id !== 'LOW_SNR'
      || !classified.some(other => other.id === 'HIGH_NOISE' && other.expectation !== 'within-reference'));
    // These rules have no validated perceptual-quality model. Even supplied
    // speech/noise measurements cannot turn their flags into a five-star rating.
    const overall = this._calculateOverall(findings);
    const hasExpected = findings.some(finding => finding.expectation === 'within-reference');
    const hasWarning = findings.some(finding => ['warning', 'critical'].includes(finding.severity));
    const summary = !hasWarning && (hasExpected || platform?.hasDeviation) ? platform.summary : this._generateSummary(findings);
    if (!hasWarning && hasExpected) overall.label = 'Compared findings are expected';
    if (!hasWarning && platform?.hasDeviation) overall.label = 'Scenario difference found';
    const scope = [this._buildScope(report, m), platform?.summary].filter(Boolean).join(' ');
    return { overall, findings, summary, scope,
      scopeSummary: `${m.coverage?.truncated ? `First ${+(m.durationMs / 1000).toFixed(2)} s of saved audio only` : 'Saved audio only'}; speech clarity and recipient audio are unmeasured.`,
      assessment: { status: 'limited', speech: 'not-measured', recipientAudio: 'not-measured', rootCause: 'undetermined' } };
  }

  _buildScope(report, metrics) {
    const context = report?.communicationContext;
    const usage = { 'voice-call': 'Voice Calls', 'voice-message': 'Voice Messages', recording: 'Recording' }[context?.usage];
    const access = { mobile: 'Mobile browser (inferred)', desktop: 'Desktop browser (inferred)' }[context?.access?.formFactor];
    const parts = [usage, access].filter(Boolean);
    if (report?.profile?.evidence?.summary) parts.push(report.profile.evidence.summary);
    if (metrics) parts.push(`Analysed ${+(metrics.durationMs / 1000).toFixed(2)} seconds of the saved recording${metrics.coverage?.truncated ? ' (first part only)' : ''}`);
    if (metrics && metrics.clipping?.status !== 'measured') parts.push('Full-scale sample counts are unavailable for this recording');
    if (metrics?.guidedNoise) {
      const reasons = {
        'guided-prompts-incomplete': 'The guided prompts were interrupted or the page was hidden',
        'guided-segments-too-short': 'The recording ended before both guided segments were long enough',
        'guided-level-below-resolution': 'One guided segment had too little recorded signal to estimate a ratio',
        'quiet-segment-not-steady': 'The quiet segment was not steady enough for the estimate',
        'speaking-not-separated-from-quiet': 'The speaking segment was not clearly louder than the quiet segment'
      };
      parts.push(metrics.guidedNoise.status === 'measured'
        ? 'Guided levels describe the recorded quiet and speaking segments; they assume you followed the prompts and do not measure microphone self-noise'
        : `${reasons[metrics.guidedNoise.reason] || 'The guided segments could not be assessed'}. A reliable comparison of quiet and speaking levels is unavailable`);
      if (metrics.snr?.reason === 'processing-limits-snr-estimate') parts.push('Recorded segment contrast is available, but active or unknown browser processing prevents an SNR estimate');
      if (metrics.snr?.reason === 'speaking-segment-clipped') parts.push('SNR is unavailable because the speaking segment reached full scale');
      if (metrics.snr?.status === 'measured') parts.push('Estimated SNR assumes stable background sound and gain; speech is not automatically verified');
      if (metrics.noiseFloor?.status !== 'measured' || metrics.snr?.status !== 'measured') parts.push('Noise or signal-to-noise remains unassessed where the corresponding segment evidence is unavailable');
    } else if (metrics && (metrics.noiseFloor?.status !== 'measured' || !Number.isFinite(metrics.noiseFloor.estimatedDb)
        || metrics.snr?.status !== 'measured' || !Number.isFinite(metrics.snr.estimatedDb))) {
      parts.push('Noise or signal-to-noise remains unassessed without controlled quiet and speaking segments');
    }
    if (report?.run?.type === 'test') parts.push('The local browser call was saved as another recording, so these measurements include that additional encoding');
    parts.push('Checks describe the saved audio. Speech intelligibility and what a recipient hears in a mobile, desktop or web app are not measured');
    parts.push('Short loud sounds or another channel can mask quiet speech. Full-scale sample counts do not detect every kind of distortion');
    parts.push('The operating-system input level, driver processing and audio enhancements are not visible to the browser');
    if (report?.profile?.approximation || context?.usage === 'voice-call' || context?.usage === 'voice-message') {
      parts.push('Platform presets are local approximations; native app codecs, processing and networks are not reproduced');
    }
    return parts.join('. ') + '.';
  }

  // === PRIVATE: Core Rules (OCP registry — davranis birebir) ===

  // Kural 1+2: Sessizlik / Zayif sinyal (mutually exclusive)
  _ruleSignal(report) {
    const m = report.audioMetrics; const Q = QUALITY;
    // Pauses dilute whole-file RMS. Even the loudest window must be low before
    // judging the level. Older reports used unequal/non-overlapping windows;
    // their sample peak is a conservative bound until the audio is reanalysed.
    // Neither measurement identifies speech or proves that speech is intelligible.
    const hasWindow = m.signal?.maxBlockRmsStatus === 'measured' && Number.isFinite(m.signal.maxBlockRmsDb);
    const signalDb = hasWindow ? m.signal.maxBlockRmsDb : m.signal?.peakDb;
    const metric = hasWindow ? 'maxBlockRmsDb' : 'peakDb';
    if (!Number.isFinite(signalDb)) return null;
    if (signalDb < Q.SILENCE_DB) {
      return { id: 'SILENCE', severity: 'critical', metric, value: signalDb, threshold: Q.SILENCE_DB, basis: 'loudest-window',
        message: 'Even the loudest part of this recording is very quiet.' };
    }
    // Gated integrated loudness ignores pauses and dilutes one brief loud moment,
    // so a recording that is quiet almost everywhere is still reported as quiet.
    // Identical channels are judged by their mono equivalent (BS.1770 sums channel powers).
    const sustained = this._sustainedLoudness(m);
    if (sustained !== null && sustained < Q.SUSTAINED_SILENCE_LUFS) {
      return { id: 'SILENCE', severity: 'critical', metric: 'lufsIntegrated', value: sustained, threshold: Q.SUSTAINED_SILENCE_LUFS,
        basis: 'integrated-loudness', loudestWindowDb: signalDb,
        message: 'Apart from a brief louder moment, this recording is very quiet.' };
    }
    if (signalDb < Q.WEAK_SIGNAL_DB) {
      return { id: 'WEAK_SIGNAL', severity: 'warning', metric, value: signalDb, threshold: Q.WEAK_SIGNAL_DB, basis: 'loudest-window',
        message: 'Even the loudest part of this recording has a low level.' };
    }
    if (sustained !== null && sustained < Q.SUSTAINED_WEAK_LUFS) {
      return { id: 'WEAK_SIGNAL', severity: 'warning', metric: 'lufsIntegrated', value: sustained, threshold: Q.SUSTAINED_WEAK_LUFS,
        basis: 'integrated-loudness', loudestWindowDb: signalDb,
        message: 'Apart from a brief louder moment, this recording has a low level.' };
    }
    if (m.signal.rmsDb < Q.WEAK_SIGNAL_DB) {
      return { id: 'LOW_AVERAGE_LEVEL', severity: 'info', metric: 'signalDb', value: m.signal.rmsDb, threshold: Q.WEAK_SIGNAL_DB,
        message: 'The average level is low, but pauses can lower this average. This observation does not lower the result.' };
    }
    return null;
  }

  // Kural 3: Yuksek gurultu
  _ruleNoise(report) {
    const m = report.audioMetrics; const Q = QUALITY;
    const nf = m.noiseFloor?.estimatedDb;
    if (m.noiseFloor?.status !== 'measured' || !Number.isFinite(nf)) return null;
    if (nf != null && nf > Q.NOISE_FLOOR_CRITICAL_DB) {
      return { id: 'HIGH_NOISE', severity: 'critical', metric: 'noiseFloor', value: nf, threshold: Q.NOISE_FLOOR_CRITICAL_DB,
        message: 'The measured noise segment has a high level.' };
    }
    if (nf != null && nf > Q.NOISE_FLOOR_WARNING_DB) {
      return { id: 'HIGH_NOISE', severity: 'warning', metric: 'noiseFloor', value: nf, threshold: Q.NOISE_FLOOR_WARNING_DB,
        message: 'The measured noise segment has a high level.' };
    }
    return null;
  }

  // Kural 4: Dusuk SNR
  _ruleSnr(report) {
    const m = report.audioMetrics; const Q = QUALITY;
    const snr = m.snr?.estimatedDb;
    if (m.snr?.status !== 'measured' || !Number.isFinite(snr)) return null;
    if (snr != null && snr < Q.SNR_CRITICAL_DB) {
      return { id: 'LOW_SNR', severity: 'critical', metric: 'snr', value: snr, threshold: Q.SNR_CRITICAL_DB,
        message: 'The measured speech and noise segments have little level separation.' };
    }
    if (snr != null && snr < Q.SNR_WARNING_DB) {
      return { id: 'LOW_SNR', severity: 'warning', metric: 'snr', value: snr, threshold: Q.SNR_WARNING_DB,
        message: 'The measured signal-to-noise ratio is low.' };
    }
    return null;
  }

  // Kural 5: Clipping
  _ruleClipping(report) {
    const m = report.audioMetrics; const Q = QUALITY;
    const cr = m.clipping?.rate;
    if (m.clipping?.status === 'measured' && cr > Q.CLIPPING_RATE_CRITICAL) {
      return { id: 'CLIPPING', severity: 'critical', metric: 'clippingRate', value: cr, threshold: Q.CLIPPING_RATE_CRITICAL,
        message: 'Many recorded samples reach or exceed full scale.' };
    }
    if (cr > 0) {
      return { id: 'CLIPPING', severity: 'warning', metric: 'clippingRate', value: cr, threshold: Q.CLIPPING_RATE_WARNING,
        message: 'Some recorded samples reach or exceed full scale.' };
    }
    // A concentrated ceiling can be consistent with limiting/clipping, including
    // an earlier stage followed by attenuation. It cannot locate that stage or
    // establish audible distortion from this waveform pattern alone.
    // Pure tones also sit near their ceiling about 30 % of the time with a 3 dB crest;
    // clipped audio exceeds 45 % even after resampling, and stays flat only when unresampled.
    const ceiling = m.ceiling, crest = m.signal?.crestFactorDb;
    if (ceiling?.status === 'measured' && Number.isFinite(ceiling.nearCeilingRate) && Number.isFinite(crest)
        && crest <= Q.FLAT_TOP_CREST_DB && ceiling.nearCeilingRate >= Q.FLAT_TOP_NEAR_RATE_WARNING) {
      const critical = ceiling.nearCeilingRate >= Q.FLAT_TOP_NEAR_RATE_CRITICAL || ceiling.flatTopRate >= Q.FLAT_TOP_RATE_CRITICAL;
      const level = Number.isFinite(ceiling.ceilingDb) ? ceiling.ceilingDb : m.signal.peakDb;
      return { id: 'PINNED_CEILING', severity: critical ? 'critical' : 'warning', metric: 'nearCeilingRate', value: ceiling.nearCeilingRate,
        threshold: critical ? Q.FLAT_TOP_NEAR_RATE_CRITICAL : Q.FLAT_TOP_NEAR_RATE_WARNING, ceilingDb: level,
        flatTopRate: ceiling.flatTopRate, crestFactorDb: crest,
        message: `Many samples cluster near a ceiling of ${level} dBFS below full scale, with a peak-to-average spread of ${crest} dB. Clipping or limiting can produce this pattern; the recording does not identify where it happened or whether it is audible.` };
    }
    return null;
  }

  // Kural 5b: Inter-sample peaks above full scale (BS.1770-4 true peak)
  _ruleTruePeak(report) {
    const m = report.audioMetrics; const Q = QUALITY;
    if ((m.clipping?.rate ?? 0) > 0 || m.truePeak?.status !== 'measured' || !Number.isFinite(m.truePeak.db)) return null;
    if (m.truePeak.db > Q.TRUE_PEAK_WARNING_DBTP) {
      return { id: 'TRUE_PEAK_OVER', severity: 'warning', metric: 'truePeakDb', value: m.truePeak.db, threshold: Q.TRUE_PEAK_WARNING_DBTP,
        message: `Inter-sample peaks reach ${m.truePeak.db} dBTP, above full scale, although no stored sample is at full scale. Playback or re-encoding can clip these peaks.` };
    }
    return null;
  }

  // Kural 7: Identical channels (dual-mono) inflate loudness by 3.01 LU
  _ruleChannelLayout(report) {
    const m = report.audioMetrics;
    if (m.channelLayout !== 'dual-mono' || m.channelIdentity?.identical !== true) return null;
    return { id: 'DUAL_MONO', severity: 'info', metric: 'channelLayout', value: 'dual-mono', threshold: null,
      lufsIntegrated: m.lufs?.integrated ?? null, lufsMonoEquivalent: m.lufs?.integratedMonoEquivalent ?? null,
      message: 'Both channels carry the same signal (dual-mono), as a single-input interface delivered as a stereo pair does. Loudness sums channel powers, so the LUFS value reads 3 dB above the equivalent mono signal; level findings use the mono equivalent.' };
  }

  // Kural 8: The device applied different settings than requested
  _ruleAppliedSettings(report) {
    const mismatches = getConstraintMismatches(report.profile);
    if (!mismatches.length) return null;
    const label = { sampleRate: 'sample rate', channelCount: 'channel count', echoCancellation: 'echo cancellation',
      noiseSuppression: 'noise suppression', autoGainControl: 'automatic gain control' };
    const text = mismatches.map(item => `${label[item.key] || item.key} ${String(item.applied)} instead of ${String(item.requested)}`).join(', ');
    return { id: 'SETTINGS_NOT_APPLIED', severity: 'info', metric: 'constraintMismatches', value: mismatches.length, threshold: null,
      mismatches, message: `The device applied ${text}. Measurements describe the applied settings, not the requested ones.` };
  }

  // Kural 9: Automatic gain control may also move the system input level
  _ruleGainControl(report) {
    if (getAppliedConstraints(report.profile).autoGainControl !== true) return null;
    return { id: 'AGC_ACTIVE', severity: 'info', metric: 'autoGainControl', value: true, threshold: null,
      message: 'Automatic gain control was active, so the recorded level does not show the microphone\'s own level. The browser may also adjust the system input level during such runs, which can change later recordings made with processing disabled.' };
  }

  _sustainedLoudness(m) {
    const lufs = m.lufs;
    if (lufs?.status !== 'measured' || lufs.integratedStatus !== 'measured' || !Number.isFinite(lufs.integrated)) return null;
    return Number.isFinite(lufs.integratedMonoEquivalent) ? lufs.integratedMonoEquivalent : lufs.integrated;
  }

  // Kural 6: Dropout
  _ruleDropout(report) {
    const m = report.audioMetrics; const Q = QUALITY;
    const dc = m.dropouts?.count;
    if (m.dropouts?.status !== 'measured' || !Number.isFinite(dc)) return null;
    if (dc != null && dc >= Q.DROPOUT_COUNT_CRITICAL) {
      return { id: 'DROPOUTS', severity: 'critical', metric: 'dropoutCount', value: dc, threshold: Q.DROPOUT_COUNT_CRITICAL,
        message: 'Repeated gaps were found in the measured audio timeline.' };
    }
    if (dc != null && dc >= Q.DROPOUT_COUNT_WARNING) {
      return { id: 'DROPOUTS', severity: 'warning', metric: 'dropoutCount', value: dc, threshold: Q.DROPOUT_COUNT_WARNING,
        message: 'Gaps were found in the measured audio timeline.' };
    }
    return null;
  }

  _ruleHeadroom(report) {
    const m = report.audioMetrics;
    if ((m.clipping?.rate ?? 0) > 0) return null;
    if (Number.isFinite(m.headroom?.peakDb) && m.headroom.peakDb >= VU_METER.CLIPPING_THRESHOLD_DB) {
      return { id: 'LOW_HEADROOM', severity: 'info', metric: 'peakDb', value: m.headroom.peakDb, threshold: VU_METER.CLIPPING_THRESHOLD_DB,
        message: 'Peaks are close to full scale without measured full-scale samples. This alone does not prove distortion or lower the result.' };
    }
    return null;
  }

  // === PRIVATE: Scoring ===

  _calculateOverall(findings) {
    const criticalCount = findings.filter(f => f.severity === 'critical').length;
    const warningCount = findings.filter(f => f.severity === 'warning').length;

    if (criticalCount === 0 && warningCount === 0) {
      return { score: 'limited', stars: null, label: 'No recording warnings found', color: 'muted' };
    }
    if (criticalCount > 0) return { score: 'critical', stars: null, label: 'Needs attention', color: 'danger' };
    return { score: 'fair', stars: null, label: 'Review recording', color: 'warning' };
  }

  _generateSummary(findings) {
    const firstIssue = findings.find(f => f.severity === 'critical')
      || findings.find(f => f.severity === 'warning');
    if (!firstIssue) return 'The available checks found no signs of very low recording level or audio exceeding its recording limits.';
    // The preview describes the observation. Detailed evidence and possible causes
    // belong to the Premium findings; never reuse their full messages here.
    const summaries = {
      SILENCE: 'Very little sound was captured in this recording.',
      WEAK_SIGNAL: 'The recording has a low sound level.',
      HIGH_NOISE: 'The measured noise segment has a high level.',
      LOW_SNR: 'The recorded speaking and quiet sections have little level separation.',
      CLIPPING: 'The recording shows signs of possible distortion.',
      PINNED_CEILING: 'The recording shows signs of possible distortion.',
      TRUE_PEAK_OVER: 'The recording shows signs of possible distortion.',
      DROPOUTS: 'Interruptions were detected in the recorded audio.'
    };
    return summaries[firstIssue.id] || 'The recording contains a finding that needs attention.';
  }

}

// Singleton
const reportEvaluator = new ReportEvaluator();
export default reportEvaluator;
