/**
 * UI Helper Functions
 */

/**
 * Saniyeyi mm:ss formatina cevir
 * @param {number} seconds - Saniye cinsinden sure
 * @returns {string} - "0:00" formatinda sure
 */
export function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Timestamp'i YYMMDDHHMMSS formatina cevir (local time)
 * @param {Date} date - Opsiyonel Date (default: now)
 * @returns {string}
 */
export function formatTimestampYYMMDDHHMMSS(date = new Date()) {
  const yy = String(date.getFullYear() % 100).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yy}${mm}${dd}${hh}${min}${ss}`;
}

/**
 * Tek gorunurluk mekanizmasi: `hidden` attribute (CSS: [hidden]{display:none!important}).
 * Inline display yazilmaz; elemanin CSS display'i (flex/grid/block) korunur.
 * @param {HTMLElement} element
 * @param {boolean} hidden
 */
export function setHidden(element, hidden) {
  if (element) element.hidden = !!hidden;
}

/** setHidden'in tersi (okunabilirlik): goster/gizle */
export function setVisible(element, visible) {
  setHidden(element, !visible);
}
