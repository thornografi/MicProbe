import { QUALITY, VU_METER } from '../constants.js';
import { LUFSCalculator } from './lufs.js';
import { measureGuidedNoise } from './guidedNoise.js';

// A finite display floor represents digital silence; it is not a noise estimate.
const db = power => +Math.max(-180, 10 * Math.log10(Math.max(power, 1e-18))).toFixed(2);
const level = value => +(Math.max(0, Math.min(100, (value - VU_METER.MIN_DB) / -VU_METER.MIN_DB * 100))).toFixed(1);

// ITU-R BS.1770-4 Annex 2, Table 2: 4x over-sampling polyphase FIR (12 taps per phase).
const TRUE_PEAK_PHASES = [
  [0.0017089843750, 0.0109863281250, -0.0196533203125, 0.0332031250000, -0.0594482421875, 0.1373291015625,
    0.9721679687500, -0.1022949218750, 0.0476074218750, -0.0266113281250, 0.0148925781250, -0.0083007812500],
  [-0.0291748046875, 0.0292968750000, -0.0517578125000, 0.0891113281250, -0.1665039062500, 0.4650878906250,
    0.7797851562500, -0.2003173828125, 0.1015625000000, -0.0582275390625, 0.0330810546875, -0.0189208984375],
  [-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625000000, -0.2003173828125, 0.7797851562500,
    0.4650878906250, -0.1665039062500, 0.0891113281250, -0.0517578125000, 0.0292968750000, -0.0291748046875],
  [-0.0083007812500, 0.0148925781250, -0.0266113281250, 0.0476074218750, -0.1022949218750, 0.9721679687500,
    0.1373291015625, -0.0594482421875, 0.0332031250000, -0.0196533203125, 0.0109863281250, 0.0017089843750]
];

/** True peak from the largest inter-sample estimate. Only the maximum is kept, so filter delay does not matter. */
export function measureTruePeak(channels, sampleRate, samplePeak) {
  // 4x up to 96 kHz, 2x (phases 0 and 2) up to 192 kHz, sample peak above that.
  const phases = sampleRate < 96000 ? TRUE_PEAK_PHASES : sampleRate < 192000 ? [TRUE_PEAK_PHASES[0], TRUE_PEAK_PHASES[2]] : null;
  if (!phases) return { status: 'measured', db: db(samplePeak * samplePeak), oversampling: 1, method: 'sample-peak' };
  let max = 0;
  for (const samples of channels) {
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      for (const taps of phases) {
        let acc = 0;
        for (let k = 0, j = i; k < 12 && j >= 0; k++, j--) acc += taps[k] * samples[j];
        const abs = Math.abs(acc);
        if (abs > max) max = abs;
      }
    }
  }
  return { status: 'measured', db: db(Math.max(max, samplePeak) ** 2), oversampling: phases.length,
    method: 'ITU-R-BS.1770-4-annex-2' };
}

/** Measurements from every decoded sample. No signal/noise or hardware diagnosis. */
export function analyzePcm(channels, sampleRate, { guidedSegments = null } = {}) {
  const frameCount = channels[0]?.length || 0;
  if (!channels.length || !frameCount || !Number.isFinite(sampleRate) || sampleRate < 8000
    || channels.some(channel => channel.length !== frameCount)) throw new Error('Invalid PCM buffers');
  const blockSize = Math.max(1, Math.round(sampleRate * QUALITY.PCM_BLOCK_MS / 1000));
  const nearPeak = 10 ** (VU_METER.CLIPPING_THRESHOLD_DB / 20);
  const channelMetrics = channels.map(() => ({ peak: 0, sumSq: 0, saturatedSamples: 0 }));
  const frameLevels = [];
  const windowPowers = new Float64Array(blockSize);
  const hasFullWindow = frameCount >= blockSize;
  let windowSum = 0, maxWindowSum = 0;
  let totalSq = 0, peak = 0, saturatedSamples = 0, nearPeakSamples = 0;
  let saturatedEvents = 0, previousSaturated = false;
  let silenceFrames = 0, silenceEvents = 0, previousSilent = false, weakFrames = 0;
  for (let start = 0; start < frameCount; start += blockSize) {
    const end = Math.min(frameCount, start + blockSize);
    let blockSq = 0;
    for (let i = start; i < end; i++) {
      let saturatedFrame = false;
      let frameSq = 0;
      for (let ch = 0; ch < channels.length; ch++) {
        const sample = channels[ch][i];
        if (!Number.isFinite(sample)) throw new Error('Non-finite PCM sample');
        const abs = Math.abs(sample), square = sample * sample;
        const metric = channelMetrics[ch];
        metric.peak = Math.max(metric.peak, abs); metric.sumSq += square;
        peak = Math.max(peak, abs); totalSq += square; blockSq += square; frameSq += square;
        if (abs >= nearPeak) nearPeakSamples++;
        if (abs >= QUALITY.SAMPLE_SATURATION_THRESHOLD) {
          metric.saturatedSamples++; saturatedSamples++; saturatedFrame = true;
        }
      }
      // Test every complete window. Non-overlapping blocks can split a transient,
      // and treating the final partial block as 10 ms exaggerates its level.
      const slot = i % blockSize;
      windowSum += frameSq - windowPowers[slot];
      windowPowers[slot] = frameSq;
      if (i + 1 >= blockSize) maxWindowSum = Math.max(maxWindowSum, windowSum);
      if (saturatedFrame && !previousSaturated) saturatedEvents++;
      previousSaturated = saturatedFrame;
    }
    const blockDb = db(blockSq / ((end - start) * channels.length));
    frameLevels.push(blockDb);
    const silent = blockDb < QUALITY.SILENCE_DB;
    if (silent) {
      silenceFrames += end - start;
      if (!previousSilent) silenceEvents++;
    }
    if (blockDb < QUALITY.WEAK_SIGNAL_DB) weakFrames += end - start;
    previousSilent = silent;
  }
  // Second pass: how much of the file sits at its own ceiling, and whether the
  // channels carry the same signal. A stereo pair from a single-input interface
  // arrives as two identical channels; loudness then reads 3.01 LU above mono.
  // The ceiling is a high percentile of |x|, not the maximum: resampling or codec
  // overshoot adds a few spikes above a clipped plateau without moving the plateau.
  const histogram = new Uint32Array(4096);
  let maxChannelDiff = 0;
  for (let i = 0; i < frameCount; i++) {
    const first = channels[0][i];
    for (let ch = 0; ch < channels.length; ch++) {
      const sample = channels[ch][i];
      if (peak > 0) histogram[Math.min(4095, Math.floor(Math.abs(sample) / peak * 4095))]++;
      if (ch > 0) maxChannelDiff = Math.max(maxChannelDiff, Math.abs(sample - first));
    }
  }
  const totalSamples = frameCount * channels.length;
  let ceiling = peak, cumulative = 0;
  for (let bin = 0; bin < histogram.length && peak > 0; bin++) {
    cumulative += histogram[bin];
    if (cumulative >= totalSamples * QUALITY.CEILING_PERCENTILE / 100) { ceiling = (bin + 1) / 4095 * peak; break; }
  }
  const ceilingLevel = ceiling * 10 ** (-QUALITY.CEILING_WINDOW_DB / 20);
  const flatStep = peak * 10 ** (QUALITY.FLAT_STEP_DB / 20);
  let ceilingSamples = 0, flatSamples = 0;
  for (let ch = 0; ch < channels.length && peak > 0; ch++) {
    const samples = channels[ch];
    for (let i = 0; i < frameCount; i++) {
      if (Math.abs(samples[i]) < ceilingLevel) continue;
      ceilingSamples++;
      // A natural peak is an arc; an unresampled pinned waveform repeats the same value.
      if (i > 0 && Math.abs(samples[i] - samples[i - 1]) <= flatStep) flatSamples++;
    }
  }
  const identicalChannels = channels.length > 1 && peak > 0
    && maxChannelDiff <= peak * 10 ** (QUALITY.DUAL_MONO_MAX_DIFF_DB / 20);
  const channelLayout = channels.length === 1 ? 'mono' : identicalChannels ? 'dual-mono'
    : channels.length === 2 ? 'stereo' : 'multichannel';
  const sorted = [...frameLevels].sort((a, b) => a - b);
  const percentile = value => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * value / 100))];
  const p10 = percentile(QUALITY.LEVEL_PERCENTILE), p90 = percentile(100 - QUALITY.LEVEL_PERCENTILE);
  const meanDb = frameLevels.reduce((sum, value) => sum + value, 0) / frameLevels.length;
  const variance = frameLevels.reduce((sum, value) => sum + (value - meanDb) ** 2, 0) / frameLevels.length;
  const rmsDb = db(totalSq / totalSamples), peakDb = db(peak * peak);
  let lufs = { status: 'unavailable', integrated: null, momentary: null, shortTerm: null, reason: 'channel-layout-required' };
  if (channels.length <= 2) {
    const calculator = new LUFSCalculator(sampleRate, channels.length);
    calculator.process(channels);
    lufs = calculator.getResults();
  }
  // Mono equivalent: what the same signal reads as a single channel. Distinct
  // stereo content has no derivable mono figure without a downmix.
  const monoEquivalent = !Number.isFinite(lufs.integrated) ? null
    : channelLayout === 'mono' ? lufs.integrated
      : channelLayout === 'dual-mono' ? +(lufs.integrated - 3.01).toFixed(2) : null;
  lufs = { ...lufs, channelLayout, integratedMonoEquivalent: monoEquivalent,
    monoEquivalentBasis: channelLayout === 'mono' ? 'single-channel'
      : channelLayout === 'dual-mono' ? 'identical-channels-minus-3.01-lu' : 'distinct-channels' };
  const truePeak = measureTruePeak(channels, sampleRate, peak);
  return {
    status: 'measured', source: 'decoded-file-pcm', sampleCount: frameCount,
    sampleRate, durationMs: +(frameCount / sampleRate * 1000).toFixed(2),
    channels: channelMetrics.map(metric => ({ peakDb: db(metric.peak ** 2), rmsDb: db(metric.sumSq / frameCount),
      saturatedSamples: metric.saturatedSamples })),
    // The maximum always uses a complete fixed-duration window with a one-sample
    // hop. It measures recorded power, not speech, noise, or intelligibility.
    signal: { status: 'measured', rmsDb, peakDb,
      maxBlockRmsDb: hasFullWindow ? db(maxWindowSum / (blockSize * channels.length)) : null,
      maxBlockRmsStatus: hasFullWindow ? 'measured' : 'unavailable',
      maxBlockRmsWindowMs: blockSize / sampleRate * 1000,
      ...(!hasFullWindow ? { maxBlockRmsReason: 'too-short' } : {}),
      crestFactorDb: +(peakDb - rmsDb).toFixed(2),
      method: 'per-channel-pcm-power-average' },
    truePeak,
    // Samples sitting flat at the file's own peak. Speech is rarely at its peak and a
    // tone's peak is an arc; a pinned waveform was limited before it reached the browser.
    ceiling: { status: peak > 0 ? 'measured' : 'unavailable', peakDb, ceilingDb: db(ceiling * ceiling),
      percentile: QUALITY.CEILING_PERCENTILE, nearCeilingRate: ceilingSamples / totalSamples,
      flatTopRate: flatSamples / totalSamples, windowDb: QUALITY.CEILING_WINDOW_DB, flatStepDb: QUALITY.FLAT_STEP_DB,
      method: 'samples-within-window-of-percentile-ceiling' },
    channelLayout,
    channelIdentity: { identical: identicalChannels, maxDifferenceDb: channels.length > 1 && peak > 0
      ? db((Math.max(maxChannelDiff, 1e-9) / peak) ** 2) : null, method: 'sample-difference-relative-to-peak' },
    level: { average: level(rmsDb), peak: level(peakDb), min: level(sorted[0]) },
    noiseFloor: { status: 'unavailable', estimatedDb: null, reason: 'controlled-noise-segment-required' },
    snr: { status: 'unavailable', estimatedDb: null, signalDb: rmsDb, noiseDb: null,
      reason: 'controlled-noise-and-speech-segments-required' },
    lowLevel: { status: 'measured', percentileDb: p10, percentile: QUALITY.LEVEL_PERCENTILE,
      method: '10ms-rms-percentile' },
    dynamicRange: { status: 'measured', db: +(p90 - p10).toFixed(2), method: 'rms-percentile-spread' },
    clipping: { status: 'measured', rate: saturatedSamples / totalSamples, eventCount: saturatedEvents,
      totalSamples, saturatedSamples, method: 'sample-saturation', truePeak: false,
      threshold: QUALITY.SAMPLE_SATURATION_THRESHOLD },
    headroom: { status: 'measured', peakDb, db: -peakDb, nearPeakRate: nearPeakSamples / totalSamples,
      thresholdDb: VU_METER.CLIPPING_THRESHOLD_DB, method: 'sample-peak' },
    dropouts: { status: 'unavailable', count: null, totalDurationMs: null,
      reason: 'pcm-silence-does-not-prove-sample-loss' },
    silence: { status: 'measured', thresholdDb: QUALITY.SILENCE_DB, count: silenceEvents,
      totalDurationMs: +(silenceFrames / sampleRate * 1000).toFixed(2), method: '10ms-rms-below-threshold' },
    stability: { status: 'measured', dbStdDev: +Math.sqrt(variance).toFixed(2), method: '10ms-rms-variation' },
    lufs, weakSignal: { frames: weakFrames, rate: weakFrames / frameCount },
    frequencyResponse: null, frequencyProfile: null,
    ...(guidedSegments ? measureGuidedNoise(channels, sampleRate, guidedSegments) : {})
  };
}
