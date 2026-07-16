/**
 * LogManager - Kategorili loglama sistemi
 * Kategoriler: error, warning, audio, stream, webaudio, recorder, system, ui
 *
 * Browser'da dosya sistemine dogrudan yazilamaz.
 * Bu modul:
 * 1. Bellekte kategorili log tutar
 * 2. IndexedDB'ye kaydeder
 * 3. Export fonksiyonu ile download edilebilir
 * 4. Console'a kisa versiyon yazar
 */
import eventBus from './EventBus.js';
import { DELAY, ENCODER_TYPES, IS_DEV, LOG, PIPELINE_TYPES, EVENTS } from './constants.js';

const LOG_CATEGORIES = {
  ERROR: 'error',
  WARNING: 'warning',
  AUDIO: 'audio',
  STREAM: 'stream',
  WEBAUDIO: 'webaudio',
  RECORDER: 'recorder',
  SYSTEM: 'system',
  UI: 'ui'
};

const LOG_EVENT_BUCKETS = {
  [EVENTS.LOG_ERROR]: LOG_CATEGORIES.ERROR,
  [EVENTS.LOG_WARNING]: LOG_CATEGORIES.WARNING,
  [EVENTS.LOG_AUDIO]: LOG_CATEGORIES.AUDIO,
  [EVENTS.LOG_STREAM]: LOG_CATEGORIES.STREAM,
  [EVENTS.LOG_WEBAUDIO]: LOG_CATEGORIES.WEBAUDIO,
  [EVENTS.LOG_RECORDER]: LOG_CATEGORIES.RECORDER,
  [EVENTS.LOG_SYSTEM]: LOG_CATEGORIES.SYSTEM,
  [EVENTS.LOG_UI]: LOG_CATEGORIES.UI,
  [EVENTS.LOG_LOOPBACK]: LOG_CATEGORIES.STREAM,
  [EVENTS.LOG_CONSTRAINT]: LOG_CATEGORIES.STREAM,
  [EVENTS.LOG_PLAYER]: LOG_CATEGORIES.AUDIO,
  [EVENTS.LOG_PIPELINE]: LOG_CATEGORIES.WEBAUDIO,
  [EVENTS.LOG_ENCODER]: LOG_CATEGORIES.WEBAUDIO,
  [EVENTS.LOG_VUMETER]: LOG_CATEGORIES.WEBAUDIO,
  [EVENTS.LOG_DEVICE]: LOG_CATEGORIES.SYSTEM,
  [EVENTS.LOG_PROFILE]: LOG_CATEGORIES.UI
};

class LogManager {
  constructor() {
    this.logs = {
      error: [],
      warning: [],
      audio: [],
      stream: [],
      webaudio: [],
      recorder: [],
      system: [],
      ui: []
    };

    this.sessionId = Date.now().toString(36);
    this.dbName = 'MicProbeLogs';
    this.dbVersion = 1;
    this.db = null;

    this.initDB();
    this.bindEvents();
    this._processEarlyErrors(); // index.html'de yakalanan erken hatalari isle

    this.log('system', 'LogManager initialized', { sessionId: this.sessionId });
  }

  /**
   * Stack trace'den dosya:satir:sutun lokasyonu cikarir
   * @param {string} stack - Error stack trace
   * @returns {string|null} "filename.js:line:col" veya null
   */
  _extractLocation(stack) {
    if (!stack) return null;
    // Format 1: "at functionName (http://...:line:col)"
    const match = stack.match(/at\s+.*?\s+\((.+?):(\d+):(\d+)\)/);
    if (match) {
      const [, file, line, col] = match;
      return `${file.split('/').pop()}:${line}:${col}`;
    }
    // Format 2: "at http://...:line:col"
    const altMatch = stack.match(/at\s+(.+?):(\d+):(\d+)/);
    if (altMatch) {
      const [, file, line, col] = altMatch;
      return `${file.split('/').pop()}:${line}:${col}`;
    }
    return null;
  }

  /**
   * index.html'deki early error capture script'inin yakaladigi hatalari isle
   */
  _processEarlyErrors() {
    if (window.__earlyErrors?.length) {
      window.__earlyErrors.forEach(err => {
        if (err.type === 'error') {
          // Lokasyonu belirle
          const location = err.filename
            ? `${err.filename.split('/').pop()}:${err.lineno}:${err.colno}`
            : 'unknown';

          this.log('error', `[Early] ${err.message} @ ${location}`, {
            filename: err.filename,
            lineno: err.lineno,
            colno: err.colno,
            stack: err.stack,
            capturedAt: err.timestamp
          });
        } else if (err.type === 'unhandledrejection') {
          this.log('error', `[Early] Promise Rejected: ${err.reason}`, {
            stack: err.stack,
            capturedAt: err.timestamp
          });
        }
      });
      if (IS_DEV) console.warn(`[LogManager] ${window.__earlyErrors.length} early errors processed`);
      window.__earlyErrors = []; // Temizle
    }
  }

  async initDB() {
    try {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        if (IS_DEV) console.warn('[LogManager] IndexedDB could not be opened, using memory only');
      };

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('logs')) {
          const store = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
          store.createIndex('category', 'category', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('sessionId', 'sessionId', { unique: false });
        }
      };

      request.onsuccess = (e) => {
        this.db = e.target.result;
        this.log('system', 'IndexedDB connection successful');
      };
    } catch (err) {
      if (IS_DEV) console.warn('[LogManager] IndexedDB error:', err);
    }
  }

  bindEvents() {
    // Genel log event'i
    eventBus.on(EVENTS.LOG, (msg) => this.log('ui', msg));

    // Kategorili event'ler: 16 helper -> 8 storage bucket.
    Object.entries(LOG_EVENT_BUCKETS).forEach(([event, category]) => {
      eventBus.on(event, (data) => this.log(category, data.message, data.details));
    });

    // Stream event'leri
    eventBus.on(EVENTS.STREAM_STARTED, (stream) => {
      const track = stream?.getAudioTracks()[0];
      this.log('stream', 'Stream started', {
        trackId: track?.id,
        trackLabel: track?.label,
        trackSettings: track?.getSettings()
      });
    });

    eventBus.on(EVENTS.STREAM_STOPPED, () => {
      this.log('stream', 'Stream stopped');
    });

    // Recorder event'leri (encoder-agnostic)
    eventBus.on(EVENTS.RECORDER_STARTED, (details) => {
      const encoder = details?.encoder || 'unknown';
      const msg = encoder === ENCODER_TYPES.WASM_OPUS
        ? 'WASM Opus encoder started'
        : encoder === ENCODER_TYPES.PCM_WAV
          ? 'PCM/WAV encoder started'
          : 'MediaRecorder started';
      this.log('recorder', msg, details || null);
    });

    eventBus.on(EVENTS.RECORDER_STOPPED, (details) => {
      const encoder = details?.encoder || 'unknown';
      const msg = encoder === ENCODER_TYPES.WASM_OPUS
        ? 'WASM Opus encoder stopped'
        : encoder === ENCODER_TYPES.PCM_WAV
          ? 'PCM/WAV encoder stopped'
          : 'MediaRecorder stopped';
      this.log('recorder', msg, details || null);
    });

    eventBus.on(EVENTS.RECORDING_COMPLETED, (data) => {
      this.log('recorder', 'Recording complete', {
        filename: data.filename,
        size: data.blob?.size,
        mimeType: data.mimeType
      });
    });

    // Monitor event'leri
    eventBus.on(EVENTS.MONITOR_STARTED, (data) => {
      const mode = data?.mode;
      const category = (data?.loopback || mode === PIPELINE_TYPES.DIRECT) ? 'stream' : 'webaudio';
      this.log(category, 'Monitor started', {
        mode,
        delaySeconds: data?.delaySeconds,
        loopback: !!data?.loopback
      });
    });

    eventBus.on(EVENTS.MONITOR_STOPPED, (data) => {
      const mode = data?.mode;
      const category = (data?.loopback || mode === PIPELINE_TYPES.DIRECT) ? 'stream' : 'webaudio';
      this.log(category, 'Monitor stopped', { mode, loopback: !!data?.loopback });
    });

    // VU Meter event'leri (sadece onemli olanlar)
    eventBus.on(EVENTS.VUMETER_STARTED, () => {
      this.log('audio', 'VU Meter started');
    });

    eventBus.on(EVENTS.VUMETER_STOPPED, () => {
      this.log('audio', 'VU Meter stopped');
    });

    // Global error handler - Named handlers (cleanup icin)
    this.errorHandler = (e) => {
      // Lokasyonu belirle - önce e.filename'den dene
      let location = e.filename
        ? `${e.filename.split('/').pop()}:${e.lineno}:${e.colno}`
        : null;

      // Filename boşsa stack trace'den çıkar
      if (!location) {
        location = this._extractLocation(e.error?.stack);
      }

      location = location || 'unknown';

      const errorInfo = {
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno,
        stack: e.error?.stack
      };

      // Log panelinde ANLAMLI mesaj gorsun: "Cannot read property 'x' @ app.js:123:45"
      this.log('error', `${e.message} @ ${location}`, errorInfo);
    };

    this.rejectionHandler = (e) => {
      const reason = e.reason?.message || String(e.reason);

      // Stack trace'den lokasyon çıkar
      const location = this._extractLocation(e.reason?.stack) || 'unknown';

      const errorInfo = {
        stack: e.reason?.stack
      };

      this.log('error', `Promise Rejected: ${reason} @ ${location}`, errorInfo);
    };

    window.addEventListener('error', this.errorHandler);
    window.addEventListener('unhandledrejection', this.rejectionHandler);
  }

  /**
   * Event listener'lari temizle (memory leak onleme)
   * Not: LogManager singleton oldugu icin normalde cagrilmaz,
   * ama test/hot-reload senaryolari icin mevcut.
   */
  cleanup() {
    if (this.errorHandler) {
      window.removeEventListener('error', this.errorHandler);
    }
    if (this.rejectionHandler) {
      window.removeEventListener('unhandledrejection', this.rejectionHandler);
    }
    this.log('system', 'LogManager cleanup complete');
  }

  log(category, message, details = null) {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      sessionId: this.sessionId,
      category,
      message,
      details
    };

    // Bellekte sakla
    if (this.logs[category]) {
      this.logs[category].push(entry);

      // Bellek korumasi - eski loglari sil (FIFO)
      if (this.logs[category].length > LOG.MAX_PER_CATEGORY) {
        this.logs[category].shift();
      }
    }

    // IndexedDB'ye kaydet
    this.saveToDB(entry);

    // Console'a yaz (dev only — prod'da sadece error/warning)
    const consolePrefix = `[${category.toUpperCase()}]`;
    if (category === 'error') {
      console.error(consolePrefix, message, details || '');
    } else if (category === 'warning') {
      if (details) {
        console.warn(consolePrefix, message, details);
      } else {
        console.warn(consolePrefix, message);
      }
    } else if (IS_DEV) {
      if (details) {
        console.log(consolePrefix, message, details);
      } else {
        console.log(consolePrefix, message);
      }
    }

    // UI log event'i gonder (sadece onemli kategoriler)
    if (['error', 'warning', 'recorder', 'webaudio', 'stream'].includes(category)) {
      eventBus.emit(EVENTS.LOG_DISPLAY, { category, message, timestamp });
    }
  }

  async saveToDB(entry) {
    if (!this.db) return;

    try {
      const tx = this.db.transaction(['logs'], 'readwrite');
      const store = tx.objectStore('logs');
      store.add(entry);
    } catch (err) {
      if (IS_DEV) console.warn('[LogManager] DB write error:', err);
    }
  }

  // Kategoriye gore log al
  getByCategory(category) {
    return this.logs[category] || [];
  }

  // Tum loglari al
  getAll() {
    return { ...this.logs };
  }

  // Session loglarini al
  getSessionLogs() {
    const all = [];
    Object.keys(this.logs).forEach(cat => {
      this.logs[cat].forEach(entry => all.push(entry));
    });
    return all.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  /**
   * Log akisini mantiksal olarak kontrol eder ve supheli durumlari raporlar.
   * Bu fonksiyon debug amaclidir; is akisina etkisi yoktur.
   */
  getSanityReport() {
    const entries = this.getSessionLogs();

    const issues = [];
    const addIssue = (severity, code, message, details = {}) => {
      issues.push({ severity, code, message, details });
    };

    let lastWebAudioEnabled = null;
    let recordingActive = false;
    let monitoringActive = false;
    let streamBalance = 0;

    for (const entry of entries) {
      const category = entry?.category;
      const message = entry?.message;
      const details = entry?.details || {};

      if (category === 'webaudio' && details?.setting === 'webAudioEnabled') {
        lastWebAudioEnabled = !!details.value;
      }

      if (category === 'stream' && message === 'Stream started') {
        streamBalance += 1;
      }
      if (category === 'stream' && message === 'Stream stopped') {
        streamBalance -= 1;
        if (streamBalance < 0) {
          addIssue('warn', 'STREAM_BALANCE_NEGATIVE', 'Stream stopped count exceeds started count', {
            streamBalance
          });
          streamBalance = 0;
        }
      }

      // UI aksiyon loglari - detayi kontrol et
      // NOT: MonitoringController log format: { webAudioEnabled, loopbackEnabled, pipeline, pipelineDesc }
      if (category === 'stream' && message === 'Monitor Start button pressed') {
        const { webAudioEnabled, loopbackEnabled, pipeline, pipelineDesc } = details;
        // WebAudio kapaliyken pipeline 'direct' olmali
        if (webAudioEnabled === false && pipeline && pipeline !== PIPELINE_TYPES.DIRECT) {
          addIssue('error', 'MONITOR_MODE_MISMATCH', 'WebAudio Pipeline is INACTIVE but pipeline is not direct', {
            webAudioEnabled,
            pipeline,
            loopbackEnabled
          });
        }
        // Loopback aktifken pipelineDesc 'WebRTC Loopback' icermeli
        if (loopbackEnabled === true && typeof pipelineDesc === 'string' && !pipelineDesc.includes('WebRTC Loopback')) {
          addIssue('warn', 'PIPELINE_LABEL_MISMATCH', 'Loopback is active but pipelineDesc does not contain WebRTC Loopback', {
            pipeline,
            pipelineDesc
          });
        }
      }

      // Monitor eventleri (LogManager tarafindan olusturulan)
      if (message === 'Monitor started') {
        const delaySeconds = details?.delaySeconds;
        if (!(Number.isFinite(delaySeconds) && delaySeconds > 0)) {
          addIssue('warn', 'MONITOR_DELAY_MISSING', 'Monitor started but delaySeconds log detail is missing/invalid', {
            delaySeconds,
            mode: details?.mode,
            loopback: !!details?.loopback
          });
        } else if (Math.abs(delaySeconds - DELAY.DEFAULT_SECONDS) > 0.01) {
          addIssue('warn', 'MONITOR_DELAY_UNEXPECTED', `Monitor delay is not at expected value (expected: ${DELAY.DEFAULT_SECONDS}s)`, {
            delaySeconds,
            expected: DELAY.DEFAULT_SECONDS,
            mode: details?.mode,
            loopback: !!details?.loopback
          });
        }

        if (recordingActive) {
          addIssue('error', 'CONCURRENT_RECORD_AND_MONITOR', 'Monitor started but recording appears already active', {
            mode: details?.mode,
            loopback: !!details?.loopback
          });
        }
        monitoringActive = true;
      }

      if (message === 'Monitor stopped') {
        monitoringActive = false;
      }

      // Tum encoder tiplerine gore kayit baslangici tespit et
      const recorderStartMessages = ['MediaRecorder started', 'WASM Opus encoder started', 'PCM/WAV encoder started'];
      if (category === 'recorder' && recorderStartMessages.includes(message)) {
        if (monitoringActive) {
          addIssue('error', 'CONCURRENT_MONITOR_AND_RECORD', 'Recording started but monitoring appears already active', {
            lastWebAudioEnabled
          });
        }
        recordingActive = true;
      }

      // Tum encoder tiplerine gore kayit bitisi tespit et
      const recorderStopMessages = ['MediaRecorder stopped', 'WASM Opus encoder stopped', 'PCM/WAV encoder stopped'];
      if (category === 'recorder' && recorderStopMessages.includes(message)) {
        recordingActive = false;
      }
    }

    // NOT: runSanityChecks() aktif session sirasinda cagrilabilir
    // Bu durumda aktif kayit/monitor normal bir durumdur, hata degil
    if (recordingActive) {
      addIssue('info', 'RECORDING_ACTIVE', 'Recording is active (still running during check)', {});
    }
    if (monitoringActive) {
      addIssue('info', 'MONITORING_ACTIVE', 'Monitoring is active (still running during check)', {});
    }
    if (streamBalance !== 0) {
      addIssue('warn', 'STREAM_BALANCE_NONZERO', 'Stream start/stop balance is not zero at session end', { streamBalance });
    }

    return {
      ok: issues.length === 0,
      issues,
      summary: {
        lastWebAudioEnabled,
        streamBalance,
        recordingActive,
        monitoringActive,
        totalEntries: entries.length
      }
    };
  }

  /**
   * JSON verisini dosya olarak indirir
   * @param {Object} data - JSON olarak export edilecek veri
   * @param {string} filename - Dosya adi
   */
  _downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();

    URL.revokeObjectURL(url);
  }

  // Loglari JSON olarak export et
  exportJSON() {
    const filename = `mic-probe-logs-${this.sessionId}.json`;
    this._downloadJSON({
      sessionId: this.sessionId,
      exportedAt: new Date().toISOString(),
      logs: this.logs
    }, filename);
    this.log('system', 'Logs exported', { filename });
  }

  // Kategoriye gore export
  exportCategory(category) {
    this._downloadJSON({
      sessionId: this.sessionId,
      category,
      exportedAt: new Date().toISOString(),
      logs: this.logs[category] || []
    }, `mic-probe-${category}-${this.sessionId}.json`);
  }

  // Loglari temizle
  clear(category = null) {
    if (category) {
      this.logs[category] = [];
    } else {
      Object.keys(this.logs).forEach(cat => {
        this.logs[cat] = [];
      });
    }
    this.log('system', category ? `${category} logs cleared` : 'All logs cleared');
  }

  // Istatistikler
  getStats() {
    const stats = {};
    Object.keys(this.logs).forEach(cat => {
      stats[cat] = this.logs[cat].length;
    });
    stats.total = Object.values(stats).reduce((a, b) => a + b, 0);
    return stats;
  }
}

// Singleton export
const logManager = new LogManager();
export { LOG_CATEGORIES };
export default logManager;
