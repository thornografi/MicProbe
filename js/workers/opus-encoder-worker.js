/* Adapter for the pinned opus-recorder bundle. Keep vendor code unchanged. */
importScripts('../lib/opus/encoderWorker.min.js');

const OPUS_GET_LOOKAHEAD = 4027;
const RESAMPLE_QUALITY = 3;
// Speex quality 3 uses a 48-tap filter, expanded/aligned when downsampling.
// https://github.com/xiph/speexdsp/blob/master/libspeexdsp/resample.c
const RESAMPLE_FILTER_TAPS = 48;
let activeEncoder = null;
let preSkip = 0;
let inputFrames = 0;

function readPreSkip(encoder) {
  // Emscripten's variadic ABI passes a pointer to the argument list. GET's
  // argument is itself an output pointer, unlike the scalar SET controls.
  const args = Module._malloc(8);
  let lookahead;
  try {
    Module.HEAP32[args >> 2] = args + 4;
    const status = Module._opus_encoder_ctl(encoder.encoder, OPUS_GET_LOOKAHEAD, args);
    if (status !== 0) throw new Error('Opus encoder delay could not be read');
    lookahead = Module.HEAP32[(args + 4) >> 2];
  } finally { Module._free(args); }
  const { originalSampleRate: inputRate, encoderSampleRate: outputRate } = encoder.config;
  // The bundle does not export Speex's latency query. Mirror its fixed-Q3
  // filter-length rule, rather than silently ignoring resampler delay.
  const taps = inputRate > outputRate
    ? Math.ceil(Math.floor(RESAMPLE_FILTER_TAPS * inputRate / outputRate) / 8) * 8
    : RESAMPLE_FILTER_TAPS;
  const resamplerDelay = Math.round(taps / 2 * outputRate / inputRate);
  return Math.round((lookahead + resamplerDelay) * 48000 / outputRate);
}

const postPages = pages => pages.forEach(({ page, ...details }) =>
  self.postMessage({ ...details, page }, [page.buffer]));

self.onmessage = ({ data }) => {
  try {
    if (data.command === 'init') {
      activeEncoder?.destroy();
      activeEncoder = new OggOpusEncoder({ ...data, resampleQuality: RESAMPLE_QUALITY }, Module);
      preSkip = readPreSkip(activeEncoder);
      inputFrames = 0;
      self.postMessage({ message: 'ready', preSkip });
    } else if (data.command === 'encode' && activeEncoder) {
      postPages(activeEncoder.encode(data.buffers));
      inputFrames += data.buffers[0].length;
    } else if (data.command === 'done' && activeEncoder) {
      // Finish the delayed signal, not merely the current partial codec frame.
      // Full input blocks preserve the bundle's fixed stereo interleaver size.
      const requiredFrames = Math.ceil(data.sampleCount + preSkip * activeEncoder.config.originalSampleRate / 48000);
      const blockLength = activeEncoder.bufferLength || activeEncoder.resampleSamplesPerChannel;
      const silence = Array.from({ length: activeEncoder.config.numberOfChannels }, () => new Float32Array(blockLength));
      while (inputFrames < requiredFrames) {
        postPages(activeEncoder.encode(silence));
        inputFrames += blockLength;
      }
      postPages(activeEncoder.encodeFinalFrame());
      activeEncoder.destroy(); activeEncoder = null;
      self.postMessage({ message: 'done' });
    }
  } catch (error) {
    activeEncoder?.destroy(); activeEncoder = null;
    self.postMessage({ error: error.message || 'Opus encoding failed' });
  }
};
