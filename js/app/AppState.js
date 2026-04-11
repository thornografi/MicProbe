/**
 * Global Application State
 *
 * Kapsam: Tum uygulamadaki aktif mod (recording/monitoring/idle) ve
 * preparing durumu. Controller veya modul seviyesi state BURADA TUTULMAZ.
 *
 * Controller state icin: js/modules/utils/state.js (beginPreparing, endPreparing, resetState)
 * Modul-internal state icin: Her modulun kendi instance degiskenleri
 */

// Modlar: null (idle), 'recording', 'monitoring'
let currentMode = null;
// Hazirlaniyor state (kayit/monitoring baslatilirken)
let isPreparing = false;

export function setCurrentMode(mode) {
  currentMode = mode;
}

export function getCurrentMode() {
  return currentMode;
}

export function setIsPreparing(val) {
  isPreparing = val;
}

export function getIsPreparing() {
  return isPreparing;
}

/**
 * Controller dependencies icin state getter/setter'lari dondur
 */
export function getStateAccessors() {
  return {
    setCurrentMode,
    getCurrentMode,
    setIsPreparing,
    getIsPreparing
  };
}
