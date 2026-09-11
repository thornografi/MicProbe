// Private premium rules shared by the Node server and the bundled Worker adapter.
const { getTroubleshootingGuidance, inputLevelInstruction } = require('./troubleshooting-guidance.js');
const { getConstraintMismatches, projectCaptureContext, getAppliedConstraints } = require('../js/modules/CaptureContext.js');
const { normalizeEnvironment, OS_NAMES, BROWSER_NAMES } = require('../js/modules/EnvironmentContext.js');
const { usableReport, countsAsCompletedTest } = require('../js/modules/MeasurementValidity.js');
const { assessPlatformExpectations, applyPlatformExpectations, publicPlatformAssessment } = require('./platform-expectations.js');
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
const percent = (value) => finite(value) ? value * 100 : null;
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
  return usableReport(report).valid;
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
    metric('appliedSettings', 'Applied Capture Settings', settingText(getAppliedConstraints(profile)), '',
      getConstraintMismatches(profile).length ? 'fair' : 'info'),
    metric('osInputLevel', 'System Input Level', 'Not visible to the browser'),
    metric('osProcessing', 'Driver / OS Enhancements', 'Not visible to the browser')
  );
  const environment = normalizeEnvironment(report.environment);
  metrics.push(
    metric('captureOs', 'Recording System (Browser Hint)', environment.os === 'unknown' ? null : OS_NAMES[environment.os]),
    metric('captureBrowser', 'Recording Browser (Browser Hint)', environment.browser === 'unknown' ? null
      : `${BROWSER_NAMES[environment.browser]}${environment.browserMajor ? ` ${environment.browserMajor}` : ''}`)
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
      metric('requestedDtx', 'Requested Opus DTX', lb.requestedOpus ? (typeof lb.requestedOpus.dtx === 'boolean' ? (lb.requestedOpus.dtx ? 'On' : 'Off') : 'Browser default') : null),
      metric('requestedFec', 'Requested Opus FEC', lb.requestedOpus ? (typeof lb.requestedOpus.fec === 'boolean' ? (lb.requestedOpus.fec ? 'On' : 'Off') : 'Browser default') : null),
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
  const c = getAppliedConstraints(report.profile);
  const noise = measured(m.noiseFloor, 'estimatedDb');
  const snr = measured(m.snr, 'estimatedDb');
  const recs = [];
  if (noise === null || snr === null) recs.push(recommendation('NOISE_UNMEASURED',
    m.snr?.reason === 'processing-limits-snr-estimate'
      ? 'Recorded quiet and speaking levels are available. Active or unknown browser processing prevents an SNR estimate.'
      : m.guidedNoise ? 'This guided recording did not provide enough usable quiet and speaking data for an SNR estimate.'
        : 'Noise floor and signal-to-noise need separate quiet and speaking segments. Quiet sections alone cannot identify microphone noise.',
    'Other valid findings still apply. Missing SNR alone does not require another recording.', { category: 'observation' }));
  if (noise !== null && noise > QUALITY.NOISE_FLOOR_WARNING_DB) recs.push(recommendation('MEASURED_NOISE',
    'The measured noise segment has a high level.',
    'If background sound is intrusive, reduce nearby noise sources. Noise suppression can also affect speech, so its benefit is not established by this level alone.', { category: 'environment', relatedSetting: 'ns', severity: 'warning' }));
  if (snr !== null && snr < QUALITY.SNR_WARNING_DB) recs.push(recommendation('MEASURED_LOW_SNR',
    'The measured speech and noise segments have little level separation.',
    'Reducing nearby background sound may help preserve speech without increasing input gain.', { category: 'environment', severity: 'warning' }));
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
    'If speech in this recording sounds quiet, check microphone position and the selected input level. The recording alone does not identify the cause.',
    { severity: windowSilent || sustainedSilent ? 'critical' : 'warning',
      basis: windowSilent || windowWeak ? 'loudest-window' : 'integrated-loudness',
      nearSilent: windowSilent || sustainedSilent, evidencePaths: [
        ...(windowSilent || windowWeak ? [m.signal.maxBlockRmsStatus === 'measured' ? 'signal.maxBlockRmsDb' : 'signal.peakDb'] : []),
        ...(sustainedSilent || sustainedWeak ? [finite(m.lufs?.integratedMonoEquivalent) ? 'lufs.integratedMonoEquivalent' : 'lufs.integrated'] : [])] }));
  else if (m.signal.rmsDb < QUALITY.WEAK_SIGNAL_DB) recs.push(recommendation('LOW_AVERAGE_LEVEL',
    'The average level is low. Pauses can lower it, and short loud sounds or another channel can mask quiet speech. Speech level was not assessed.',
    'Judge the spoken parts during playback before changing any setting.', { category: 'observation' }));
  if (m.clipping?.method === 'sample-saturation' && measured(m.clipping, 'rate') > 0) {
    recs.push(recommendation('FULL_SCALE_SAMPLES', 'Some saved samples reach or exceed full scale. This alone does not prove audible distortion.',
      'If speech sounds distorted, reduce one available input-level control or increase speaking distance slightly. Do not increase gain to compensate for quiet sections.', { severity: 'warning' }));
  } else if (pinnedCeiling(m)) {
    recs.push(recommendation('PINNED_CEILING',
      `Many samples cluster near a ceiling of ${finite(m.ceiling.ceilingDb) ? m.ceiling.ceilingDb : m.signal.peakDb} dBFS, with a peak-to-average spread of ${m.signal.crestFactorDb} dB. Clipping or limiting can produce this pattern, but the recording does not identify where it happened or whether it is audible.`,
      'If playback sounds distorted, lower an available input-level control slightly. This pattern does not locate the stage causing the ceiling.',
      { severity: pinnedCeiling(m), relatedSetting: 'input-gain' }));
  } else if (finite(m.headroom?.peakDb) && m.headroom.peakDb >= QUALITY.HEADROOM_INFO_DB) {
    recs.push(recommendation('LOW_HEADROOM', 'Peaks are close to full scale without measured full-scale samples. This does not prove distortion or lower the result.',
      'No setting change is needed from headroom alone; compare playback if you hear distortion.', { category: 'observation' }));
  }
  if (!(measured(m.clipping, 'rate') > 0) && finite(measured(m.truePeak, 'db')) && m.truePeak.db > QUALITY.TRUE_PEAK_WARNING_DBTP) {
    recs.push(recommendation('TRUE_PEAK_OVER',
      `Inter-sample peaks reach ${m.truePeak.db} dBTP, above full scale, although no stored sample is at full scale.`,
      'Playback or re-encoding can clip these peaks. A little more headroom can help; increasing gain would reduce it.', { severity: 'warning' }));
  }
  if (m.channelLayout === 'dual-mono' && m.channelIdentity?.identical === true) recs.push(recommendation('DUAL_MONO',
    `Both channels carry the same signal, so the integrated loudness of ${m.lufs?.integrated} LUFS reads 3 dB above its mono equivalent of ${m.lufs?.integratedMonoEquivalent} LUFS. A single-input interface delivered as a stereo pair usually causes this.`,
    'No change is needed. Compare loudness figures with mono recordings using the mono equivalent.', { category: 'observation' }));
  const mismatches = getConstraintMismatches(report.profile);
  const capabilities = projectCaptureContext(report).captureContext.capabilities;
  const unsupported = mismatches.filter(item => {
    const key = { sampleRate: 'sampleRateRange', channelCount: 'channelCountRange', echoCancellation: 'ecSupported',
      noiseSuppression: 'nsSupported', autoGainControl: 'agcSupported' }[item.key];
    const supported = capabilities[key];
    return Array.isArray(supported) ? !supported.includes(item.requested)
      : supported && (item.requested < supported.min || item.requested > supported.max);
  });
  if (mismatches.length) recs.push(recommendation('SETTINGS_NOT_APPLIED',
    `The device applied ${mismatches.map(item => `${SETTING_LABELS[item.key]} ${String(item.applied)} instead of ${String(item.requested)}`).join(', ')}.${unsupported.length
      ? ` The capture device did not report support for the requested ${unsupported.map(item => SETTING_LABELS[item.key]).join(', ')}.` : ''}`,
    unsupported.length ? 'Use a supported setting or another input device if that format or processing option is required. Changing system input volume cannot enable an unsupported capture setting.'
      : 'Measurements describe the applied settings. Check the device or its system format if the requested value is required; the recording does not establish why it was not applied.',
    { relatedSetting: mismatches[0].key }));
  if (c.autoGainControl === true) recs.push(recommendation('AGC_SYSTEM_LEVEL',
    'Automatic gain control was active, so the recorded level does not show the microphone\'s own level. The browser may also adjust the system input level during such runs.',
    'Check the system input level before comparing with a recording made with processing disabled.', { category: 'observation', relatedSetting: 'agc' }));
  if (m.silence?.totalDurationMs > 0) recs.push(recommendation('LOW_LEVEL_SECTIONS',
    'This recording contains low-level sections. Pauses and audio gaps can both look quiet.',
    '', { category: 'observation' }));
  if (m.coverage?.truncated) recs.push(recommendation('PARTIAL_RECORDING',
    'Only the first part of this recording was analysed.',
    'The unanalysed remainder cannot support additional findings.', { category: 'observation' }));
  const usage = report.communicationContext?.usage;
  if (report.run?.type === 'test' || report.profile?.approximation || usage === 'voice-call' || usage === 'voice-message') recs.push(recommendation('LOCAL_TEST_SCOPE',
    'This is a local browser preset. Mobile, desktop and web app codecs and processing can differ; their exact behavior is not reproduced.',
    '', { category: 'profile' }));
  const peakRisk = recs.some(item => ['FULL_SCALE_SAMPLES', 'PINNED_CEILING', 'TRUE_PEAK_OVER'].includes(item.id));
  for (const item of recs) {
    if (['FULL_SCALE_SAMPLES', 'PINNED_CEILING'].includes(item.id)) item.action = inputLevelInstruction(report, true);
    if (item.id === 'LOW_RECORDED_LEVEL' && !peakRisk && !item.nearSilent) item.action = inputLevelInstruction(report);
    if (item.id === 'LOW_RECORDED_LEVEL' && (peakRisk || item.nearSilent)) item.action = peakRisk
      ? 'Quiet sections coexist with a peak warning. Increasing input gain could worsen the peaks.'
      : 'Speech was not verified in this recording. This low level alone does not establish a microphone fault or justify increasing gain.';
    if (item.category === 'observation') item.action = '';
  }
  return recs;
}

function analyzeSystemSignals(report) {
  const observed = report.system?.correlation?.findings || [];
  const { system } = projectCaptureContext(report);
  const recs = [];
  const legacy = !report.system?.runId;
  if ((system.tabWasHidden !== true && system.mainThreadJitter?.spikeCount > 0)
    || (legacy && observed.some(f => f.id === 'CPU_LIKELY' || f.id === 'NETWORK_LIKELY'))) recs.push(recommendation('TIMING_VARIATION',
    'Browser or transport timing varied during the run. These observations do not identify CPU load or a network fault.',
    '', { category: 'observation' }));
  if (system.tabWasHidden === true || (legacy && observed.some(f => f.id === 'TAB_HIDDEN'))) recs.push(recommendation('TAB_HIDDEN',
    'The recording tab was in the background during part of the run. Scheduling delays during that period are not reliable evidence of CPU load; saved-audio measurements still describe the recorded file.',
    '', { category: 'observation' }));
  if (system.network?.concealedSamples > 0) recs.push(recommendation('LOCAL_CONCEALMENT',
    'The local call test concealed some audio samples. This is an observation of the local browser transport, not the internet connection or audio received in your actual app.',
    '', { category: 'observation' }));
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

function evaluatePremiumReport(report, catalogs) {
  report = usableReport(report).report;
  const platform = assessPlatformExpectations(report, catalogs);
  const measurementFindings = report?.run?.type !== 'troubleshooting' && sufficient(report)
    ? applyPlatformExpectations(analyzeMeasurements(report), platform) : [];
  const guidance = getTroubleshootingGuidance(report, { measurementFindings: measurementFindings.filter(item => item.expectation !== 'within-reference') });
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
    recommendation('INSUFFICIENT_AUDIO', 'There is not enough consistent measured audio to assess this recording.',
      '', { category: 'observation' }), ...guidance
  ] };
  const metricPaths = { maxBlockRms: 'signal.maxBlockRmsDb', lufsIntegrated: 'lufs.integrated', lufsMonoEquivalent: 'lufs.integratedMonoEquivalent',
    crestFactor: 'signal.crestFactorDb', nearCeiling: 'ceiling.nearCeilingRate', clipping: 'clipping.rate', truePeak: 'truePeak.db', noiseFloor: 'noiseFloor.estimatedDb', snr: 'snr.estimatedDb' };
  return {
    platform: publicPlatformAssessment(platform),
    platformAssessment: platform,
    metrics: [...formatDetailedMetrics(report).map(item => platform.comparisons.some(value => value.path === metricPaths[item.key] && value.status === 'within')
      ? { ...item, rating: 'info', expectation: 'within-reference' } : item),
      ...platform.comparisons.map(item => metric(`reference:${item.path}`, `Validated range: ${item.label}`,
        `${item.unit === 'ratio' ? percent(item.min) : item.min} to ${item.unit === 'ratio' ? percent(item.max) : item.max}`, item.unit === 'ratio' ? '%' : item.unit))],
    recommendations: [...guidance, ...measurementFindings.filter(finding => !guidance.some(step => step.replaces === finding.id)),
      ...analyzeSystemSignals(report), ...analyzeSpectrum(report),
      ...(platform.target?.platform ? [recommendation('PLATFORM_EXPECTATION', platform.summary, '', { category: 'observation' })] : [])]
  };
}

module.exports = { evaluatePremiumReport, isDetailedReportInput, hasSufficientAudio: countsAsCompletedTest, analyzeMeasurements };
