import { createOpusWorker } from '../modules/OpusWorkerHelper.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };

/** Real bundled WASM encoder and browser decoder; no microphone or fake codec. */
export async function runOpusFinalizationChecks() {
  const context = new AudioContext({ sampleRate: 48000 });
  let checks = 0;
  try {
    const cases = [];
    for (const rate of [16000, 24000, 44100, 48000]) {
      for (const channels of [1, 2]) {
        for (const blockSize of [Math.round(rate * .02), 4096]) {
          // Exact frame end, residual frame and page-boundary end all matter.
          for (const seconds of [.02, .8, 1.003]) cases.push({ rate, channels, blockSize, seconds });
        }
      }
    }
    cases.push({ rate: 48000, channels: 2, blockSize: 960, seconds: .02, application: 2051 });
    cases.push({ rate: 96000, channels: 2, blockSize: 1920, seconds: 1.003 });
    for (const { rate, channels, blockSize, seconds, application = 2048 } of cases) {
      const label = `${rate}Hz/${channels}ch/${blockSize}frames/${seconds}s/app${application}`;
      const length = Math.round(rate * seconds), burstFrames = Math.round(rate * .005);
      const wrapper = await createOpusWorker({ sampleRate: rate, channels, bitrate: 128000, encoderApplication: application });
      try {
        for (let start = 0; start < length; start += blockSize) {
          const valid = Math.min(blockSize, length - start);
          const buffers = Array.from({ length: channels }, (_, channel) =>
            Float32Array.from({ length: blockSize }, (_, i) => {
              const frame = start + i;
              return i < valid && (frame < burstFrames || frame >= length - burstFrames)
                ? .7 * Math.sin(2 * Math.PI * (channel ? 2000 : 1000) * frame / rate) : 0;
            }));
          wrapper.encode(buffers, valid);
        }
        const first = wrapper.finish();
        assert(first === wrapper.finish(), `${label}: duplicate finish operation`);
        const result = await first;
        const decoded = await context.decodeAudioData(await result.blob.arrayBuffer());
        assert(result.sampleCount === length, `${label}: capture metadata changed`);
        assert(decoded.length === Math.round(length * 48000 / rate), `${label}: decoded length ${decoded.length} loses/adds samples`);
        assert(decoded.numberOfChannels === channels, `${label}: channels lost`);
        for (let channel = 0; channel < channels; channel++) {
          const samples = decoded.getChannelData(channel);
          const rms = data => Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
          assert(rms(samples.subarray(0, 240)) > .2, `${label}: start of channel ${channel} lost`);
          assert(rms(samples.subarray(-240)) > .2, `${label}: tail of channel ${channel} lost`);
          const tonePower = frequency => {
            let sine = 0, cosine = 0;
            for (let i = samples.length - 240; i < samples.length; i++) {
              sine += samples[i] * Math.sin(2 * Math.PI * frequency * i / 48000);
              cosine += samples[i] * Math.cos(2 * Math.PI * frequency * i / 48000);
            }
            return sine * sine + cosine * cosine;
          };
          const own = channel ? 2000 : 1000, other = channel ? 1000 : 2000;
          assert(tonePower(own) > 3 * tonePower(other), `${label}: stereo channel content mixed`);
          let correlation = 0, inputPower = 0, decodedPower = 0;
          for (let i = samples.length - 240; i < samples.length; i++) {
            const reference = Math.sin(2 * Math.PI * own * i / 48000);
            correlation += samples[i] * reference;
            inputPower += reference * reference; decodedPower += samples[i] * samples[i];
          }
          assert(correlation / Math.sqrt(inputPower * decodedPower) > .8, `${label}: codec/resampler delay was not compensated`);
        }
        checks++;
      } finally { wrapper.terminate(); }
    }
    return checks;
  } finally { await context.close(); }
}
