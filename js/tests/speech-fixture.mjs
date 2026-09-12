import { readFileSync } from 'node:fs';

const wav = readFileSync(new URL('./fixtures/capture-speech.wav', import.meta.url));
let data;
for (let at = 12; at + 8 <= wav.length;) {
  const size = wav.readUInt32LE(at + 4);
  if (wav.toString('ascii', at, at + 4) === 'data') { data = wav.subarray(at + 8, at + 8 + size); break; }
  at += 8 + size + (size & 1);
}
export const fixtureVoice = Float32Array.from({ length: data.length / 2 }, (_, i) => data.readInt16LE(i * 2) / 32768);
export const processing = { autoGainControl: false, noiseSuppression: false, echoCancellation: false };
export const guidedSegments = () => ({ version: 1, method: 'user-guided-file-segments', durationMs: 10000,
  quiet: { startMs: 500, endMs: 2500 }, speaking: { startMs: 3500, endMs: 9500 }, processing });

/** Deterministic noise plus generated speech; no human recording or network dependency. */
export function speechFixture(rate = 16000, { voiceStart = 3, voiceGain = 0.6, noiseGain = 0.002 } = {}) {
  let seed = 927;
  return Float32Array.from({ length: rate * 10 }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const at = (i / rate - voiceStart) * 16000, left = Math.floor(at), fraction = at - left;
    const voice = at >= 0 ? (fixtureVoice[left] || 0) * (1 - fraction) + (fixtureVoice[left + 1] || 0) * fraction : 0;
    return (seed / 4294967296 * 2 - 1) * noiseGain + voice * voiceGain;
  });
}
