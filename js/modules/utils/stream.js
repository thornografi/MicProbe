/**
 * Stream Helper Functions
 */
import eventBus from '../EventBus.js';

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
      eventBus.emit('log:error', {
        message: errorMessage,
        details: { error: err.message, stack: err.stack }
      });
    }
  };
}
