/**
 * StatusManager - Durum gostergesi yonetimi
 * OCP: Yeni durumlar eklenebilir
 */
import eventBus from './EventBus.js';
import { PIPELINE_TYPES, EVENTS } from './constants.js';

class StatusManager {
  constructor(elementId, messageElementId = null) {
    this.el = document.getElementById(elementId);
    this.messageEl = messageElementId ? document.getElementById(messageElementId) : null;
    this.currentStatus = 'idle';

    this.statusConfig = {
      idle: { class: 'status-idle', text: 'Ready' },
      recording: { class: 'status-recording', text: 'Recording' },
      monitoring: { class: 'status-monitoring', text: 'Monitor Active' },
      webaudio: { class: 'status-webaudio', text: 'WebAudio Active' },
      loopback: { class: 'status-loopback', text: 'WebRTC Loopback' },
      testing: { class: 'status-testing', text: 'Testing' },
      error: { class: 'status-error', text: 'Needs Attention' }
    };

    // Inline CSS vars allow new status colors without touching CSS.
    this.statusVarKeys = [
      '--status-bg',
      '--status-border',
      '--status-color',
      '--status-shadow',
      '--status-dot',
      '--status-dot-shadow'
    ];

    // Event handler referanslari (destroy icin)
    this._handlers = {
      [EVENTS.RECORDER_STARTED]: () => this.setStatus('recording', { clearMessage: true }),
      [EVENTS.RECORDER_STOPPED]: () => this.setStatus('idle'),
      [EVENTS.MONITOR_STARTED]: (data) => {
        if (data?.loopback) {
          this.setStatus('loopback', { clearMessage: true });
        } else if (data?.mode === PIPELINE_TYPES.SCRIPTPROCESSOR || data?.mode === PIPELINE_TYPES.WORKLET) {
          this.setStatus('webaudio', { clearMessage: true });
        } else {
          this.setStatus('monitoring', { clearMessage: true });
        }
      },
      [EVENTS.MONITOR_STOPPED]: () => this.setStatus('idle'),
      [EVENTS.LOOPBACK_STARTED]: () => this.setStatus('loopback', { clearMessage: true }),
      [EVENTS.LOOPBACK_STOPPED]: () => this.setStatus('idle'),
      [EVENTS.TEST_RECORDING_STARTED]: () => this.setStatus('testing', { clearMessage: true }),
      [EVENTS.TEST_PLAYBACK_STARTED]: () => this.setStatus('testing', { clearMessage: true }),
      [EVENTS.TEST_COMPLETED]: () => this.setStatus('idle'),
      [EVENTS.TEST_CANCELLED]: () => this.setIdleUnlessMessageVisible(),
      [EVENTS.TEST_PLAYBACK_STOPPED]: () => this.setIdleUnlessMessageVisible(),
      [EVENTS.UI_MESSAGE]: (data) => this.showMessage(data),
      [EVENTS.UI_CLEAR_MESSAGE]: () => this.clearMessage()
    };

    // Event dinle
    Object.entries(this._handlers).forEach(([event, handler]) => {
      eventBus.on(event, handler);
    });
  }

  setStatus(status, options = {}) {
    if (options.clearMessage) this.clearMessage();
    const config = this.statusConfig[status] || this.statusConfig.idle;
    this.currentStatus = status;

    if (this.el) {
      this.el.className = `status ${config.class || ''}`.trim();
      this.el.dataset.status = status;
      this.statusVarKeys.forEach((key) => this.el.style.removeProperty(key));
      if (config.vars) {
        Object.entries(config.vars).forEach(([key, value]) => {
          this.el.style.setProperty(key, value);
        });
      }
      const dot = document.createElement('span');
      dot.className = 'status-dot';
      this.el.replaceChildren(dot, document.createTextNode(config.text));
    }

    eventBus.emit(EVENTS.STATUS_CHANGED, { status, text: config.text });
  }

  showMessage(data = {}) {
    const message = data.message || 'Something went wrong. Try again.';
    const tone = data.tone || 'error';

    this.setStatus(data.status || 'error');

    if (this.messageEl) {
      this.messageEl.hidden = false;
      this.messageEl.textContent = message;
      this.messageEl.dataset.tone = tone;
      this.messageEl.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    }
  }

  clearMessage() {
    if (!this.messageEl) return;
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
  }

  // OCP: Yeni durum eklemek icin
  addStatus(key, config) {
    this.statusConfig[key] = config;
  }
}

export default StatusManager;
