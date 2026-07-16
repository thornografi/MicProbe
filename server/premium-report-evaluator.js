const QUALITY = {
  WEAK_SIGNAL_DB: -45,
  SNR_WARNING_DB: 10,
  NOISE_FLOOR_WARNING_DB: -30,
  CLIPPING_RATE_WARNING: 0.01,
  DROPOUT_COUNT_WARNING: 2,
  STABILITY_GOOD_STDDEV: 6,
  STABILITY_WARNING_STDDEV: 12,
  BITRATE_DEVIATION_WARNING: 0.3,
  DYNAMIC_RANGE_WARNING_DB: 6
};

function metric(key, label, value, unit = '', rating = 'info') {
  return {
    key,
    label,
    value: value ?? null,
    unit,
    rating: value === null || value === undefined ? 'info' : rating
  };
}

function rate(val, good, warn) {
  if (val === null || val === undefined) return 'info';
  return val >= good ? 'good' : val >= warn ? 'fair' : 'poor';
}

function rateReverse(val, good, warn) {
  if (val === null || val === undefined) return 'info';
  return val <= good ? 'good' : val <= warn ? 'fair' : 'poor';
}

function percent(rateValue) {
  return rateValue === null || rateValue === undefined ? null : +(rateValue * 100).toFixed(1);
}

function interpretFrequency(fp) {
  if (!fp) return 'No data';
  const bands = { 'Bass': fp.subBass, 'Low-Mid': fp.lowMid, 'High-Mid': fp.highMid, 'Treble': fp.presence };
  const max = Object.entries(bands).reduce((a, b) => (b[1] ?? 0) > (a[1] ?? 0) ? b : a);
  return `${max[0]} dominant`;
}

function buildBitrateMetrics(report) {
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
    metric('targetBitrate', 'Target Bitrate', requestedKbps, 'kbps', 'info'),
    metric('actualBitrate', 'Actual Bitrate', actualKbps, 'kbps', 'info'),
    metric(
      'bitrateDeviation',
      'Bitrate Drift',
      deviationPct,
      '%',
      rateReverse(Math.abs(source.bitrateDeviation ?? 0), 0.1, QUALITY.BITRATE_DEVIATION_WARNING)
    )
  ];
}

function buildLoopbackMetrics(report) {
  const lb = report.loopback;
  if (!lb) return [];

  return [
    metric('rtt', 'Loopback RTT', lb.rttMs, 'ms', rateReverse(lb.rttMs, 80, 150)),
    metric('jitter', 'Jitter', lb.jitterMs, 'ms', rateReverse(lb.jitterMs, 20, 40)),
    metric('packetLoss', 'Packet Loss', percent(lb.packetLossRate), '%', rateReverse(lb.packetLossRate, 0.005, 0.02)),
    metric('dtx', 'DTX State', lb.isDtxActive === null || lb.isDtxActive === undefined ? null : (lb.isDtxActive ? 'Active' : 'Inactive'), '', 'info')
  ];
}

function formatDetailedMetrics(report) {
  const m = report.audioMetrics;
  if (!m) return null;

  const sourceLabel = m.source === 'remote-loopback' ? 'Post-codec loopback' : 'Mic pipeline';
  const lufs = m.lufs || {};
  const frequencyResponse = m.frequencyResponse || {};

  return [
    metric('source', 'Measured Source', sourceLabel, '', 'info'),
    metric('snr', 'Signal/Noise', m.snr?.estimatedDb, 'dB', rate(m.snr?.estimatedDb, 20, QUALITY.SNR_WARNING_DB)),
    metric('noiseFloor', 'Noise Floor', m.noiseFloor?.estimatedDb, 'dBFS', rateReverse(m.noiseFloor?.estimatedDb, -45, QUALITY.NOISE_FLOOR_WARNING_DB)),
    metric('dynamicRange', 'Dynamic Range', m.dynamicRange?.db, 'dB', rate(m.dynamicRange?.db, 20, QUALITY.DYNAMIC_RANGE_WARNING_DB)),
    metric('clipping', 'Clipping', percent(m.clipping?.rate), '%', rateReverse(m.clipping?.rate, QUALITY.CLIPPING_RATE_WARNING, 0.05)),
    metric('clippingEvents', 'Clipping Events', m.clipping?.eventCount, 'events', rateReverse(m.clipping?.eventCount, 0, 2)),
    metric('dropouts', 'Audio Dropouts', m.dropouts?.count, 'count', rateReverse(m.dropouts?.count, 0, QUALITY.DROPOUT_COUNT_WARNING)),
    metric('dropoutDuration', 'Dropout Time', m.dropouts?.totalDurationMs, 'ms', rateReverse(m.dropouts?.totalDurationMs, 0, 500)),
    metric('stability', 'Stability', m.stability?.dbStdDev, 'dB', rateReverse(m.stability?.dbStdDev, QUALITY.STABILITY_GOOD_STDDEV, QUALITY.STABILITY_WARNING_STDDEV)),
    metric('weakSignal', 'Weak Signal', percent(m.weakSignal?.rate), '%', rateReverse(m.weakSignal?.rate, 0.05, 0.2)),
    metric('lufsIntegrated', 'Integrated LUFS', lufs.integrated, 'LUFS', 'info'),
    metric('lufsShortTerm', 'Short-term LUFS', lufs.shortTerm, 'LUFS', 'info'),
    metric('frequency', 'Frequency Profile', interpretFrequency(m.frequencyProfile), '', 'info'),
    metric('frequencyBins', 'Frequency Detail', frequencyResponse.bins?.length, 'bins', 'info'),
    metric('frequencyResolution', 'Freq Resolution', frequencyResponse.binWidth, 'Hz/bin', 'info'),
    ...buildBitrateMetrics(report),
    ...buildLoopbackMetrics(report)
  ];
}

function analyzeConstraintCorrelation(report) {
  const recs = [];
  const c = report.profile?.constraints;
  const m = report.audioMetrics;
  if (!c || !m) return recs;

  if (c.noiseSuppression === false && (m.noiseFloor?.estimatedDb ?? -60) > QUALITY.NOISE_FLOOR_WARNING_DB) {
    recs.push({ id: 'NS_OFF_NOISY', type: 'constraint', message: 'Noise Suppression is off and background noise is high. Try enabling NS.' });
  }
  if (c.noiseSuppression === true && (m.noiseFloor?.estimatedDb ?? -60) > QUALITY.NOISE_FLOOR_WARNING_DB) {
    recs.push({ id: 'NS_ON_STILL_NOISY', type: 'constraint', message: 'NS is on but noise is still high. Physical sound isolation may be needed.' });
  }
  if (c.autoGainControl === false && (m.snr?.signalDb ?? 0) < QUALITY.WEAK_SIGNAL_DB) {
    recs.push({ id: 'AGC_OFF_WEAK', type: 'constraint', message: 'Auto Gain Control is off and signal is weak. Try enabling AGC.' });
  }
  if (c.autoGainControl === true && (m.clipping?.rate ?? 0) > QUALITY.CLIPPING_RATE_WARNING) {
    recs.push({ id: 'AGC_ON_CLIPPING', type: 'constraint', message: 'AGC is on but clipping is occurring. Your mic input may be physically too loud.' });
  }
  if (c.echoCancellation === false && report.profile?.loopback) {
    recs.push({ id: 'EC_OFF_LOOPBACK', type: 'constraint', message: 'Echo Cancellation is off. You may hear echo if using speakers.' });
  }
  if (report.profile?.pipeline === 'scriptprocessor' && (m.dropouts?.count ?? 0) > 0) {
    recs.push({ id: 'SP_DROPOUT', type: 'constraint', message: 'ScriptProcessor pipeline is prone to audio dropouts. Try the Worklet pipeline.' });
  }

  return recs;
}

function hasCoreFindings(report) {
  const m = report.audioMetrics;
  if (!m) return false;
  return (m.snr?.signalDb ?? 0) < QUALITY.WEAK_SIGNAL_DB
    || (m.noiseFloor?.estimatedDb ?? -60) > QUALITY.NOISE_FLOOR_WARNING_DB
    || (m.snr?.estimatedDb ?? 0) < QUALITY.SNR_WARNING_DB
    || (m.clipping?.rate ?? 0) > QUALITY.CLIPPING_RATE_WARNING
    || (m.dropouts?.count ?? 0) >= QUALITY.DROPOUT_COUNT_WARNING
    || ((report.run?.type === 'test' ? report.loopback?.bitrateDeviation : report.recording?.bitrateDeviation) ?? 0) < -QUALITY.BITRATE_DEVIATION_WARNING;
}

function analyzeProfileSpecific(report) {
  const recs = [];
  const pid = report.profile?.id;
  const m = report.audioMetrics;
  if (!pid || !m) return recs;

  switch (pid) {
    case 'discord':
      if ((m.clipping?.rate ?? 0) > QUALITY.CLIPPING_RATE_WARNING) {
        recs.push({ id: 'DISCORD_KRISP', type: 'profile', message: 'Discord-style noise processing can make clipping more obvious. Lower mic gain first, then compare with Krisp/noise suppression off in Discord.' });
      }
      if ((m.snr?.estimatedDb ?? 0) < QUALITY.SNR_WARNING_DB) {
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
      if ((m.noiseFloor?.estimatedDb ?? -60) > QUALITY.NOISE_FLOOR_WARNING_DB) {
        recs.push({ id: 'HIFI_NOISE', type: 'profile', message: 'High Fidelity mode preserves more room noise because processing is reduced. Improve the room or mic placement before using this mode.' });
      }
      if ((m.clipping?.rate ?? 0) > QUALITY.CLIPPING_RATE_WARNING) {
        recs.push({ id: 'HIFI_CLIPPING', type: 'profile', message: 'High Fidelity mode preserves clipping instead of hiding it. Reduce input gain before comparing stereo or higher bitrate.' });
      }
      break;
    case 'whatsapp-telegram-call':
      recs.push({ id: 'WHATSAPP_TELEGRAM_CALL_COMPRESSION', type: 'profile', message: 'WhatsApp and Telegram calls compress voice harder than normal meeting calls. If speech sounds smeared here but fine in Meeting Call, your mic is probably fine; the app call is the weak point.' });
      break;
    case 'whatsapp-voice':
      if ((m.noiseFloor?.estimatedDb ?? -60) > QUALITY.NOISE_FLOOR_WARNING_DB) {
        recs.push({ id: 'WA_VOICE_NOISE', type: 'profile', message: 'Low-bitrate voice messages expose background noise quickly. Record in a quiet environment or move closer to the mic.' });
      }
      break;
    case 'telegram-voice':
      if (report.profile?.bitrate === 0) {
        recs.push({ id: 'TG_VBR_VALID', type: 'profile', message: 'VBR is valid for Opus voice messages. Use a fixed bitrate only when you need repeatable A/B comparison.' });
      }
      break;
    case 'raw':
      if (!hasCoreFindings(report)) {
        recs.push({ id: 'RAW_CLEAN', type: 'profile', message: 'Raw recording is clean. Issue may come from codec, processing, or call behavior - test another profile.' });
      }
      break;
  }

  return recs;
}

// Sistem/performans sinyalleri -> aksiyona donuk oneri (report.system, dolayli proxy)
function analyzeSystemSignals(report) {
  const recs = [];
  const sys = report.system;
  if (!sys || !sys.correlation) return recs;
  const actionById = {
    CPU_LIKELY: 'Close background apps / heavy browser tabs and run the test again.',
    NETWORK_LIKELY: 'Encode/transport jitter detected; try the Worklet pipeline or a lower bitrate.',
    TAB_HIDDEN: 'Keep this tab focused and visible during the test for reliable results.'
  };
  for (const f of sys.correlation.findings || []) {
    if (f.id === 'INCONCLUSIVE') continue;
    recs.push({
      id: 'SYS_' + f.id,
      category: 'system',
      severity: f.confidence === 'medium' ? 'warning' : 'info',
      confidence: f.confidence || 'low',
      reason: f.message,
      action: actionById[f.id] || 'Review system load and connection, then retest.',
      relatedSetting: null,
      message: f.message
    });
  }
  return recs;
}

// Ayar-imzasi teshisi -> "neden + ne yapmali" (report.deepAnalysis, offline spektral pass)
function analyzeSettingSignatures(report) {
  const recs = [];
  const d = report.deepAnalysis;
  if (!d || d.status !== 'ready') return recs;
  const bands = d.bands || {};
  const c = report.profile?.constraints || {};

  // Dar bant mikrofon: presence (tiz) belirgin dusuk
  if (typeof bands.presence === 'number' && bands.presence < -12) {
    recs.push({
      id: 'MIC_NARROWBAND', category: 'microphone', severity: 'warning', confidence: 'medium',
      reason: `High-frequency (presence) energy is ${bands.presence} dB below the spectrum average — the mic captures little treble.`,
      action: 'Likely an older / low-quality mic. A better mic or closer placement will noticeably improve clarity.',
      relatedSetting: null
    });
  }
  // Yuksek self-noise / noise floor
  if (typeof d.noiseFloorDb === 'number' && d.noiseFloorDb > -45) {
    recs.push({
      id: 'MIC_SELF_NOISE', category: 'microphone', severity: 'warning', confidence: 'low',
      reason: `Measured noise floor is high (${d.noiseFloorDb} dBFS).`,
      action: c.noiseSuppression === false
        ? 'Enable Noise Suppression, or reduce ambient noise / mic gain.'
        : 'Reduce ambient noise or move the mic away from noise sources.',
      relatedSetting: 'ns'
    });
  }
  // Genis-bant hiss (yuksek spektral duzluk)
  if (typeof d.spectralFlatness === 'number' && d.spectralFlatness > 0.5) {
    recs.push({
      id: 'BROADBAND_NOISE', category: 'environment', severity: 'warning', confidence: 'low',
      reason: `Spectrum is very flat (flatness ${d.spectralFlatness}), typical of broadband hiss (fans, AC, electrical).`,
      action: 'Reduce steady background noise sources or enable noise suppression.',
      relatedSetting: 'ns'
    });
  }
  // Gain cok yuksek (tepe clipping'e cok yakin)
  if (typeof d.peakDb === 'number' && d.peakDb > -1) {
    recs.push({
      id: 'GAIN_TOO_HIGH', category: 'setting', severity: 'warning', confidence: 'medium',
      reason: `Peak level is ${d.peakDb} dBFS — very close to clipping.`,
      action: 'Lower microphone input gain to leave headroom and avoid distortion.',
      relatedSetting: 'agc'
    });
  } else if (typeof d.rmsDb === 'number' && d.rmsDb < -40) {
    // Gain cok dusuk
    recs.push({
      id: 'GAIN_TOO_LOW', category: 'setting', severity: 'warning', confidence: 'medium',
      reason: `Average level is low (${d.rmsDb} dBFS).`,
      action: 'Increase mic gain or speak closer; consider enabling Auto Gain Control.',
      relatedSetting: 'agc'
    });
  }
  return recs;
}

// === OCP: Kural gruplari registry'i ===
const RULE_GROUPS = [
  analyzeConstraintCorrelation,   // mevcut (ayar korelasyonu)
  analyzeProfileSpecific,         // mevcut (profil-ozel)
  analyzeSystemSignals,           // YENI (sistem/perf)
  analyzeSettingSignatures        // YENI (ayar-imzasi / mikrofon / ortam)
];

const SEVERITY_WEIGHT = { critical: 3, warning: 2, info: 1 };
const CONFIDENCE_WEIGHT = { high: 3, medium: 2, low: 1 };

function normalizeRec(r) {
  const category = r.category
    || (r.type === 'profile' ? 'profile' : 'setting'); // mevcut constraint/profile recs geriye uyum
  const severity = r.severity || 'info';
  const confidence = r.confidence || 'medium';
  return {
    id: r.id,
    category,
    severity,
    confidence,
    reason: r.reason || r.message || '',
    action: r.action || null,
    relatedSetting: r.relatedSetting ?? null,
    message: r.message || r.reason || ''   // geriye uyum: eski render r.message okuyor
  };
}

function evaluatePremiumReport(report) {
  const recommendations = RULE_GROUPS
    .flatMap(fn => { try { return fn(report) || []; } catch { return []; } })
    .map(normalizeRec)
    .map(r => ({ ...r, priority: (SEVERITY_WEIGHT[r.severity] || 1) * 10 + (CONFIDENCE_WEIGHT[r.confidence] || 1) }))
    .sort((a, b) => b.priority - a.priority);

  return {
    metrics: formatDetailedMetrics(report),
    recommendations
  };
}

module.exports = { evaluatePremiumReport };
