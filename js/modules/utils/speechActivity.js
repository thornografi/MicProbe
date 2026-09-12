import { CAPTURE_GUIDE as GUIDE } from '../constants.js';

/** Optional offline evidence. A detector failure must never discard PCM metrics. */
export async function loadSpeechDetector() {
  try {
    const response = await fetch(new URL('../../lib/fvad/libfvad.wasm', import.meta.url),
      { signal: AbortSignal.timeout(GUIDE.VAD_LOAD_TIMEOUT_MS) });
    if (!response.ok) return null;
    return await createSpeechDetector(await response.arrayBuffer());
  } catch { return null; }
}

export async function createSpeechDetector(binary) {
  const { instance } = await WebAssembly.instantiate(binary);
  const lib = instance.exports;
  return (channels, sampleRate) => {
    const rate = [8000, 16000, 32000, 48000].includes(sampleRate) ? sampleRate : 16000;
    const frameSize = rate * GUIDE.VAD_FRAME_MS / 1000;
    const count = Math.floor(channels[0].length / sampleRate * 1000 / GUIDE.VAD_FRAME_MS);
    const frames = new Uint8Array(count);
    // Separate channel decisions avoid phase cancellation and preserve a quiet
    // voice in one channel. PCM measurement always uses the original samples.
    for (const channel of channels) {
      const pcm = rate === sampleRate ? channel : resampleForVad(channel, sampleRate, rate);
      const handles = [lib.fvad_new(), lib.fvad_new()];
      const ptr = lib.malloc(frameSize * 2);
      try {
        if (!ptr || handles.some(handle => !handle)) throw new Error('vad-allocation-failed');
        handles.forEach((handle, index) => {
          if (lib.fvad_set_sample_rate(handle, rate) || lib.fvad_set_mode(handle, index ? 2 : 0))
            throw new Error('vad-configuration-failed');
        });
        const input = new Int16Array(lib.memory.buffer, ptr, frameSize);
        for (let frame = 0; frame < count; frame++) {
          for (let j = 0; j < frameSize; j++) {
            const sample = pcm[frame * frameSize + j];
            if (!Number.isFinite(sample)) throw new Error('vad-invalid-pcm');
            input[j] = Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767));
          }
          handles.forEach((handle, index) => {
            const voice = lib.fvad_process(handle, ptr, frameSize);
            if (voice < 0) throw new Error('vad-invalid-frame');
            if (voice) frames[frame] |= 1 << index;
          });
        }
      } finally {
        handles.forEach(handle => { if (handle) lib.fvad_free(handle); });
        if (ptr) lib.free(ptr);
      }
    }
    return { status: 'measured', method: 'webrtc-vad-libfvad-2.0.7', frameMs: GUIDE.VAD_FRAME_MS, frames };
  };
}

/** Windowed-sinc low-pass resampling for detector input, never report amplitudes. */
function resampleForVad(input, sourceRate, targetRate) {
  const ratio = sourceRate / targetRate, cutoff = Math.min(1, 1 / ratio) * 0.9;
  const radius = Math.ceil(16 * Math.max(1, ratio));
  const output = new Float32Array(Math.floor(input.length / ratio));
  // A rational sample-rate ratio repeats fractional phases; reuse coefficients.
  const kernels = new Map();
  for (let i = 0; i < output.length; i++) {
    const at = i * ratio, center = Math.floor(at), fraction = Math.round((at - center) * 1e6) / 1e6;
    let kernel = kernels.get(fraction);
    if (!kernel) {
      kernel = new Float64Array(radius * 2 + 1);
      let total = 0;
      for (let k = -radius; k <= radius; k++) {
        const distance = k - fraction, x = Math.PI * cutoff * distance;
        const weight = (Math.abs(x) < 1e-9 ? cutoff : cutoff * Math.sin(x) / x)
          * (0.5 + 0.5 * Math.cos(Math.PI * distance / (radius + 1)));
        kernel[k + radius] = weight; total += weight;
      }
      for (let k = 0; k < kernel.length; k++) kernel[k] /= total;
      kernels.set(fraction, kernel);
    }
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += (input[center + k] || 0) * kernel[k + radius];
    output[i] = sum;
  }
  return output;
}
