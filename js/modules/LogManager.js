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
import { DELAY, LOG } from './constants.js';

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

    this.log('system', 'LogManager baslatildi', { sessionId: this.sessionId });
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
      console.warn(`[LogManager] ${window.__earlyErrors.length} erken hata islendi`);
      window.__earlyErrors = []; // Temizle
    }
  }

  async initDB() {
    try {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        console.warn('[LogManager] IndexedDB acilamadi, sadece bellek kullanilacak');
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
        this.log('system', 'IndexedDB baglantisi basarili');
      };
    } catch (err) {
      console.warn('[LogManager] IndexedDB hatasi:', err);
    }
  }

  bindEvents() {
    // Genel log event'i
    eventBus.on('log', (msg) => this.log('ui', msg));

    // Kategorili event'ler
    eventBus.on('log:error', (data) => this.log('error', data.message, data.details));
    eventBus.on('log:audio', (data) => this.log('audio', data.message, data.details));
    eventBus.on('log:stream', (data) => this.log('stream', data.message, data.details));
    eventBus.on('log:webaudio', (data) => this.log('webaudio', data.message, data.details));
    eventBus.on('log:recorder', (data) => this.log('recorder', data.message, data.details));
    eventBus.on('log:system', (data) => this.log('system', data.message, data.details));
    eventBus.on('log:ui', (data) => this.log('ui', data.message, data.details));
    eventBus.on('log:warning', (data) => {
      // Warning'lar ayri kategoride (console'da turuncu)
      this.log('warning', data.message, data.details);
    });

    // Stream event'leri
    eventBus.on('stream:started', (stream) => {
      const track = stream?.getAudioTracks()[0];
      this.log('stream', 'Stream baslatildi', {
        trackId: track?.id,
        trackLabel: track?.label,
        trackSettings: track?.getSettings()
      });
    });

    eventBus.on('stream:stopped', () => {
      this.log('stream', 'Stream durduruldu');
    });

    // Recorder event'leri (encoder-agnostic)
    eventBus.on('recorder:started', (details) => {
      const encoder = details?.encoder || 'unknown';
      const msg = encoder === 'wasm-opus'
        ? 'WASM Opus encoder baslatildi'
        : encoder === 'pcm-wav'
          ? 'PCM/WAV encoder baslatildi'
          : 'MediaRecorder baslatildi';
      this.log('recorder', msg, details || null);
    });

    eventBus.on('recorder:stopped', (details) => {
      const encoder = details?.encoder || 'unknown';
      const msg = encoder === 'wasm-opus'
        ? 'WASM Opus encoder durduruldu'
        : encoder === 'pcm-wav'
          ? 'PCM/WAV encoder durduruldu'
          : 'MediaRecorder durduruldu';
      this.log('recorder', msg, details || null);
    });

    eventBus.on('recording:completed', (data) => {
      this.log('recorder', 'Kayit tamamlandi', {
        filename: data.filename,
        size: data.blob?.size,
        mimeType: data.mimeType
      });
    });

    // Monitor event'leri
    eventBus.on('monitor:started', (data) => {
      const mode = data?.mode;
      const category = (data?.loopback || mode === 'direct') ? 'stream' : 'webaudio';
      this.log(category, 'Monitor baslatildi', {
        mode,
        delaySeconds: data?.delaySeconds,
        loopback: !!data?.loopback
      });
    });

    eventBus.on('monitor:stopped', (data) => {
      const mode = data?.mode;
      const category = (data?.loopback || mode === 'direct') ? 'stream' : 'webaudio';
      this.log(category, 'Monitor durduruldu', { mode, loopback: !!data?.loopback });
    });

    // VU Meter event'leri (sadece onemli olanlar)
    eventBus.on('vumeter:started', () => {
      this.log('audio', 'VU Meter baslatildi');
    });

    eventBus.on('vumeter:stopped', () => {
      this.log('audio', 'VU Meter durduruldu');
    });

    // Global error handler - Named handlers (cleanup icin)
    this.errorHandler = (e) => {
      // Lokasyonu belirle - önce e.filename'den dene
      let location = e.filename
        ? `${e.filename.split('/').pop()}:${e.lineno}:${e.colno}`
        : null;

      // Filename boşsa stack trace'den çıkar
      if (!location && e.error?.stack) {
        // Format 1: "at functionName (http://...:line:col)"
        const stackMatch = e.error.stack.match(/at\s+.*?\s+\((.+?):(\d+):(\d+)\)/);
        if (stackMatch) {
          const [, file, line, col] = stackMatch;
          location = `${file.split('/').pop()}:${line}:${col}`;
        } else {
          // Format 2: "at http://...:line:col"
          const altMatch = e.error.stack.match(/at\s+(.+?):(\d+):(\d+)/);
          if (altMatch) {
            const [, file, line, col] = altMatch;
            location = `${file.split('/').pop()}:${line}:${col}`;
          }
        }
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
      let location = 'unknown';
      if (e.reason?.stack) {
        const stackMatch = e.reason.stack.match(/at\s+.*?\s+\((.+?):(\d+):(\d+)\)/);
        if (stackMatch) {
          const [, file, line, col] = stackMatch;
          location = `${file.split('/').pop()}:${line}:${col}`;
        } else {
          const altMatch = e.reason.stack.match(/at\s+(.+?):(\d+):(\d+)/);
          if (altMatch) {
            const [, file, line, col] = altMatch;
            location = `${file.split('/').pop()}:${line}:${col}`;
          }
        }
      }

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
    this.log('system', 'LogManager cleanup tamamlandi');
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

    // Console'a yaz (kisa versiyon)
    const consolePrefix = `[${category.toUpperCase()}]`;
    if (category === 'error') {
      console.error(consolePrefix, message, details || '');
    } else if (category === 'warning') {
      // Warning'lar turuncu gorunsun
      if (details) {
        console.warn(consolePrefix, message, details);
      } else {
        console.warn(consolePrefix, message);
      }
    } else if (details) {
      console.log(consolePrefix, message, details);
    } else {
      console.log(consolePrefix, message);
    }

    // UI log event'i gonder (sadece onemli kategoriler)
    if (['error', 'warning', 'recorder', 'webaudio', 'stream'].includes(category)) {
      eventBus.emit('log:display', { category, message, timestamp });
    }
  }

  async saveToDB(entry) {
    if (!this.db) return;

    try {
      const tx = this.db.transaction(['logs'], 'readwrite');
      const store = tx.objectStore('logs');
      store.add(entry);
    } catch (err) {
      console.warn('[LogManager] DB kayit hatasi:', err);
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

      if (category === 'stream' && message === 'Stream baslatildi') {
        streamBalance += 1;
      }
      if (category === 'stream' && message === 'Stream durduruldu') {
        streamBalance -= 1;
        if (streamBalance < 0) {
          addIssue('warn', 'STREAM_BALANCE_NEGATIVE', 'Stream durduruldu sayisi, baslatildi sayisindan fazla gorunuyor', {
            streamBalance
          });
          streamBalance = 0;
        }
      }

      // UI aksiyon loglari - detayi kontrol et
      // NOT: MonitoringController log format: { webAudioEnabled, loopbackEnabled, pipeline, pipelineDesc }
      if (category === 'stream' && message === 'Monitor Baslat butonuna basildi') {
        const { webAudioEnabled, loopbackEnabled, pipeline, pipelineDesc } = details;
        // WebAudio kapaliyken pipeline 'direct' olmali
        if (webAudioEnabled === false && pipeline && pipeline !== 'direct') {
          addIssue('error', 'MONITOR_MODE_MISMATCH', 'WebAudio Pipeline PASIF iken pipeline direct degil', {
            webAudioEnabled,
            pipeline,
            loopbackEnabled
          });
        }
        // Loopback aktifken pipelineDesc 'WebRTC Loopback' icermeli
        if (loopbackEnabled === true && typeof pipelineDesc === 'string' && !pipelineDesc.includes('WebRTC Loopback')) {
          addIssue('warn', 'PIPELINE_LABEL_MISMATCH', 'Loopback aktif ama pipelineDesc WebRTC Loopback icermiyor', {
            pipeline,
            pipelineDesc
          });
        }
      }

      // Monitor eventleri (LogManager tarafindan olusturulan)
      if (message === 'Monitor baslatildi') {
        const delaySeconds = details?.delaySeconds;
        if (!(Number.isFinite(delaySeconds) && delaySeconds > 0)) {
          addIssue('warn', 'MONITOR_DELAY_MISSING', 'Monitor basladi ama delaySeconds log detayi yok/hatali', {
            delaySeconds,
            mode: details?.mode,
            loopback: !!details?.loopback
          });
        } else if (Math.abs(delaySeconds - DELAY.DEFAULT_SECONDS) > 0.01) {
          addIssue('warn', 'MONITOR_DELAY_UNEXPECTED', `Monitor delay beklenen degerde degil (beklenen: ${DELAY.DEFAULT_SECONDS}s)`, {
            delaySeconds,
            expected: DELAY.DEFAULT_SECONDS,
            mode: details?.mode,
            loopback: !!details?.loopback
          });
        }

        if (recordingActive) {
          addIssue('error', 'CONCURRENT_RECORD_AND_MONITOR', 'Monitor basladi ama kayit hali hazirda aktif gorunuyor', {
            mode: details?.mode,
            loopback: !!details?.loopback
          });
        }
        monitoringActive = true;
      }

      if (message === 'Monitor durduruldu') {
        monitoringActive = false;
      }

      // Tum encoder tiplerine gore kayit baslangici tespit et
      const recorderStartMessages = ['MediaRecorder baslatildi', 'WASM Opus encoder baslatildi', 'PCM/WAV encoder baslatildi'];
      if (category === 'recorder' && recorderStartMessages.includes(message)) {
        if (monitoringActive) {
          addIssue('error', 'CONCURRENT_MONITOR_AND_RECORD', 'Kayit basladi ama monitoring hali hazirda aktif gorunuyor', {
            lastWebAudioEnabled
          });
        }
        recordingActive = true;
      }

      // Tum encoder tiplerine gore kayit bitisi tespit et
      const recorderStopMessages = ['MediaRecorder durduruldu', 'WASM Opus encoder durduruldu', 'PCM/WAV encoder durduruldu'];
      if (category === 'recorder' && recorderStopMessages.includes(message)) {
        recordingActive = false;
      }
    }

    // NOT: runSanityChecks() aktif session sirasinda cagrilabilir
    // Bu durumda aktif kayit/monitor normal bir durumdur, hata degil
    if (recordingActive) {
      addIssue('info', 'RECORDING_ACTIVE', 'Kayit aktif (check sirasinda devam ediyor)', {});
    }
    if (monitoringActive) {
      addIssue('info', 'MONITORING_ACTIVE', 'Monitoring aktif (check sirasinda devam ediyor)', {});
    }
    if (streamBalance !== 0) {
      addIssue('warn', 'STREAM_BALANCE_NONZERO', 'Session sonunda stream baslat/durdur dengesi sifir degil', { streamBalance });
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

  // Loglari JSON olarak export et
  exportJSON() {
    const data = {
      sessionId: this.sessionId,
      exportedAt: new Date().toISOString(),
      logs: this.logs
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `mic-probe-logs-${this.sessionId}.json`;
    a.click();

    URL.revokeObjectURL(url);
    this.log('system', 'Loglar export edildi', { filename: a.download });
  }

  // Kategoriye gore export
  exportCategory(category) {
    const data = {
      sessionId: this.sessionId,
      category,
      exportedAt: new Date().toISOString(),
      logs: this.logs[category] || []
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `mic-probe-${category}-${this.sessionId}.json`;
    a.click();

    URL.revokeObjectURL(url);
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
    this.log('system', category ? `${category} loglari temizlendi` : 'Tum loglar temizlendi');
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
