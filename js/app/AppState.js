/**
 * AppState - Merkezi uygulama state yonetimi
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
