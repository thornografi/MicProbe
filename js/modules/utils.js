/**
 * Utils - Ortak yardimci fonksiyonlar
 */
import eventBus from './EventBus.js';

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
 * Ornek: 2025-01-09 07:05:03 -> "250109070503"
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
 * Tarayicida desteklenen en uygun audio MediaRecorder mimeType'i dondurur.
 * Amac: Testler arasinda daha tutarli codec/container secimi (tercihen Opus/WebM)
 * @returns {string} mimeType veya '' (bulunamadi)
 */
export function getBestAudioMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg'
  ];

  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }

  for (const mimeType of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
    } catch {
      // ignore
    }
  }

  return '';
}

/**
 * MediaStream'in tum track'lerini durdurur
 * DRY: Birden fazla yerde kullanilan stream temizleme islemi
 * @param {MediaStream} stream - Durdurulacak stream
 * @returns {void}
 */
export function stopStreamTracks(stream) {
  if (!stream) return;
  stream.getTracks().forEach(track => track.stop());
}

/**
 * AudioContext factory - DRY: Tek noktadan tutarli AudioContext olusturma
 * Sample rate matching, resume handling ve cross-browser uyumluluk saglar
 * @param {Object} options - AudioContext options (sampleRate, etc.)
 * @returns {Promise<AudioContext>} - Hazir (resumed) AudioContext
 */
export async function createAudioContext(options = {}) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioContextCtor(options);

  // AudioContext suspended olabilir (autoplay policy) - resume et
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  return ctx;
}

/**
 * Stream'den AudioContext options olustur - DRY: Sample rate matching
 * @param {MediaStream} stream - Kaynak stream
 * @returns {Object} - AudioContext options { sampleRate } veya {}
 */
export function getAudioContextOptions(stream) {
  if (!stream) return {};

  const track = stream.getAudioTracks()[0];
  const sampleRate = track?.getSettings()?.sampleRate;

  return sampleRate ? { sampleRate } : {};
}

/**
 * DOM element gorunurlugunu toggle et - DRY: UI state guncellemelerinde ortak
 * @param {HTMLElement} element - Hedef element
 * @param {boolean} shouldShow - Goster/gizle
 * @param {string} displayValue - Gosterilecek display degeri (default: 'block')
 */
export function toggleDisplay(element, shouldShow, displayValue = 'block') {
  if (element) {
    element.style.display = shouldShow ? displayValue : 'none';
  }
}

/**
 * Async event handler'lari try-catch ile sarar - DRY: Tekrarlayan error handling
 * OCP: Hata formati degismek istediginde tek yerden degisir
 * @param {Function} fn - Async handler fonksiyonu
 * @param {string} errorMessage - Hata mesaji
 * @returns {Function} - Try-catch ile sarili handler
 */
export function wrapAsyncHandler(fn, errorMessage) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      eventBus.emit('log:error', {
        message: errorMessage,
        details: { error: err.message, stack: err.stack }
      });
    }
  };
}

/**
 * MediaRecorder factory - DRY: MimeType fallback mantigi tek yerde
 * @param {MediaStream} stream - Kayit yapilacak stream
 * @param {Object} options - MediaRecorder options (audioBitsPerSecond vb.)
 * @returns {MediaRecorder} - Olusturulan MediaRecorder instance
 */
export function createMediaRecorder(stream, options = {}) {
  const mimeType = getBestAudioMimeType();
  const recorderOptions = { ...options };

  if (mimeType) {
    recorderOptions.mimeType = mimeType;
  }

  try {
    return new MediaRecorder(stream, recorderOptions);
  } catch {
    // Options desteklenmiyorsa fallback
    return new MediaRecorder(stream);
  }
}

// ═══════════════════════════════════════════════════════════════
// Error Message Helper (DRY - getUserMedia hatalari)
// ═══════════════════════════════════════════════════════════════

/**
 * getUserMedia hata kodlarini kullanici dostu mesaja cevir
 * DRY: Recorder, Monitor, MonitoringController ayni mapping'i kullanir
 * @param {Error} err - getUserMedia veya MediaRecorder hatasi
 * @returns {string} - Kullanici dostu hata mesaji
 */
export function getStreamErrorMessage(err) {
  const errorMap = {
    NotAllowedError: 'Microphone permission denied',
    NotFoundError: 'Microphone not found',
    NotReadableError: 'Microphone is being used by another application',
    OverconstrainedError: 'Unsupported microphone setting',
    AbortError: 'Microphone access was aborted',
    SecurityError: 'Microphone access blocked by security policy'
  };
  return errorMap[err.name] || err.message;
}

// ═══════════════════════════════════════════════════════════════
// Pipeline & Encoder Helper Functions (DRY - OCP)
// ═══════════════════════════════════════════════════════════════

/**
 * Pipeline'in buffer ayari gerektirip gerektirmedigini dondurur
 * ScriptProcessor kullanici tarafindan ayarlanabilir buffer'a sahip
 * @param {string} pipeline - Pipeline tipi
 * @returns {boolean}
 */
export function needsBufferSetting(pipeline) {
  return pipeline === 'scriptprocessor';
}

/**
 * Pipeline'in WebAudio kullanip kullanmadigini dondurur
 * direct harici tum pipeline'lar WebAudio kullaniyor
 * @param {string} pipeline - Pipeline tipi
 * @returns {boolean}
 */
export function usesWebAudio(pipeline) {
  return pipeline !== 'direct';
}

/**
 * Encoder'in WASM Opus kullanip kullanmadigini dondurur
 * @param {string} encoder - Encoder tipi
 * @returns {boolean}
 */
export function usesWasmOpus(encoder) {
  return encoder === 'wasm-opus';
}

/**
 * Encoder'in MediaRecorder kullanip kullanmadigini dondurur
 * @param {string} encoder - Encoder tipi
 * @returns {boolean}
 */
export function usesMediaRecorder(encoder) {
  return encoder === 'mediarecorder';
}

/**
 * Pipeline'in WASM Opus encoder'i destekleyip desteklemedigini dondurur
 * WASM Opus ScriptProcessor ve Worklet pipeline'larinda calisir (PCM data gerektirir)
 * Direct ve Standard'da PCM erisimi yok, WASM Opus kullanilamaz
 * @param {string} pipeline - Pipeline tipi
 * @returns {boolean}
 */
export function supportsWasmOpusEncoder(pipeline) {
  return pipeline === 'scriptprocessor' || pipeline === 'worklet';
}

/**
 * Timeslice ayarinin disabled olmasi gerekip gerekmedigi
 * MediaRecorder kullanilmiyorsa timeslice anlamsiz
 * @param {boolean} loopbackOn - Loopback toggle durumu
 * @param {string} encoder - Encoder tipi
 * @returns {boolean} - true ise disabled olmali
 */
export function shouldDisableTimeslice(loopbackOn, encoder) {
  return loopbackOn || !usesMediaRecorder(encoder);
}

/**
 * SettingTypeHandlers - OCP uyumlu setting type registry
 * Yeni tip eklemek icin sadece register() cagirmak yeterli
 *
 * OCP: Open for extension (yeni tipler), Closed for modification (mevcut kod)
 */
export const SettingTypeHandlers = {
  _handlers: {},

  /**
   * Yeni tip handler kaydet
   * @param {string} type - Setting tipi (boolean, enum, range, vb.)
   * @param {Object} handler - { group, render } metodlari
   */
  register(type, handler) {
    this._handlers[type] = handler;
  },

  /**
   * Tip icin handler dondur
   * @param {string} type
   * @returns {Object|null}
   */
  get(type) {
    return this._handlers[type] || null;
  },

  /**
   * Tum kayitli tipleri dondur
   * @returns {string[]}
   */
  getTypes() {
    return Object.keys(this._handlers);
  }
};

// Boolean handler - checkbox olarak render edilir
SettingTypeHandlers.register('boolean', {
  group: 'booleans',
  render({ key, setting, isLocked, currentValue }) {
    const statusClass = isLocked ? 'locked' : 'editable';
    return `<div class="custom-setting-item ${statusClass}">
      <input type="checkbox" ${currentValue ? 'checked' : ''} ${isLocked ? 'disabled' : ''} data-setting="${key}">
      <span class="setting-name">${setting.label || key}</span>
    </div>`;
  }
});

// Enum handler - select olarak render edilir
SettingTypeHandlers.register('enum', {
  group: 'enums',
  render({ key, setting, isLocked, currentValue, allowedValues, formatValue }) {
    const statusClass = isLocked ? 'locked' : 'editable';
    const values = allowedValues || setting.values;
    let options = '';
    values.forEach(val => {
      const selected = val === currentValue ? 'selected' : '';
      options += `<option value="${val}" ${selected}>${formatValue(val, key)}</option>`;
    });
    return `<div class="custom-setting-item ${statusClass}">
      <select ${isLocked ? 'disabled' : ''} data-setting="${key}">${options}</select>
      <span class="setting-name">${setting.label || key}</span>
    </div>`;
  }
});

// ═══════════════════════════════════════════════════════════════
// Activator Audio Helper Functions (DRY - WebRTC Remote Stream)
// ═══════════════════════════════════════════════════════════════

/**
 * Chrome/WebRTC: Remote stream'i aktive etmek icin Audio element olustur ve play et
 * NOT: Chrome'da MediaStream, bir Audio element'te play() cagrilmadan aktif olmuyor
 * DRY: LoopbackManager ve MonitoringController ayni pattern'i kullaniyor
 * @param {MediaStream} remoteStream - WebRTC remote stream
 * @param {string} context - Log mesajlari icin context (ornek: 'Loopback Monitor', 'Test')
 * @returns {Promise<HTMLAudioElement>} - Olusturulan activator audio element
 */
export async function createAndPlayActivatorAudio(remoteStream, context = 'loopback') {
  const audio = document.createElement('audio');
  audio.srcObject = remoteStream;
  audio.muted = true;
  audio.volume = 0;
  audio.playsInline = true;

  try {
    await audio.play();
    eventBus.emit('log:stream', {
      message: `${context}: Activator audio baslatildi`,
      details: { paused: audio.paused, muted: audio.muted }
    });
  } catch (err) {
    eventBus.emit('log:warning', {
      message: `${context}: Activator audio hatasi (devam ediliyor)`,
      details: { error: err.message }
    });
  }

  return audio;
}

/**
 * Activator audio element'i temizle
 * DRY: Ayni temizlik mantigi birden fazla yerde tekrarlaniyor
 * @param {HTMLAudioElement|null} audio - Temizlenecek audio element
 */
export function cleanupActivatorAudio(audio) {
  if (!audio) return;
  try {
    audio.pause();
    audio.srcObject = null;
  } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════
// PCM/WAV Helper Functions (Raw Recording)
// ═══════════════════════════════════════════════════════════════

/**
 * Encoder'in PCM/WAV kullanip kullanmadigini dondurur
 * @param {string} encoder - Encoder tipi
 * @returns {boolean}
 */
export function usesPcmWav(encoder) {
  return encoder === 'pcm-wav';
}

// ═══════════════════════════════════════════════════════════════
// Duration & Bitrate Helper Functions (DRY - Player/Recorder)
// ═══════════════════════════════════════════════════════════════

/**
 * Duration degerinin gecerli olup olmadigini kontrol eder
 * Number.isFinite() kullanir (global isFinite'dan daha strict)
 * @param {number} duration - Kontrol edilecek duration
 * @returns {boolean} - Gecerli finite pozitif sayi ise true
 */
export function isValidDuration(duration) {
  return Number.isFinite(duration) && duration > 0;
}

/**
 * Blob boyutu ve sure'den gercek bitrate hesaplar
 * DRY: Recorder.js'de 3 yerde ayni hesaplama yapiliyor
 * @param {number} blobSize - Blob boyutu (byte)
 * @param {number} durationMs - Kayit suresi (milisaniye)
 * @returns {{bps: number, kbps: string}} - Bitrate (bps ve kbps formatinda)
 */
export function calculateActualBitrate(blobSize, durationMs) {
  const durationSec = durationMs / 1000;
  const bitrate = durationSec > 0 ? Math.round((blobSize * 8) / durationSec) : 0;
  return { bps: bitrate, kbps: (bitrate / 1000).toFixed(1) };
}

/**
 * Float32 PCM data'yi Int16'ya donustur
 * -1.0...1.0 araligini -32768...32767 araligina map eder
 * @param {Float32Array} float32Array - Kaynak PCM data
 * @returns {Int16Array} - 16-bit PCM data
 */
export function float32ToInt16(float32Array) {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    // Clamp to -1.0...1.0 range
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    // Convert to 16-bit integer
    int16Array[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
  }
  return int16Array;
}

/**
 * WAV dosya header'i olustur (44 byte)
 * @param {number} dataLength - PCM data uzunlugu (byte cinsinden)
 * @param {number} sampleRate - Ornekleme hizi (Hz)
 * @param {number} channels - Kanal sayisi (1=mono, 2=stereo)
 * @param {number} bitsPerSample - Bit derinligi (16)
 * @returns {ArrayBuffer} - 44 byte WAV header
 */
export function createWavHeader(dataLength, sampleRate, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true); // File size - 8
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);  // AudioFormat (1 = PCM)
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  return buffer;
}

/**
 * DataView'a string yaz (WAV header icin)
 * @private
 */
function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Float32 PCM data'dan WAV blob olustur
 * @param {Float32Array[]} pcmChunks - PCM data chunk'lari
 * @param {number} sampleRate - Ornekleme hizi
 * @param {number} channels - Kanal sayisi
 * @returns {Blob} - WAV formatinda blob
 */
export function createWavBlob(pcmChunks, sampleRate, channels = 1) {
  // Tum chunk'lari birlestir
  const totalLength = pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const mergedFloat32 = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of pcmChunks) {
    mergedFloat32.set(chunk, offset);
    offset += chunk.length;
  }

  // Float32 -> Int16 donusumu
  const int16Data = float32ToInt16(mergedFloat32);

  // WAV header olustur
  const dataLength = int16Data.length * 2; // 2 bytes per sample (16-bit)
  const header = createWavHeader(dataLength, sampleRate, channels, 16);

  // Header + Data birlestir
  return new Blob([header, int16Data.buffer], { type: 'audio/wav' });
}
