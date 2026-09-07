import test from 'node:test';
import assert from 'node:assert/strict';
import { LUFSCalculator } from '../modules/utils/lufs.js';
import { analyzePcm } from '../modules/utils/pcmAnalysis.js';
import { analyze as analyzeSpectrum } from '../workers/spectral-analysis-worker.js';
import { DeepAnalysisEngine } from '../modules/DeepAnalysisEngine.js';
import eventBus from '../modules/EventBus.js';
import { EVENTS, DEEP_ANALYSIS, QUALITY } from '../modules/constants.js';

const near = (actual, expected, tolerance = 0.1) => assert.ok(Number.isFinite(actual)
  && Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by > ${tolerance}`);
const tone = (seconds, peakDb = -23, sampleRate = 48000, frequency = 1000) => {
  const pcm = new Float32Array(Math.round(seconds * sampleRate));
  const amplitude = 10 ** (peakDb / 20);
  for (let i = 0; i < pcm.length; i++) pcm[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate);
  return pcm;
};
const stereoLufs = (segments, rate = 48000) => {
  const calculator = new LUFSCalculator(rate, 2);
  for (const [seconds, peakDb] of segments) {
    const channel = tone(seconds, peakDb, rate);
    calculator.process([channel, channel]);
  }
  return calculator.getResults();
};

// EBU Tech 3341 table 1 defines these generated signals and +/-0.1 LU tolerance.
// https://tech.ebu.ch/docs/tech/tech3341.pdf
// This selected reference set does not claim complete meter certification.
for (const rate of [16000, 24000, 44100, 48000]) {
  test(`EBU case 1/2: 20 s stereo 1 kHz level references at ${rate} Hz`, () => {
    for (const peakDb of [-23, -33]) {
      const lufs = stereoLufs([[20, peakDb]], rate);
      near(lufs.integrated, peakDb); near(lufs.momentary, peakDb); near(lufs.shortTerm, peakDb);
      assert.equal(lufs.blockCount, 197);
    }
  });
}
for (const [name, segments] of [
  ['3 relative gate', [[10, -36], [60, -23], [10, -36]]],
  ['4 absolute and relative gates', [[10, -72], [10, -36], [60, -23], [10, -36], [10, -72]]],
  ['5 power averaging', [[20, -26], [20.1, -20], [20, -26]]]
]) {
  test(`EBU case ${name}`, () => near(stereoLufs(segments).integrated, -23));
}
test('EBU case 9: short-term window is exactly three seconds', () => {
  const segments = Array.from({ length: 5 }, () => [[1.34, -20], [1.66, -30]]).flat();
  near(stereoLufs(segments).shortTerm, -23);
});
test('EBU case 12: momentary window is 400 ms', () => {
  const segments = Array.from({ length: 25 }, () => [[0.18, -20], [0.22, -30]]).flat();
  near(stereoLufs(segments).momentary, -23);
});

test('Opposite-phase stereo stays audible in LUFS, RMS, and power spectrum', () => {
  const left = tone(4), right = left.map(value => -value);
  const mono = analyzePcm([left], 48000), stereo = analyzePcm([left, right], 48000);
  near(stereo.lufs.integrated - mono.lufs.integrated, 10 * Math.log10(2), 0.02);
  near(stereo.signal.rmsDb, mono.signal.rmsDb, 0.01);
  near(stereo.signal.maxBlockRmsDb, mono.signal.maxBlockRmsDb, 0.01);
  const oneSilentChannel = analyzePcm([left, new Float32Array(left.length)], 48000);
  near(oneSilentChannel.signal.maxBlockRmsDb, mono.signal.maxBlockRmsDb - 10 * Math.log10(2), 0.01);
  const options = { sampleRate: 48000, fftSize: 4096, hopSize: 2048, outputBins: 96 };
  const spectrum = analyzeSpectrum({ ...options, channels: [left.buffer, right.buffer] });
  assert.ok(spectrum.frequencyResponse.bins.some(bin => bin.db > -15));
  assert.ok(spectrum.frequencyResponse.bins.every(bin => Number.isFinite(bin.db)));
});
test('Continuous samples catch the final 200 ms and retain partial 10 ms PCM blocks', () => {
  const pcm = new Float32Array(48000 * 7 + 1);
  pcm.set(tone(0.2, -20), 48000 * 6.8);
  const metrics = analyzePcm([pcm], 48000);
  assert.equal(metrics.sampleCount, pcm.length);
  assert.equal(metrics.lufs.blockCount, 67);
  assert.ok(metrics.lufs.integrated !== null);
  const calculator = new LUFSCalculator(48000);
  calculator.process(pcm.subarray(0, 48000 * 0.3));
  assert.equal(calculator.getResults().integratedStatus, 'too-short');
  assert.equal(calculator.getResults().shortTerm, null);
});
test('Chunk boundaries do not change LUFS', () => {
  const pcm = tone(4.37, -14, 48000, 997);
  const whole = new LUFSCalculator(48000), chunked = new LUFSCalculator(48000);
  whole.process(pcm);
  for (let i = 0; i < pcm.length; i += 137) chunked.process(pcm.subarray(i, i + 137));
  assert.deepEqual(chunked.getResults(), whole.getResults());
});
test('Pure tone is not a measured noise floor; speech pauses are not dropout evidence', () => {
  const pcm = new Float32Array(48000 * 2.2);
  pcm.set(tone(1, -20), 0); pcm.set(tone(1, -20), 48000 * 1.2);
  const metrics = analyzePcm([pcm], 48000);
  near(metrics.silence.totalDurationMs, 200, 0.01);
  assert.equal(metrics.silence.count, 1);
  assert.equal(metrics.dropouts.count, null);
  assert.equal(metrics.snr.estimatedDb, null);
  assert.equal(metrics.noiseFloor.estimatedDb, null);
  const continuous = analyzePcm([tone(1, -20)], 48000);
  near(continuous.lowLevel.percentileDb, -23.01, 0.02);
});
test('Block-aligned pauses lower whole-recording RMS but preserve the highest short-window level', () => {
  for (const sampleRate of [16000, 44100, 48000]) {
    const pcm = tone(0.1, -20, sampleRate);
    const paused = new Float32Array(pcm.length * 10);
    paused.set(pcm, pcm.length * 4);
    const continuous = analyzePcm([pcm], sampleRate);
    const withPauses = analyzePcm([paused], sampleRate);
    assert.equal(withPauses.signal.maxBlockRmsDb, continuous.signal.maxBlockRmsDb);
    near(withPauses.signal.rmsDb, continuous.signal.rmsDb - 10, 0.01);
    assert.equal(withPauses.signal.peakDb, continuous.signal.peakDb);
  }
});
test('Highest short-window level stays low when every PCM block is quiet', () => {
  const metrics = analyzePcm([tone(0.1, -55)], 48000);
  near(metrics.signal.maxBlockRmsDb, -58.01, 0.02);
  assert.ok(metrics.signal.maxBlockRmsDb < QUALITY.WEAK_SIGNAL_DB);
});
test('Highest short-window level includes the last sample in a complete fixed-duration window', () => {
  const blockSize = Math.round(48000 * QUALITY.PCM_BLOCK_MS / 1000);
  const pcm = new Float32Array(blockSize + 1);
  pcm[blockSize] = 0.1;
  const metrics = analyzePcm([pcm], 48000);
  near(metrics.signal.maxBlockRmsDb, 10 * Math.log10(0.01 / blockSize), 0.01);
  assert.equal(metrics.signal.maxBlockRmsStatus, 'measured');
  assert.equal(metrics.signal.maxBlockRmsWindowMs, QUALITY.PCM_BLOCK_MS);
  near(metrics.signal.rmsDb, 10 * Math.log10(0.01 / pcm.length), 0.01);
  assert.throws(() => analyzePcm([], 48000), /Invalid PCM buffers/);
  assert.throws(() => analyzePcm([new Float32Array()], 48000), /Invalid PCM buffers/);
});
test('Near-full-scale clean tone is headroom risk, not sample saturation', () => {
  const pcm = tone(1, 20 * Math.log10(0.96));
  const clean = analyzePcm([pcm], 48000);
  assert.equal(clean.clipping.rate, 0);
  assert.ok(clean.headroom.nearPeakRate > 0);
  const rail = tone(1, -20); rail.fill(1, 40, 50);
  const saturated = analyzePcm([pcm, rail], 48000);
  assert.equal(saturated.clipping.saturatedSamples, 10);
  assert.equal(saturated.clipping.eventCount, 1);
  assert.equal(saturated.channels[1].saturatedSamples, 10);
  assert.equal(saturated.clipping.truePeak, false);
});
test('Silence and spectrum serialization are finite; unknown remains null', () => {
  const pcm = new Float32Array(48000);
  const result = analyzeSpectrum({ channels: [pcm.buffer], sampleRate: 48000,
    fftSize: 4096, hopSize: 2048, outputBins: 96, bands: { presence: QUALITY.FREQUENCY_BANDS.PRESENCE } });
  assert.ok(result.frequencyResponse.bins.every(bin => bin.db === -120));
  assert.equal(result.spectralFlatness, null);
  assert.equal(result.bands.presence, null);
  assert.equal(result.audioMetrics.lufs.integratedStatus, 'below-gate');
  assert.equal(result.audioMetrics.signal.maxBlockRmsDb, -180);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.throws(() => analyzePcm([new Float32Array([NaN])], 48000), /Non-finite/);
});
test('Unspecified multichannel layout cannot manufacture a LUFS result', () => {
  const pcm = tone(0.5);
  const metrics = analyzePcm([pcm, pcm, pcm], 48000);
  assert.equal(metrics.lufs.status, 'unavailable');
  assert.equal(metrics.lufs.reason, 'channel-layout-required');
  assert.equal(metrics.channels.length, 3);
});
test('Cancellation settles immediately during pending decode and drops late events', async () => {
  const engine = new DeepAnalysisEngine();
  let finishDecode;
  engine._decode = () => new Promise(resolve => { finishDecode = resolve; });
  const events = [];
  const off = eventBus.on(EVENTS.DEEP_ANALYSIS_READY, result => events.push(result));
  const pending = engine.analyze(new Blob(['audio']), { runId: 'old' });
  assert.equal(engine.cancel('other'), false);
  assert.equal(engine.cancel('old'), true);
  assert.equal((await pending).status, 'cancelled');
  finishDecode({ channels: [tone(1)], sampleRate: 48000 });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(events.length, 0); assert.equal(engine.getResults(), null);
  off();
});
test('Decode preserves channels, full duration and explicitly labels analyzed prefix', async () => {
  const originalContext = globalThis.AudioContext;
  const length = 48000 * (DEEP_ANALYSIS.MAX_DURATION_SEC + 1);
  let closed = 0;
  globalThis.AudioContext = class {
    async decodeAudioData() { return { sampleRate: 48000, numberOfChannels: 2, length,
      getChannelData: channel => new Float32Array(length).fill(channel ? -0.1 : 0.1) }; }
    async close() { closed++; }
  };
  const engine = new DeepAnalysisEngine();
  engine._runWorker = async channels => {
    assert.equal(channels.length, 2);
    assert.ok(channels[0][0] > 0); assert.ok(channels[1][0] < 0);
    assert.equal(channels[0].length, 48000 * DEEP_ANALYSIS.MAX_DURATION_SEC);
    return { audioMetrics: analyzePcm(channels, 48000), frequencyResponse: { frameCount: 1 }, bands: {} };
  };
  try {
    const result = await engine.analyze(new Blob(['audio']), { runId: 'prefix', source: 'record' });
    assert.equal(result.status, 'ready'); assert.equal(result.source.truncated, true);
    assert.equal(result.source.durationSec, DEEP_ANALYSIS.MAX_DURATION_SEC + 1);
    assert.equal(result.audioMetrics.coverage.analyzedDurationSec, DEEP_ANALYSIS.MAX_DURATION_SEC);
    assert.equal(result.audioMetrics.runId, 'prefix'); assert.equal(closed, 1);
  } finally { globalThis.AudioContext = originalContext; engine.destroy(); }
});
test('Superseding analysis terminates old worker and ignores captured late callbacks', async () => {
  const originalWorker = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    constructor() { workers.push(this); this.terminated = false; }
    postMessage(message) { this.message = message; this.savedCallback = this.onmessage; }
    terminate() { this.terminated = true; }
  };
  const engine = new DeepAnalysisEngine();
  engine._decode = async () => ({ channels: [tone(1)], sampleRate: 48000,
    numberOfChannels: 1, durationSec: 1, analyzedDurationSec: 1, truncated: false });
  const events = [];
  const off = eventBus.on(EVENTS.DEEP_ANALYSIS_READY, result => events.push(result.runId));
  try {
    const old = engine.analyze(new Blob(['audio']), { runId: 'old' });
    await Promise.resolve();
    const current = engine.analyze(new Blob(['audio']), { runId: 'current' });
    await Promise.resolve();
    assert.equal((await old).status, 'cancelled'); assert.equal(workers[0].terminated, true);
    workers[0].savedCallback({ data: { type: 'done', runId: 'old', result: {} } });
    const result = analyzeSpectrum(workers[1].message);
    workers[1].savedCallback({ data: { type: 'done', runId: 'current', result } });
    assert.equal((await current).runId, 'current');
    assert.deepEqual(events, ['current']); assert.equal(workers[1].terminated, true);
  } finally { off(); engine.destroy(); globalThis.Worker = originalWorker; }
});
test('Analysis watchdog publishes failure and settles even if decode never returns', async () => {
  const engine = new DeepAnalysisEngine(), previousWait = DEEP_ANALYSIS.MAX_WAIT_MS;
  const failures = [];
  const off = eventBus.on(EVENTS.DEEP_ANALYSIS_FAILED, result => failures.push(result));
  engine._decode = () => new Promise(() => {});
  DEEP_ANALYSIS.MAX_WAIT_MS = 10;
  try {
    const result = await engine.analyze(new Blob(['audio']), { runId: 'timeout' });
    assert.equal(result.status, 'failed'); assert.equal(result.reason, 'analysis-timeout');
    assert.equal(result.audioMetrics, null); assert.equal(failures.length, 1);
    assert.equal(engine.getResults().runId, 'timeout');
  } finally { DEEP_ANALYSIS.MAX_WAIT_MS = previousWait; off(); engine.destroy(); }
});
test('Oversized input and decode failure cannot produce measured audio', async () => {
  const engine = new DeepAnalysisEngine();
  const tooLarge = await engine.analyze({ size: DEEP_ANALYSIS.MAX_BLOB_BYTES + 1 }, { runId: 'large' });
  assert.equal(tooLarge.status, 'skipped'); assert.equal(tooLarge.reason, 'file-too-large-for-analysis');
  engine._decode = async () => { throw new Error('invalid container'); };
  const failure = await engine.analyze(new Blob(['bad']), { runId: 'invalid' });
  assert.equal(failure.status, 'failed'); assert.equal(failure.audioMetrics, null);
  engine.destroy();
});
