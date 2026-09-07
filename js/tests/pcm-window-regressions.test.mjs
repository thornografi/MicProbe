import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePcm } from '../modules/utils/pcmAnalysis.js';
import { QUALITY } from '../modules/constants.js';

const rates = [8000, 16000, 24000, 44100, 48000, 96000];
const near = (actual, expected) => assert.ok(Number.isFinite(actual)
  && Math.abs(actual - expected) <= 0.011, `${actual} differs from ${expected}`);
const roundedDb = power => +Math.max(-180, 10 * Math.log10(Math.max(power, 1e-18))).toFixed(2);

for (const sampleRate of rates) {
  test(`Moving a transient across block boundaries and the recording end preserves fixed-window RMS at ${sampleRate} Hz`, () => {
    const windowSamples = Math.round(sampleRate * QUALITY.PCM_BLOCK_MS / 1000);
    const length = windowSamples * 5 + 1;
    for (const transientSamples of [1, Math.max(2, Math.round(windowSamples / 7.5))]) {
      for (const gains of [[1], [1, -1], [0, 1], [1, 0.5, -1]]) {
        const positions = [0, windowSamples + 5, windowSamples * 2 - Math.ceil(transientSamples / 2), length - transientSamples];
        const results = positions.map(position => {
          const channels = gains.map(gain => {
            const samples = new Float32Array(length);
            samples.fill(gain * 0.02, position, position + transientSamples);
            return samples;
          });
          return analyzePcm(channels, sampleRate);
        });
        const power = gains.reduce((sum, gain) => sum + (gain * 0.02) ** 2, 0) / gains.length;
        const expected = roundedDb(power * transientSamples / windowSamples);
        for (const metrics of results) {
          near(metrics.signal.maxBlockRmsDb, expected);
          assert.equal(metrics.signal.maxBlockRmsStatus, 'measured');
          assert.equal(metrics.signal.maxBlockRmsWindowMs, windowSamples / sampleRate * 1000);
          assert.deepEqual(metrics.signal, results[0].signal);
          assert.equal(metrics.noiseFloor.status, 'unavailable');
          assert.equal(metrics.snr.status, 'unavailable');
          assert.equal(metrics.dropouts.status, 'unavailable');
        }
      }
    }
  });
}

test('A recording shorter than one window exposes RMS and peak but no fixed-window maximum', () => {
  for (const sampleRate of rates) {
    const windowSamples = Math.round(sampleRate * QUALITY.PCM_BLOCK_MS / 1000);
    for (const length of [1, windowSamples - 1]) {
      const metrics = analyzePcm([new Float32Array(length).fill(0.1)], sampleRate);
      assert.equal(metrics.signal.maxBlockRmsDb, null);
      assert.equal(metrics.signal.maxBlockRmsStatus, 'unavailable');
      assert.equal(metrics.signal.maxBlockRmsReason, 'too-short');
      near(metrics.signal.rmsDb, -20); near(metrics.signal.peakDb, -20);
      assert.deepEqual(JSON.parse(JSON.stringify(metrics)), metrics);
    }
    const exact = analyzePcm([new Float32Array(windowSamples).fill(0.1)], sampleRate);
    assert.equal(exact.signal.maxBlockRmsStatus, 'measured');
    near(exact.signal.maxBlockRmsDb, -20);
  }
});

test('The sliding maximum agrees with direct full-window power across varying multichannel PCM', () => {
  for (const sampleRate of [8000, 22050, 44100, 48000]) {
    const windowSamples = Math.round(sampleRate * QUALITY.PCM_BLOCK_MS / 1000);
    const length = windowSamples * 4 + 17;
    const channels = [1, -0.3].map((gain, channel) => Float32Array.from({ length }, (_, i) =>
      gain * (0.01 + 0.04 * (i % 97) / 97) * Math.sin((i + channel) * 0.271)));
    let maximum = 0;
    for (let start = 0; start + windowSamples <= length; start++) {
      let power = 0;
      for (const samples of channels) {
        for (let i = start; i < start + windowSamples; i++) power += samples[i] ** 2;
      }
      maximum = Math.max(maximum, power / (windowSamples * channels.length));
    }
    const metrics = analyzePcm(channels, sampleRate);
    near(metrics.signal.maxBlockRmsDb, roundedDb(maximum));
  }
});

test('The known one-sample final click keeps the same low-window level as an interior click', () => {
  const sampleRate = 48000, length = sampleRate * 3 + 1;
  const results = [sampleRate, length - 1].map(position => {
    const samples = Float32Array.from({ length }, (_, i) => 10 ** (-65 / 20) * Math.sin(2 * Math.PI * 1000 * i / sampleRate));
    samples[position] = 0.1;
    return analyzePcm([samples], sampleRate);
  });
  assert.deepEqual(results[0].signal, results[1].signal);
  near(results[0].signal.maxBlockRmsDb, -46.78);
  assert.ok(results[0].signal.maxBlockRmsDb < QUALITY.WEAK_SIGNAL_DB);
});
