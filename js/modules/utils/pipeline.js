/**
 * Pipeline & Encoder Helper Functions
 */
import { ENCODER_TYPES, PIPELINE_TYPES } from '../constants.js';

/**
 * Pipeline'in buffer ayari gerektirip gerektirmedigini dondurur
 * @param {string} pipeline - Pipeline tipi
 * @returns {boolean}
 */
export function needsBufferSetting(pipeline) {
  return pipeline === PIPELINE_TYPES.SCRIPTPROCESSOR;
}

/**
 * Pipeline'in WebAudio kullanip kullanmadigini dondurur
 * @param {string} pipeline - Pipeline tipi
 * @returns {boolean}
 */
export function usesWebAudio(pipeline) {
  return pipeline !== PIPELINE_TYPES.DIRECT;
}

/**
 * Encoder'in WASM Opus kullanip kullanmadigini dondurur
 * @param {string} encoder - Encoder tipi
 * @returns {boolean}
 */
export function usesWasmOpus(encoder) {
  return encoder === ENCODER_TYPES.WASM_OPUS;
}

/**
 * Encoder'in MediaRecorder kullanip kullanmadigini dondurur
 * @param {string} encoder - Encoder tipi
 * @returns {boolean}
 */
export function usesMediaRecorder(encoder) {
  return encoder === ENCODER_TYPES.MEDIARECORDER;
}

/**
 * Encoder'in PCM/WAV kullanip kullanmadigini dondurur
 * @param {string} encoder - Encoder tipi
 * @returns {boolean}
 */
export function usesPcmWav(encoder) {
  return encoder === ENCODER_TYPES.PCM_WAV;
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
