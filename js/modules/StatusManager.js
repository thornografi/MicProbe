/**
 * StatusManager - Durum gostergesi yonetimi
 * OCP: Yeni durumlar eklenebilir
 */
import eventBus from './EventBus.js';
import { PIPELINE_TYPES, EVENTS } from './constants.js';

class StatusManager {
  constructor(elementId) {
    this.el = document.getElementById(elementId);
    this.currentStatus = 'idle';

    this.statusConfig = {
      idle: { class: 'status-idle', text: 'Ready' },
      recording: { class: 'status-recording', text: 'Recording' },
      monitoring: { class: 'status-monitoring', text: 'Monitor Active' },
      webaudio: { class: 'status-webaudio', text: 'WebAudio Active' },
      loopback: { class: 'status-loopback', text: 'WebRTC Loopback' },
      testing: { class: 'status-testing', text: 'Testing' }
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
      [EVENTS.RECORDER_STARTED]: () => this.setStatus('recording'),
      [EVENTS.RECORDER_STOPPED]: () => this.setStatus('idle'),
      [EVENTS.MONITOR_STARTED]: (data) => {
        if (data?.loopback) {
          this.setStatus('loopback');
        } else if (data?.mode === PIPELINE_TYPES.SCRIPTPROCESSOR || data?.mode === PIPELINE_TYPES.WORKLET) {
          this.setStatus('webaudio');
        } else {
          this.setStatus('monitoring');
        }
      },
      [EVENTS.MONITOR_STOPPED]: () => this.setStatus('idle'),
      [EVENTS.LOOPBACK_STARTED]: () => this.setStatus('loopback'),
      [EVENTS.LOOPBACK_STOPPED]: () => this.setStatus('idle'),
      [EVENTS.TEST_RECORDING_STARTED]: () => this.setStatus('testing'),
      [EVENTS.TEST_PLAYBACK_STARTED]: () => this.setStatus('testing'),
      [EVENTS.TEST_COMPLETED]: () => this.setStatus('idle'),
      [EVENTS.TEST_CANCELLED]: () => this.setStatus('idle'),
      [EVENTS.TEST_PLAYBACK_STOPPED]: () => this.setStatus('idle')
    };

    // Event dinle
    Object.entries(this._handlers).forEach(([event, handler]) => {
      eventBus.on(event, handler);
    });
  }

  setStatus(status) {
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
      this.el.innerHTML = `<span class="status-dot"></span>${config.text}`;
    }

    eventBus.emit(EVENTS.STATUS_CHANGED, { status, text: config.text });
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
