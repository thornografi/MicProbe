/**
 * Stream Helper Functions
 */
import eventBus from '../EventBus.js';
import { EVENTS } from '../constants.js';

/**
 * MediaStream'in tum track'lerini durdurur
 * @param {MediaStream} stream - Durdurulacak stream
 */
export function stopStreamTracks(stream) {
  if (!stream) return;
  stream.getTracks().forEach(track => track.stop());
}

/**
 * getUserMedia hata kodlarini kullanici dostu mesaja cevir
 * @param {Error} err - getUserMedia veya MediaRecorder hatasi
 * @returns {string} - Kullanici dostu hata mesaji
 */
export function getStreamErrorMessage(err) {
  const errorMap = {
    NotAllowedError: 'Microphone permission denied',
    NotFoundError: 'Microphone not found',
    NotReadableError: 'Microphone is being used by another application',
    OverconstrainedError: 'Unsupported microphone setting',
    AbortError: 'Microphone access was aborted',
    SecurityError: 'Microphone access blocked by security policy'
  };
  return errorMap[err.name] || err.message;
}

/**
 * Async event handler'lari try-catch ile sarar
 * @param {Function} fn - Async handler fonksiyonu
 * @param {string} errorMessage - Hata mesaji
 * @returns {Function} - Try-catch ile sarili handler
 */
export function wrapAsyncHandler(fn, errorMessage) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      eventBus.emit(EVENTS.LOG_ERROR, {
        message: errorMessage,
        details: { error: err.message, stack: err.stack }
      });
    }
  };
}

/**
 * pipeline:analyserReady ve stream:started event'lerini DOGRU sirada emit eder.
 * KRITIK: Bu siralama VuMeter icin zorunludur — ayri emit YAPMA, bu helper'i kullan.
 * @param {AnalyserNode|null} analyserNode - Pipeline'dan gelen analyser (yoksa null)
 * @param {MediaStream} stream - Baslayan stream
 */
export function emitStreamWithAnalyser(analyserNode, stream) {
  if (analyserNode) {
    eventBus.emit(EVENTS.PIPELINE_ANALYSER_READY, analyserNode);
  }
  eventBus.emit(EVENTS.STREAM_STARTED, stream);
}
