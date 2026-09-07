/**
 * StatusManager - Kontrollerin yanindaki aciklamalar, hata mesajlari ve durum olaylari
 */
import eventBus from './EventBus.js';
import { EVENTS } from './constants.js';

class StatusManager {
  /**
   * @param {Object} elements - { messageEl, captureHintEl, micHintEl } (UIElements)
   * @param {Function} getContext
   */
  constructor(elements = {}, getContext = () => ({})) {
    this.messageEl = elements.messageEl || null;
    this.currentStatus = 'idle';
    this.getContext = getContext;
    this.captureHintEl = elements.captureHintEl || null;
    this.micHintEl = elements.micHintEl || null;

    // Preserve the status event contract; visible guidance lives beside the controls.
    this.statusText = {
      idle: 'Ready to Test',
      checking: 'Checking microphone',
      prompt: 'Microphone access needed',
      denied: 'Microphone blocked',
      unavailable: 'Check microphone',
      preparing: 'Preparing microphone',
      ready: 'Ready to test',
      result: 'Result ready',
      recording: 'Recording Sample',
      testing: 'Running Test',
      analysing: 'Analysing Sample',
      error: 'Needs Attention'
    };

    // Event handler referanslari (destroy icin)
    this._handlers = {
      [EVENTS.RECORDER_STARTED]: () => this.setStatus('recording', { clearMessage: true }),
      [EVENTS.RECORDER_STOPPED]: () => this.setStatus('idle'),
      [EVENTS.TEST_RECORDING_STARTED]: () => this.setStatus('testing', { clearMessage: true }),
      [EVENTS.TEST_ANALYSING_STARTED]: () => this.setStatus('analysing', { clearMessage: true }),
      [EVENTS.TEST_COMPLETED]: () => this.setStatus('idle'),
      [EVENTS.TEST_CANCELLED]: () => this.setIdleUnlessMessageVisible(),
      [EVENTS.UI_MESSAGE]: (data) => this.showMessage(data),
      [EVENTS.UI_CLEAR_MESSAGE]: () => { this.clearMessage(); this.sync(); },
      [EVENTS.UI_STATE_CHANGED]: () => this.sync(),
      [EVENTS.MICROPHONE_ACCESS_CHANGED]: () => this.sync(),
      [EVENTS.PROFILE_CHANGED]: () => this.sync(),
      [EVENTS.DEEP_ANALYSIS_STARTED]: () => this.sync(),
      [EVENTS.DIAGNOSTIC_REPORT_READY]: () => this.sync()
    };

    // Event dinle
    Object.entries(this._handlers).forEach(([event, handler]) => {
      eventBus.on(event, handler);
    });

    // Toast top-layer'da (popover). Yeni bir modal/dialog acilinca en uste alinsin diye
    // OverlayController'in document olayini dinler (EventBus bagimliligi yok).
    this._onOverlayChange = (event) => {
      if (event?.detail?.open && this.messageEl && !this.messageEl.hidden) this._raiseToast();
    };
    document.addEventListener?.('micprobe:overlay', this._onOverlayChange);
  }

  /**
   * Toast'i top-layer'a cikarir (Popover API). Acikken tekrar cagrilinca
   * kapatip acar = katman sirasinda en uste tasir. Popover desteklenmiyorsa
   * `hidden` akisi tek basina calisir (akista gorunur).
   */
  _raiseToast() {
    const el = this.messageEl;
    if (!el || typeof el.showPopover !== 'function' || !el.isConnected) return;
    try {
      if (el.matches?.(':popover-open')) el.hidePopover();
      el.showPopover();
    } catch { /* top-layer'a alinamadi (ornek: gizli ata) - akista kalir */ }
  }

  _dismissToast() {
    const el = this.messageEl;
    if (!el || typeof el.hidePopover !== 'function') return;
    try { if (el.matches?.(':popover-open')) el.hidePopover(); } catch { /* zaten kapali */ }
  }

  setStatus(status, options = {}) {
    if (options.clearMessage) this.clearMessage();
    if (status === 'idle') status = this._contextStatus();
    this.currentStatus = status;
    eventBus.emit(EVENTS.STATUS_CHANGED, { status, text: this.statusText[status] || this.statusText.idle });
  }

  _contextStatus() {
    const context = this.getContext();
    if (context.pending || context.mode === 'test-analysing') return 'analysing';
    if (context.preparing) return 'preparing';
    if (context.mode === 'test-recording') return 'testing';
    if (context.mode === 'recording') return 'recording';
    if (this.messageEl && !this.messageEl.hidden && this.messageEl.dataset.tone === 'error') return 'error';
    if (context.access && context.access !== 'ready') return context.access;
    return context.hasResult ? 'result' : 'ready';
  }

  sync() {
    const context = this.getContext();
    const state = this._contextStatus();
    if (this.currentStatus !== state) this.setStatus(state);
    const micHints = {
      checking: 'Checking available microphones…',
      prompt: 'Start a test or recording, then allow microphone access in your browser.',
      denied: 'Microphone access is blocked. Allow access in browser site settings, then refresh the list.',
      unavailable: 'No microphone is available. Connect a microphone and refresh the list.',
      ready: 'Use your everyday microphone. We’ll guide you through the test.'
    };
    const micHint = micHints[context.access] || micHints.checking;
    const captureHint = state === 'analysing'
      ? 'Analyzing your sample. Your result will appear below.'
      : state === 'preparing' ? 'Allow microphone access if your browser asks. Capture starts when ready.'
      : 'We’ll guide you: stay quiet briefly, then read a short sentence. The test stops automatically.';
    // These are live regions: only change their DOM text when the guidance changes.
    if (this.micHintEl && this.micHintEl.textContent !== micHint) this.micHintEl.textContent = micHint;
    if (this.captureHintEl && this.captureHintEl.textContent !== captureHint) this.captureHintEl.textContent = captureHint;
  }

  showMessage(data = {}) {
    const message = data.message || 'Something went wrong. Try again.';
    const tone = data.tone || 'error';

    this.setStatus(data.status || 'error');

    if (this.messageEl) {
      // Rol canliligi belirler (alert=assertive, status=polite); metin gosterimden sonra yazilir ki duyurulsun
      this.messageEl.setAttribute('role', tone === 'error' ? 'alert' : 'status');
      this.messageEl.dataset.tone = tone;
      this.messageEl.hidden = false;
      this._raiseToast();
      this.messageEl.textContent = message;
    }
  }

  clearMessage() {
    if (!this.messageEl) return;
    this._dismissToast();
    this.messageEl.hidden = true;
    this.messageEl.textContent = '';
    this.messageEl.removeAttribute('data-tone');
    this.messageEl.setAttribute('role', 'status');
  }

  setIdleUnlessMessageVisible() {
    if (this.messageEl && !this.messageEl.hidden) return;
    this.setStatus('idle');
  }

  getStatus() {
    return this.currentStatus;
  }

  /**
   * Event listener'lari temizle
   */
  destroy() {
    Object.entries(this._handlers).forEach(([event, handler]) => {
      eventBus.off(event, handler);
    });
    this._handlers = {};
    document.removeEventListener?.('micprobe:overlay', this._onOverlayChange);
  }
}

export default StatusManager;
