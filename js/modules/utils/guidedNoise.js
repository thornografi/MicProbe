import { CAPTURE_GUIDE as GUIDE, QUALITY } from '../constants.js';

/** Separate recorded quiet/speaking windows; never infer them from the quietest samples. */
export function measureGuidedNoise(channels, sampleRate, segments) {
  const unavailable = reason => ({
    noiseFloor: { status: 'unavailable', estimatedDb: null, reason },
    snr: { status: 'unavailable', estimatedDb: null, reason },
    guidedNoise: { status: 'unavailable', reason, method: 'user-guided-file-segments' }
  });
  const durationMs = channels[0].length / sampleRate * 1000;
  if (segments?.version !== 1 || segments.method !== 'user-guided-file-segments' || segments.interrupted) {
    return unavailable('guided-prompts-incomplete');
  }
  const validRange = (range, minimum) => range && Number.isFinite(range.startMs) && Number.isFinite(range.endMs)
    && range.startMs >= 0 && range.endMs <= durationMs && range.endMs - range.startMs >= minimum;
  if (!validRange(segments.quiet, GUIDE.MIN_QUIET_MS) || !validRange(segments.speaking, GUIDE.MIN_SPEAKING_MS)
    || segments.quiet.endMs >= segments.speaking.startMs) return unavailable('guided-segments-too-short');
  const power = range => {
    const start = Math.ceil(range.startMs * sampleRate / 1000), end = Math.floor(range.endMs * sampleRate / 1000);
    const blocks = [], blockSize = Math.round(sampleRate * GUIDE.NOISE_BLOCK_MS / 1000);
    let sum = 0, peak = 0;
    for (let i = start; i < end; i += blockSize) {
      const until = Math.min(end, i + blockSize);
      let blockSum = 0;
      for (const samples of channels) for (let j = i; j < until; j++) {
        blockSum += samples[j] ** 2; peak = Math.max(peak, Math.abs(samples[j]));
      }
      sum += blockSum;
      blocks.push(blockSum / ((until - i) * channels.length));
    }
    return { mean: sum / ((end - start) * channels.length), peak, blocks: blocks.sort((a, b) => a - b) };
  };
  const quiet = power(segments.quiet), speech = power(segments.speaking);
  if (!(quiet.mean > GUIDE.MIN_MEASURABLE_POWER) || !(speech.mean > GUIDE.MIN_MEASURABLE_POWER)) return unavailable('guided-level-below-resolution');
  const toDb = value => +(10 * Math.log10(value)).toFixed(2);
  const spread = toDb(quiet.blocks[Math.floor((quiet.blocks.length - 1) * 0.9)]
    / Math.max(quiet.blocks[Math.floor((quiet.blocks.length - 1) * 0.1)], 1e-18));
  if (spread > GUIDE.MAX_QUIET_SPREAD_DB || quiet.peak >= QUALITY.SAMPLE_SATURATION_THRESHOLD) {
    return unavailable('quiet-segment-not-steady');
  }
  const contrastDb = toDb(speech.mean / quiet.mean);
  if (contrastDb < GUIDE.MIN_SEPARATION_DB) return unavailable('speaking-not-separated-from-quiet');
  const noiseDb = toDb(quiet.mean), signalDb = toDb(speech.mean);
  const processingOff = ['autoGainControl', 'noiseSuppression', 'echoCancellation'].every(key => segments.processing?.[key] === false);
  const snrReason = !processingOff ? 'processing-limits-snr-estimate'
    : speech.peak >= QUALITY.SAMPLE_SATURATION_THRESHOLD ? 'speaking-segment-clipped' : null;
  return {
    noiseFloor: { status: 'measured', estimatedDb: noiseDb, method: 'guided-quiet-segment', scope: 'recorded-output' },
    snr: { status: snrReason ? 'unavailable' : 'measured', estimatedDb: snrReason ? null : toDb((speech.mean - quiet.mean) / quiet.mean),
      signalDb, noiseDb, method: 'guided-power-subtraction', ...(snrReason ? { reason: snrReason } : {}),
      assumption: 'User followed the prompts; background sound and gain stayed constant. Speech is not automatically verified.' },
    guidedNoise: { status: 'measured', method: 'user-guided-file-segments', contrastDb,
      quietDb: noiseDb, speakingDb: signalDb, quiet: segments.quiet, speaking: segments.speaking,
      processing: segments.processing, scope: 'Recorded segment levels, not microphone self-noise or recipient audio.' }
  };
}
