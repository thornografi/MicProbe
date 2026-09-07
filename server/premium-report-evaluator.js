// Private premium rules shared by the Node server and the bundled Worker adapter.
const { getTroubleshootingGuidance } = require('./troubleshooting-guidance.js');
// Thresholds mirror js/modules/constants.js QUALITY; the client bundle is not importable here.
const QUALITY = { WEAK_SIGNAL_DB: -45, SILENCE_DB: -55, SNR_WARNING_DB: 10, NOISE_FLOOR_WARNING_DB: -30, SUSTAINED_WEAK_LUFS: -40,
  SUSTAINED_SILENCE_LUFS: -55, FLAT_TOP_CREST_DB: 8, FLAT_TOP_NEAR_RATE_WARNING: 0.4, FLAT_TOP_NEAR_RATE_CRITICAL: 0.5,
  FLAT_TOP_RATE_CRITICAL: 0.25, TRUE_PEAK_WARNING_DBTP: 0, HEADROOM_INFO_DB: -0.5 };
const SETTING_LABELS = { sampleRate: 'sample rate', channelCount: 'channel count', echoCancellation: 'echo cancellation',
  noiseSuppression: 'noise suppression', autoGainControl: 'automatic gain control' };
const sustainedLoudness = m => m?.lufs?.status === 'measured' && m.lufs.integratedStatus === 'measured' && finite(m.lufs.integrated)
  ? (finite(m.lufs.integratedMonoEquivalent) ? m.lufs.integratedMonoEquivalent : m.lufs.integrated) : null;
const pinnedCeiling = m => m?.ceiling?.status === 'measured' && finite(m.ceiling.nearCeilingRate)
  && finite(m.signal?.crestFactorDb) && m.signal.crestFactorDb <= QUALITY.FLAT_TOP_CREST_DB
  && m.ceiling.nearCeilingRate >= QUALITY.FLAT_TOP_NEAR_RATE_WARNING
  ? (m.ceiling.nearCeilingRate >= QUALITY.FLAT_TOP_NEAR_RATE_CRITICAL || m.ceiling.flatTopRate >= QUALITY.FLAT_TOP_RATE_CRITICAL
    ? 'critical' : 'warning') : null;
const finite = Number.isFinite;
const measured = (m, key) => m?.status === 'measured' && finite(m[key]) ? m[key] : null;
const percent = (value) => finite(value) ? +(value * 100).toFixed(1) : null;
const rate = (v, good, warn) => !finite(v) ? 'info' : v >= good ? 'good' : v >= warn ? 'fair' : 'poor';
const reverse = (v, good, warn) => !finite(v) ? 'info' : v <= good ? 'good' : v <= warn ? 'fair' : 'poor';

// Guidance has a description instead of a captured audio sample. Keep the
// endpoint contract identical across account/legacy and Node/Worker adapters.
function isDetailedReportInput(report) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(report)) return false;
  if (report.run?.type === 'troubleshooting') {
    return typeof report.run.id === 'string' && !!report.run.id.trim() && report.run.id.length <= 160
      && object(report.troubleshooting) && report.troubleshooting.version === 1;
  }
  return object(report.audioMetrics);
}

function metric(key, label, value, unit = '', rating = 'info') {
  value = typeof value === 'number' && !finite(value) ? null : value ?? null;
  return { key, label, value, unit, rating: value === null ? 'info' : rating };
}

function sufficient(report) {
  const m = report?.audioMetrics;
  return m?.status === 'measured' && m.sampleCount > 0 && m.durationMs >= 400
    && finite(m.signal?.rmsDb) && finite(m.signal?.peakDb)
    && m.clipping?.status === 'measured' && m.clipping.method === 'sample-saturation' && finite(m.clipping.rate);
}

function formatDetailedMetrics(report) {
  if (!sufficient(report)) return [metric('assessment', 'Assessment', 'Insufficient audio')];
  const m = report.audioMetrics;
  const noise = measured(m.noiseFloor, 'estimatedDb');
  const snr = measured(m.snr, 'estimatedDb');
  const saturation = m.clipping?.method === 'sample-saturation' ? measured(m.clipping, 'rate') : null;
  const frequency = m.frequencyResponse || {};
  const metrics = [
    metric('source', 'Measured Audio', m.source === 'decoded-file-pcm' ? 'Saved recording' : 'Unavailable'),
    metric('duration', 'Audio Analysed', m.durationMs / 1000, 's'),
    metric('coverage', 'Recording Coverage', m.coverage?.truncated === true ? 'First part only' : m.coverage?.truncated === false ? 'Whole recording' : null),
    metric('speechAssessment', 'Speech Clarity', 'Not measured'),
    metric('recipientAssessment', 'Recipient Audio', 'Not measured'),
    metric('rootCause', 'Cause of Any Problem', 'Not determined'),
    metric('rms', 'Average Level', m.signal?.rmsDb, 'dBFS'),
    metric('maxBlockRms', 'Loudest Short-window Level', m.signal?.maxBlockRmsStatus === 'measured' ? m.signal.maxBlockRmsDb : null, 'dBFS'),
    metric('levelWindowMs', 'Level Window Duration', m.signal?.maxBlockRmsStatus === 'measured' ? m.signal.maxBlockRmsWindowMs : null, 'ms'),
    metric('peak', 'Sample Peak', m.signal?.peakDb, 'dBFS'),
    metric('truePeak', 'True Peak (4x over-sampled)', measured(m.truePeak, 'db'), 'dBTP',
      finite(measured(m.truePeak, 'db')) ? (m.truePeak.db > QUALITY.TRUE_PEAK_WARNING_DBTP ? 'poor' : 'good') : 'info'),
    metric('crestFactor', 'Peak-to-average Spread', m.signal?.crestFactorDb, 'dB'),
    metric('ceiling', 'Waveform Ceiling (99th percentile)', measured(m.ceiling, 'ceilingDb'), 'dBFS'),
    metric('nearCeiling', 'Samples at the Ceiling', percent(measured(m.ceiling, 'nearCeilingRate')), '%',
      pinnedCeiling(m) === 'critical' ? 'poor' : pinnedCeiling(m) === 'warning' ? 'fair' : finite(measured(m.ceiling, 'nearCeilingRate')) ? 'good' : 'info'),
    metric('flatTop', 'Samples Flat at the Ceiling', percent(measured(m.ceiling, 'flatTopRate')), '%'),
    metric('channelLayout', 'Channel Layout', typeof m.channelLayout === 'string' ? m.channelLayout : null),
    metric('snr', m.guidedNoise ? 'Estimated SNR (guided)' : 'Signal / Noise', snr, 'dB', rate(snr, 20, QUALITY.SNR_WARNING_DB)),
    metric('noiseFloor', m.guidedNoise ? 'Recorded Quiet-segment Level' : 'Measured Noise Floor', noise, 'dBFS', reverse(noise, -45, QUALITY.NOISE_FLOOR_WARNING_DB)),
    ...(m.guidedNoise ? [metric('segmentContrast', 'Speaking / Quiet Segment Contrast', measured(m.guidedNoise, 'contrastDb'), 'dB')] : []),
    metric('lowLevel', 'Quietest Sections', m.lowLevel?.percentileDb, 'dBFS'),
    metric('dynamicRange', 'Level Variation', measured(m.dynamicRange, 'db'), 'dB'),
    metric('clipping', 'Full-scale Samples', percent(saturation), '%', reverse(saturation, 0, 0.05)),
    metric('clippingEvents', 'Full-scale Events', m.clipping?.method === 'sample-saturation' ? measured(m.clipping, 'eventCount') : null, 'events'),
    metric('headroom', 'Peak Headroom', m.headroom?.db, 'dB'),
    metric('silence', 'Low-level Time', m.silence?.totalDurationMs, 'ms'),
    metric('dropouts', 'Confirmed Audio Gaps', measured(m.dropouts, 'count'), 'count'),
    metric('dropoutDuration', 'Confirmed Gap Time', measured(m.dropouts, 'totalDurationMs'), 'ms'),
    metric('stability', 'Level Standard Deviation', m.stability?.dbStdDev, 'dB'),
    metric('lufsIntegrated', 'Integrated Loudness', m.lufs?.integrated, 'LUFS'),
    metric('lufsMonoEquivalent', 'Mono-equivalent Loudness', m.lufs?.integratedMonoEquivalent, 'LUFS'),
    metric('lufsShortTerm', 'Short-term Loudness', m.lufs?.shortTerm, 'LUFS'),
    metric('frequencyBins', 'Spectrum Detail', frequency.bins?.length, 'bins'),
    metric('frequencyResolution', 'Spectrum Resolution', frequency.binWidthHz ?? frequency.binWidth, 'Hz/bin')
  ];
  const source = report.run?.type === 'test' ? report.loopback : report.recording;
  if (source) metrics.push(
    metric('targetBitrate', report.run?.type === 'test' ? 'Requested RTP Bitrate Ceiling' : 'Requested File Bitrate', finite(source.requestedBitrate) ? source.requestedBitrate / 1000 : source.requestedKbps, 'kbps'),
    metric('actualBitrate', report.run?.type === 'test' ? 'Measured RTP Payload Bitrate' : 'Measured File Bitrate', finite(source.actualBitrate) ? source.actualBitrate / 1000 : source.actualKbps, 'kbps'),
    metric('bitrateDeviation', 'Bitrate Difference', percent(source.bitrateDeviation), '%')
  );
  const profile = report.profile || {};
  const settingText = values => values && typeof values === 'object'
    ? Object.keys(SETTING_LABELS).filter(key => values[key] !== undefined && values[key] !== null)
      .map(key => `${SETTING_LABELS[key]} ${String(values[key])}`).join(', ') || null : null;
  metrics.push(
    metric('requestedSettings', 'Requested Capture Settings', settingText(profile.requestedConstraints)),
    metric('appliedSettings', 'Applied Capture Settings', settingText(profile.appliedConstraints), '',
      Array.isArray(profile.constraintMismatches) && profile.constraintMismatches.length ? 'fair' : 'info'),
    metric('osInputLevel', 'System Input Level', 'Not visible to the browser'),
    metric('osProcessing', 'Driver / OS Enhancements', 'Not visible to the browser')
  );
  const file = report.recording;
  metrics.push(
    metric('fileMimeType', 'Saved File Format', typeof file?.mimeType === 'string' ? file.mimeType : null),
    metric('fileEncoderBitrate', 'File Encoder Target (Browser-reported)', finite(file?.encoderReportedBitrate) ? file.encoderReportedBitrate / 1000 : null, 'kbps')
  );
  if (report.profile?.approximation) metrics.push(
    metric('platformMatch', 'Platform Match', 'Local approximation'),
    metric('platformEvidenceDate', 'Platform Sources Reviewed', report.profile.evidence?.verifiedAt),
    metric('targetClientVersion', 'Actual App Version', null),
    metric('targetClientCodec', 'Actual App Codec', null)
  );
  if (report.loopback) {
    const lb = report.loopback;
    metrics.push(
      metric('senderCodec', 'Local RTP Sender Codec', typeof lb.senderCodec?.mimeType === 'string' ? lb.senderCodec.mimeType : null),
      metric('receiverCodec', 'Local RTP Receiver Codec', typeof lb.receiverCodec?.mimeType === 'string' ? lb.receiverCodec.mimeType : null),
      metric('rtt', 'Local Loopback RTT', lb.rttMs, 'ms'),
      metric('jitter', 'Local Receiver Jitter', lb.jitterMs, 'ms'),
      metric('packetLoss', 'Local Packet Loss', percent(lb.packetLossRate), '%'),
      metric('dtx', 'DTX Evidence', typeof lb.isDtxActive === 'boolean' ? (lb.isDtxActive ? 'Observed' : 'Not observed') : null)
    );
  }
  return metrics;
}

function recommendation(id, reason, action, options = {}) {
  return { id, category: 'setting', severity: 'info', confidence: 'low', relatedSetting: null,
    ...options, reason, message: reason, action };
}

function analyzeMeasurements(report) {
  const m = report.audioMetrics;
  const c = report.profile?.appliedConstraints || report.profile?.constraints || {};
  const noise = measured(m.noiseFloor, 'estimatedDb');
  const snr = measured(m.snr, 'estimatedDb');
  const recs = [];
  if (noise === null || snr === null) recs.push(recommendation('NOISE_UNMEASURED',
    m.snr?.reason === 'processing-limits-snr-estimate'
      ? 'Recorded quiet and speaking levels are available. Active or unknown browser processing prevents an SNR estimate.'
      : m.guidedNoise ? 'This guided recording did not provide enough usable quiet and speaking data for an SNR estimate.'
        : 'Noise floor and signal-to-noise need separate quiet and speaking segments. Quiet sections alone cannot identify microphone noise.',
    m.snr?.reason === 'processing-limits-snr-estimate'
      ? 'Compare another test using the same settings, room and microphone distance. Your current settings allow a comparison of the quiet and speaking levels.'
      : 'Test again. Stay quiet when asked, then read the sentence at your usual distance until the test finishes.', { category: 'environment' }));
  if (noise !== null && noise > QUALITY.NOISE_FLOOR_WARNING_DB) recs.push(recommendation('MEASURED_NOISE',
    'The measured noise segment has a high level.',
    c.noiseSuppression === false ? 'Compare a repeat with noise suppression enabled, keeping distance and gain the same.'
      : 'Compare the same speaking level in a quieter setting.', { category: 'environment', relatedSetting: 'ns' }));
  if (snr !== null && snr < QUALITY.SNR_WARNING_DB) recs.push(recommendation('MEASURED_LOW_SNR',
    'The measured speech and noise segments have little level separation.',
    'Repeat at the same speaking level with less background sound.', { category: 'environment' }));
  // Older maxima include unequal/non-overlapping windows. Use their sample peak
  // conservatively; neither measurement detects speech or its intelligibility.
  const loudestDb = m.signal.maxBlockRmsStatus === 'measured' && finite(m.signal.maxBlockRmsDb)
    ? m.signal.maxBlockRmsDb : m.signal.peakDb;
  // Gated loudness ignores pauses and dilutes one brief loud moment; identical
  // channels are judged by their mono equivalent.
  const sustained = sustainedLoudness(m);
  const windowSilent = loudestDb < QUALITY.SILENCE_DB, windowWeak = loudestDb < QUALITY.WEAK_SIGNAL_DB;
  const sustainedSilent = sustained !== null && sustained < QUALITY.SUSTAINED_SILENCE_LUFS;
  const sustainedWeak = sustained !== null && sustained < QUALITY.SUSTAINED_WEAK_LUFS;
  if (windowSilent || sustainedSilent || windowWeak || sustainedWeak) recs.push(recommendation('LOW_RECORDED_LEVEL',
    windowSilent ? 'Even the loudest part of this recording is very quiet.'
      : sustainedSilent ? `Apart from a brief louder moment, this recording is very quiet (${sustained} LUFS gated loudness).`
        : windowWeak ? 'Even the loudest part of this recording has a low level.'
          : `Apart from a brief louder moment, this recording has a low level (${sustained} LUFS gated loudness).`,
    'Listen to the spoken parts and compare a repeat at a closer speaking distance or a higher input level.',
    { severity: windowSilent || sustainedSilent ? 'critical' : 'warning' }));
  else if (m.signal.rmsDb < QUALITY.WEAK_SIGNAL_DB) recs.push(recommendation('LOW_AVERAGE_LEVEL',
    'The average level is low. Pauses can lower it, and short loud sounds or another channel can mask quiet speech. Speech level was not assessed.',
    'Judge the spoken parts during playback before changing any setting.', { category: 'observation' }));
  if (m.clipping?.method === 'sample-saturation' && measured(m.clipping, 'rate') > 0) {
    recs.push(recommendation('FULL_SCALE_SAMPLES', 'Some saved samples reach or exceed full scale. This alone does not prove audible distortion.',
      'Listen for distortion, then compare a repeat at a greater speaking distance or with a lower input level, if available.', { severity: 'warning' }));
  } else if (pinnedCeiling(m)) {
    recs.push(recommendation('PINNED_CEILING',
      `The waveform is pinned at a ceiling of ${finite(m.ceiling.ceilingDb) ? m.ceiling.ceilingDb : m.signal.peakDb} dBFS, below full scale, with a peak-to-average spread of only ${m.signal.crestFactorDb} dB. This matches clipping before the browser received the audio; full-scale sample counts cannot show it because the level was reduced afterwards.`,
      'Listen for distortion. Lower the interface or microphone gain first; the system input level below 100% only hides clipping, it does not remove it.',
      { severity: pinnedCeiling(m), relatedSetting: 'input-gain' }));
  } else if (finite(m.headroom?.peakDb) && m.headroom.peakDb >= QUALITY.HEADROOM_INFO_DB) {
    recs.push(recommendation('LOW_HEADROOM', 'Peaks are close to full scale without measured full-scale samples. This does not prove distortion or lower the result.',
      'No setting change is needed from headroom alone; compare playback if you hear distortion.', { category: 'observation' }));
  }
  if (!(measured(m.clipping, 'rate') > 0) && finite(measured(m.truePeak, 'db')) && m.truePeak.db > QUALITY.TRUE_PEAK_WARNING_DBTP) {
    recs.push(recommendation('TRUE_PEAK_OVER',
      `Inter-sample peaks reach ${m.truePeak.db} dBTP, above full scale, although no stored sample is at full scale.`,
      'Playback or re-encoding can clip these peaks. Compare a repeat with slightly more headroom if you hear distortion.', { severity: 'warning' }));
  }
  if (m.channelLayout === 'dual-mono' && m.channelIdentity?.identical === true) recs.push(recommendation('DUAL_MONO',
    `Both channels carry the same signal, so the integrated loudness of ${m.lufs?.integrated} LUFS reads 3 dB above its mono equivalent of ${m.lufs?.integratedMonoEquivalent} LUFS. A single-input interface delivered as a stereo pair usually causes this.`,
    'No change is needed. Compare loudness figures with mono recordings using the mono equivalent.', { category: 'observation' }));
  const mismatches = Array.isArray(report.profile?.constraintMismatches) ? report.profile.constraintMismatches : [];
  if (mismatches.length) recs.push(recommendation('SETTINGS_NOT_APPLIED',
    `The device applied ${mismatches.map(item => `${SETTING_LABELS[item.key] || item.key} ${String(item.applied)} instead of ${String(item.requested)}`).join(', ')}.`,
    'Measurements describe the applied settings. Change the device or its system format if the requested value matters for your comparison.',
    { relatedSetting: mismatches[0].key }));
  if (c.autoGainControl === true) recs.push(recommendation('AGC_SYSTEM_LEVEL',
    'Automatic gain control was active, so the recorded level does not show the microphone\'s own level. The browser may also adjust the system input level during such runs.',
    'Check the system input level before comparing with a recording made with processing disabled.', { category: 'observation', relatedSetting: 'agc' }));
  if (m.silence?.totalDurationMs > 0) recs.push(recommendation('LOW_LEVEL_SECTIONS',
    'This recording contains low-level sections. Pauses and audio gaps can both look quiet.',
    'Listen to those sections and repeat the same phrase if sound disappeared while you were speaking.', { category: 'observation' }));
  if (m.coverage?.truncated) recs.push(recommendation('PARTIAL_RECORDING',
    'Only the first part of this recording was analysed.',
    'Use a shorter recording that includes the sound you want to compare.'));
  const usage = report.communicationContext?.usage;
  if (report.run?.type === 'test' || report.profile?.approximation || usage === 'voice-call' || usage === 'voice-message') recs.push(recommendation('LOCAL_TEST_SCOPE',
    'This is a local browser preset. Mobile, desktop and web app codecs and processing can differ; their exact behavior is not reproduced.',
    usage === 'voice-message' ? 'Compare this recording with a short voice message sent through your actual app.'
      : 'Compare playback here with a short call or voice message in your actual app.', { category: 'profile' }));
  return recs;
}

function analyzeSystemSignals(report) {
  const observed = report.system?.correlation?.findings || [];
  const recs = [];
  if (observed.some(f => f.id === 'CPU_LIKELY' || f.id === 'NETWORK_LIKELY')) recs.push(recommendation('TIMING_VARIATION',
    'Browser or transport timing varied during the run. These observations do not identify CPU load or a network fault.',
    'Repeat with fewer busy tabs and compare playback; change one condition at a time.', { category: 'system' }));
  if (observed.some(f => f.id === 'TAB_HIDDEN')) recs.push(recommendation('TAB_HIDDEN',
    'The test tab was hidden during part of the run.',
    'Keep it visible when comparing browser timing. Saved-audio measurements still describe the recorded file.', { category: 'system' }));
  return recs;
}

function analyzeSpectrum(report) {
  const d = report.deepAnalysis;
  if (d?.status !== 'ready') return [];
  const recs = [];
  if (finite(d.bands?.presence) && d.bands.presence < -12) recs.push(recommendation('LOW_TREBLE_ENERGY',
    'This recording has relatively little upper-frequency energy. Voice, processing and speech codecs can all affect this range; it does not lower the result.',
    'No setting change is needed from this observation alone. Compare spoken-word clarity during playback in your app.', { category: 'observation' }));
  if (finite(d.spectralFlatness) && d.spectralFlatness > 0.5) recs.push(recommendation('BROAD_SPECTRUM',
    'Energy is spread broadly across the measured spectrum.',
    'Listen to a quiet section to check whether background sound is audible before changing noise suppression.', { category: 'observation' }));
  return recs;
}

function evaluatePremiumReport(report) {
  const measurementFindings = report?.run?.type !== 'troubleshooting' && sufficient(report) ? analyzeMeasurements(report) : [];
  const guidance = getTroubleshootingGuidance(report, { measurementFindings });
  // A guidance-only run never claims an audio assessment, even if an imported
  // payload accidentally carries metrics from an earlier recording.
  if (report?.run?.type === 'troubleshooting') return {
    metrics: [],
    recommendations: guidance.length ? guidance : [recommendation('GUIDE_UNAVAILABLE',
      'No verified troubleshooting steps are available for this combination of system, app and symptom.',
      'Check that the target system, app and symptom are correct. If they are, continue with the affected app or device vendor\'s support.',
      { category: 'troubleshooting', evidence: 'No audio or system performance was measured for this guidance-only report.' })]
  };
  if (!sufficient(report)) return { metrics: formatDetailedMetrics(report), recommendations: [
    recommendation('INSUFFICIENT_AUDIO', 'There is not enough measured audio to assess this recording.',
      'Record a short spoken sample and try again.'), ...guidance
  ] };
  return {
    metrics: formatDetailedMetrics(report),
    recommendations: [...guidance, ...measurementFindings.filter(finding => !guidance.some(step => step.replaces === finding.id)),
      ...analyzeSystemSignals(report), ...analyzeSpectrum(report)]
  };
}

module.exports = { evaluatePremiumReport, isDetailedReportInput };
