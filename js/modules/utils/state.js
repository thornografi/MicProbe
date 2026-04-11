/**
 * Controller State Helpers
 *
 * Kapsam: Controller'larin preparing/idle gecisleri icin ortak helper'lar.
 * Global mod state icin: js/app/AppState.js (setCurrentMode, getCurrentMode)
 * Modul-internal state icin: Her modulun kendi instance degiskenleri
 */

/**
 * Preparing moduna gir
 * @param {Object} deps - Controller dependencies
 * @param {string} mode - 'recording' | 'monitoring' | 'test-recording' | 'test-playback'
 */
export function beginPreparing(deps, mode) {
  deps.setCurrentMode(mode);
  deps.setIsPreparing(true);
  deps.uiStateManager?.updateButtonStates();
}

/**
 * Preparing modundan cik (basarili)
 * @param {Object} deps - Controller dependencies
 */
export function endPreparing(deps) {
  deps.setIsPreparing(false);
  deps.uiStateManager?.updateButtonStates();
}

/**
 * State'i tamamen sifirla (hata durumu veya durdurma icin)
 * @param {Object} deps - Controller dependencies
 */
export function resetState(deps) {
  deps.setIsPreparing(false);
  deps.setCurrentMode(null);
  deps.uiStateManager?.updateButtonStates();
}
