/**
 * Pipeline & Encoder Helper Functions
 */

/**
 * Pipeline'in buffer ayari gerektirip gerektirmedigini dondurur
 * @param {string} pipeline - Pipeline tipi
 * @returns {boolean}
 */
export function needsBufferSetting(pipeline) {
  return pipeline === 'scriptprocessor';
}

/**
 * Pipeline'in WebAudio kullanip kullanmadigini dondurur
 * @param {string} pipeline - Pipeline tipi
 * @returns {boolean}
 */
export function usesWebAudio(pipeline) {
  return pipeline !== 'direct';
}

/**
 * Encoder'in WASM Opus kullanip kullanmadigini dondurur
 * @param {string} encoder - Encoder tipi
 * @returns {boolean}
 */
export function usesWasmOpus(encoder) {
  return encoder === 'wasm-opus';
}

/**
 * Encoder'in MediaRecorder kullanip kullanmadigini dondurur
 * @param {string} encoder - Encoder tipi
 * @returns {boolean}
 */
export function usesMediaRecorder(encoder) {
  return encoder === 'mediarecorder';
}

/**
 * Encoder'in PCM/WAV kullanip kullanmadigini dondurur
 * @param {string} encoder - Encoder tipi
 * @returns {boolean}
 */
export function usesPcmWav(encoder) {
  return encoder === 'pcm-wav';
}

/**
 * Timeslice ayarinin disabled olmasi gerekip gerekmedigi
 * @param {boolean} loopbackOn - Loopback toggle durumu
 * @param {string} encoder - Encoder tipi
 * @returns {boolean} - true ise disabled olmali
 */
export function shouldDisableTimeslice(loopbackOn, encoder) {
  return loopbackOn || !usesMediaRecorder(encoder);
}
