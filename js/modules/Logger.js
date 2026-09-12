/**
 * Logger - Konsol ciktisi yonetimi
 * OCP: Yeni log formatlari/hedefleri eklenebilir
 * Kategori filtreleme destegi
 */
import eventBus from './EventBus.js';
import { EVENTS } from './constants.js';

// Maksimum log sayisi - bellek korumasi
const MAX_HISTORY = 1000;

// Technical filtre icin kategori grubu (webaudio + stream + recorder)
const TECHNICAL_CATEGORIES = ['webaudio', 'stream', 'recorder'];

function createLogLine(message, category) {
  const line = document.createElement('div');
  line.className = `log-line log-${category}`;
  line.textContent = message;
  return line;
}

class Logger {
  constructor(elementId) {
    this.el = document.getElementById(elementId);
    this.history = [];
    this.activeFilter = null; // null = hepsi, 'error' = sadece error vs.

    // Event dinle
    eventBus.on(EVENTS.LOG, (msg) => this.log(msg, 'ui'));
    eventBus.on(EVENTS.LOG_CLEAR, () => this.clear());

    // Kategorili loglar icin
    eventBus.on(EVENTS.LOG_DISPLAY, (data) => {
      this.log(data.message, data.category);
    });
  }

  log(message, category = 'ui') {
    const time = new Date().toLocaleTimeString('tr-TR');
    const prefix = category !== 'ui' ? `[${category.toUpperCase()}] ` : '';
    const formattedMessage = `[${time}] ${prefix}${message}`;

    this.history.push({ time, message: formattedMessage, category, raw: message });

    // Bellek korumasi - eski loglari sil (FIFO)
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }

    // Aktif filtre varsa ve kategori uyusmuyorsa gosterme
    if (this.activeFilter && !this.matchesFilter(category)) return;

    this.appendToDisplay(formattedMessage, category);

    // Diger modullere bildir
    eventBus.emit(EVENTS.LOG_ADDED, { time, message: formattedMessage, category });
  }

  appendToDisplay(message, category) {
    if (!this.el) return;

    this.el.appendChild(createLogLine(message, category));

    // PERF-2 fix: DOM node sayisini MAX_HISTORY ile sinirla (sinirsiz buyume onleme)
    while (this.el.childElementCount > MAX_HISTORY) {
      this.el.firstElementChild.remove();
    }

    this.el.scrollTop = this.el.scrollHeight;
  }

  // Kategori filtreleme
  filterByCategory(category) {
    this.activeFilter = category;
    this.renderFilteredLogs();
    this.updateFilterButtons(category);
  }

  // Tum loglari goster
  showAll() {
    this.activeFilter = null;
    this.renderFilteredLogs();
    this.updateFilterButtons(null);
  }

  renderFilteredLogs() {
    if (!this.el) return;

    const fragment = document.createDocumentFragment();
    const logs = this.getFilteredHistory();
    for (const entry of logs.slice(-MAX_HISTORY)) fragment.appendChild(createLogLine(entry.message, entry.category));
    this.el.replaceChildren(fragment);
    // Read layout once after the complete filter result is attached.
    if (logs.length) this.el.scrollTop = this.el.scrollHeight;
  }

  updateFilterButtons(activeCategory) {
    // Tum filter butonlarini guncelle
    document.querySelectorAll('.btn-filter').forEach(btn => {
      btn.classList.remove('active');
    });

    if (activeCategory) {
      const activeBtn = document.querySelector(`[data-category="${activeCategory}"]`);
      if (activeBtn) activeBtn.classList.add('active');
    } else {
      const allBtn = document.querySelector('[data-category="all"]');
      if (allBtn) allBtn.classList.add('active');
    }
  }

  clear() {
    this.history = [];
    this.activeFilter = null;
    if (this.el) {
      this.el.replaceChildren();
    }
    this.log('Log cleared', 'system');
  }

  getHistory() {
    return [...this.history];
  }

  getFilteredHistory() {
    return this.activeFilter
      ? this.history.filter(h => this.matchesFilter(h.category))
      : this.history;
  }

  matchesFilter(category) {
    return this.activeFilter === 'technical'
      ? TECHNICAL_CATEGORIES.includes(category)
      : this.activeFilter === category;
  }

  /**
   * Tum loglari panoya kopyala
   * @returns {Promise<boolean>} Kopyalama basarili mi
   */
  async copyAll() {
    const logs = this.getFilteredHistory();
    if (logs.length === 0) {
      return false;
    }

    const text = logs.map(h => h.message).join('\n');

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // Fallback: textarea ile kopyala
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        document.body.removeChild(textarea);
        return true;
      } catch (e) {
        document.body.removeChild(textarea);
        return false;
      }
    }
  }
}

export default Logger;
