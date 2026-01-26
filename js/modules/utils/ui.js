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
 * DOM element gorunurlugunu toggle et
 * @param {HTMLElement} element - Hedef element
 * @param {boolean} shouldShow - Goster/gizle
 * @param {string} displayValue - Gosterilecek display degeri (default: 'block')
 */
export function toggleDisplay(element, shouldShow, displayValue = 'block') {
  if (element) {
    element.style.display = shouldShow ? displayValue : 'none';
  }
}
