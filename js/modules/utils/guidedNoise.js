import { CAPTURE_GUIDE as GUIDE, QUALITY } from '../constants.js';

export function getGuidedSegmentIssue(segments, durationMs) {
  if (segments?.version !== 1 || segments.method !== 'user-guided-file-segments' || segments.interrupted) {
    return 'guided-prompts-incomplete';
  }
  const validRange = (range, minimum) => range && Number.isFinite(range.startMs) && Number.isFinite(range.endMs)
    && range.startMs >= 0 && range.endMs <= durationMs && range.endMs - range.startMs >= minimum;
  return !validRange(segments.quiet, GUIDE.MIN_QUIET_MS) || !validRange(segments.speaking, GUIDE.MIN_SPEAKING_MS)
    || segments.quiet.endMs >= segments.speaking.startMs ? 'guided-segments-too-short' : null;
}

const toDb = power => +(10 * Math.log10(Math.max(power, GUIDE.MIN_MEASURABLE_POWER))).toFixed(2);
const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];

function summarize(blocks) {
  const durationMs = blocks.reduce((sum, b) => sum + b.endMs - b.startMs, 0);
  const mean = blocks.reduce((sum, b) => sum + b.mean * (b.endMs - b.startMs), 0) / durationMs;
  const powers = blocks.map(b => b.mean);
  return { blocks, durationMs, mean, median: quantile(powers, 0.5), peak: Math.max(...blocks.map(b => b.peak)),
    spreadDb: Math.max(0, toDb(quantile(powers, 0.9) / Math.max(quantile(powers, 0.1), GUIDE.MIN_MEASURABLE_POWER))) };
}

function voiceDuration(activity, range, strict = false) {
  if (!activity) return 0;
  let duration = 0, run = 0;
  const flush = () => { if (!strict || run >= GUIDE.MIN_VOICE_RUN_MS) duration += run; run = 0; };
  for (let i = Math.floor(range.startMs / activity.frameMs); i < Math.ceil(range.endMs / activity.frameMs); i++) {
    const length = Math.min(range.endMs, (i + 1) * activity.frameMs) - Math.max(range.startMs, i * activity.frameMs);
    if (activity.frames[i] & (strict ? 2 : 3)) run += length;
    else flush();
  }
  flush();
  return Math.round(duration);
}

/** Keep prompts as the measurement boundary. VAD is fallible supporting evidence,
 * not transcription, speaker identity, or permission to cherry-pick speech pauses. */
export function measureGuidedNoise(channels, sampleRate, segments, activity = null) {
  const unavailable = reason => ({
    noiseFloor: { status: 'unavailable', estimatedDb: null, reason },
    snr: { status: 'unavailable', estimatedDb: null, reason },
    guidedNoise: { status: 'unavailable', reason, method: 'user-guided-file-segments' }
  });
  const durationMs = channels[0].length / sampleRate * 1000;
  const issue = getGuidedSegmentIssue(segments, durationMs);
  if (issue) return unavailable(issue);
  if (activity?.status !== 'measured' || activity.frameMs !== GUIDE.VAD_FRAME_MS
    || activity.frames?.length !== Math.floor(durationMs / GUIDE.VAD_FRAME_MS)
    || !activity.frames.every(value => Number.isInteger(value) && value >= 0 && value <= 3)) activity = null;
  const power = range => {
    const start = Math.ceil(range.startMs * sampleRate / 1000), end = Math.floor(range.endMs * sampleRate / 1000);
    const blocks = [], blockSize = Math.round(sampleRate * GUIDE.NOISE_BLOCK_MS / 1000);
    for (let i = start; i < end; i += blockSize) {
      const until = Math.min(end, i + blockSize);
      let blockSum = 0, peak = 0;
      for (const samples of channels) for (let j = i; j < until; j++) {
        blockSum += samples[j] ** 2; peak = Math.max(peak, Math.abs(samples[j]));
      }
      const block = { startMs: i / sampleRate * 1000, endMs: until / sampleRate * 1000,
        mean: blockSum / ((until - i) * channels.length), peak };
      block.voiceMs = voiceDuration(activity, block);
      blocks.push(block);
    }
    return summarize(blocks);
  };
  const fullQuiet = power(segments.quiet), speech = power(segments.speaking);
  const stable = value => value.mean > GUIDE.MIN_MEASURABLE_POWER
    && value.spreadDb <= GUIDE.MAX_QUIET_SPREAD_DB && value.peak < QUALITY.SAMPLE_SATURATION_THRESHOLD
    && value.blocks.every(block => !block.voiceMs && block.mean > GUIDE.MIN_MEASURABLE_POWER
      && (!activity || block.mean <= value.median * 10 ** (GUIDE.MAX_QUIET_SPREAD_DB / 10)));
  let quiet = fullQuiet;
  // Recover only a single short interruption with a substantial contiguous
  // remainder. Never select the quietest window from continuously varying noise.
  if (activity && !stable(fullQuiet)) {
    const limit = fullQuiet.median * 10 ** (GUIDE.MAX_QUIET_SPREAD_DB / 10);
    const runs = []; let run = [], excludedMs = 0, interruptions = 0, previousBad = false;
    for (const block of fullQuiet.blocks) {
      const bad = block.voiceMs > 0 || block.peak >= QUALITY.SAMPLE_SATURATION_THRESHOLD || block.mean > limit;
      if (bad) {
        excludedMs += block.endMs - block.startMs;
        if (!previousBad) interruptions++;
        if (run.length) runs.push(run);
        run = [];
      } else run.push(block);
      previousBad = bad;
    }
    if (run.length) runs.push(run);
    if (interruptions === 1 && excludedMs <= GUIDE.MAX_QUIET_EXCLUSION_MS + 0.01
      && excludedMs <= fullQuiet.durationMs * GUIDE.MAX_QUIET_EXCLUSION_FRACTION + 0.01) {
      // Longest first; time order breaks ties, never amplitude.
      const candidate = runs.map(summarize).sort((a, b) => b.durationMs - a.durationMs)[0];
      if (candidate?.durationMs >= GUIDE.MIN_QUIET_MS - 0.01 && stable(candidate)) quiet = candidate;
    }
  }
  const quietReason = fullQuiet.mean <= GUIDE.MIN_MEASURABLE_POWER ? 'quiet-below-resolution'
    : !stable(quiet) ? (quiet.blocks.some(block => block.voiceMs) && fullQuiet.spreadDb <= GUIDE.MAX_QUIET_SPREAD_DB
      && quiet.blocks.every(block => block.mean > GUIDE.MIN_MEASURABLE_POWER)
      && fullQuiet.peak < QUALITY.SAMPLE_SATURATION_THRESHOLD ? 'quiet-contains-possible-speech' : 'quiet-segment-not-steady') : null;
  const detectedSpeechMs = voiceDuration(activity, segments.speaking, true);
  const speechReason = speech.mean <= GUIDE.MIN_MEASURABLE_POWER ? 'speaking-below-resolution'
    : activity && detectedSpeechMs < GUIDE.MIN_DETECTED_VOICE_MS ? 'speech-not-confidently-detected' : null;
  const contrast = quiet.mean > GUIDE.MIN_MEASURABLE_POWER && speech.mean > GUIDE.MIN_MEASURABLE_POWER
    ? toDb(speech.mean / quiet.mean) : null;
  const comparisonReason = quietReason || speechReason || (contrast < GUIDE.MIN_SEPARATION_DB ? 'speaking-not-separated-from-quiet' : null);
  const noiseDb = quietReason ? null : toDb(quiet.mean), signalDb = speech.mean > GUIDE.MIN_MEASURABLE_POWER ? toDb(speech.mean) : null;
  const processingOff = ['autoGainControl', 'noiseSuppression', 'echoCancellation'].every(key => segments.processing?.[key] === false);
  const snrReason = comparisonReason || (!processingOff ? 'processing-limits-snr-estimate'
    : speech.peak >= QUALITY.SAMPLE_SATURATION_THRESHOLD ? 'speaking-segment-clipped' : null);
  return {
    noiseFloor: { status: quietReason ? 'unavailable' : 'measured', estimatedDb: noiseDb,
      ...(quietReason ? { reason: quietReason } : {}), method: 'guided-quiet-segment', scope: 'recorded-output' },
    snr: { status: snrReason ? 'unavailable' : 'measured', estimatedDb: snrReason ? null : toDb((speech.mean - quiet.mean) / quiet.mean),
      signalDb, noiseDb, method: 'guided-power-subtraction', ...(snrReason ? { reason: snrReason } : {}),
      assumption: 'Background sound and gain stayed constant. Guided segment power includes pauses; detected voice does not establish clarity or speaker identity.' },
    speechActivity: activity ? { status: 'measured', method: activity.method, detectedSpeechMs,
      speakingDurationMs: segments.speaking.endMs - segments.speaking.startMs,
      detection: detectedSpeechMs >= GUIDE.MIN_DETECTED_VOICE_MS ? 'detected' : 'uncertain',
      quietSpeechMs: voiceDuration(activity, segments.quiet) }
      : { status: 'unavailable', reason: 'speech-detector-unavailable' },
    guidedNoise: { status: comparisonReason ? 'unavailable' : 'measured', method: 'user-guided-file-segments', version: 2,
      ...(comparisonReason ? { reason: comparisonReason } : {}), contrastDb: comparisonReason ? null : contrast,
      quietStatus: quietReason ? 'unavailable' : 'measured', quietDb: noiseDb, speakingDb: signalDb,
      quietTotalDb: fullQuiet.mean > GUIDE.MIN_MEASURABLE_POWER ? toDb(fullQuiet.mean) : null,
      quietSpreadDb: fullQuiet.spreadDb, quietVariable: fullQuiet.spreadDb > GUIDE.MAX_QUIET_SPREAD_DB,
      excludedQuietMs: quietReason ? 0 : Math.round(fullQuiet.durationMs - quiet.durationMs),
      quiet: quietReason ? segments.quiet : { startMs: quiet.blocks[0].startMs, endMs: quiet.blocks.at(-1).endMs }, speaking: segments.speaking,
      processing: segments.processing, scope: 'Recorded segment levels, not microphone self-noise or recipient audio.' }
  };
}
