/**
 * Audio Helper Functions - AudioContext, MediaRecorder, Node management
 */
import eventBus from '../EventBus.js';
import { AUDIO, BYTES, VU_METER, EVENTS } from '../constants.js';

/**
 * AudioContext factory - Tek noktadan tutarli AudioContext olusturma
 * @param {Object} options - AudioContext options (sampleRate, etc.)
 * @returns {Promise<AudioContext>} - Hazir (resumed) AudioContext
 */
export async function createAudioContext(options = {}) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioContextCtor(options);

  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  return ctx;
}

/**
 * Stream'den AudioContext options olustur - Sample rate matching
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
 * MediaRecorder factory - MimeType fallback mantigi tek yerde
 * @param {MediaStream} stream - Kayit yapilacak stream
 * @param {Object} options - MediaRecorder options (audioBitsPerSecond vb.)
 * @returns {MediaRecorder} - Olusturulan MediaRecorder instance
 */
export function createMediaRecorder(stream, options = {}) {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
  let mimeType = '';
  if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
    for (const candidate of candidates) {
      try { if (MediaRecorder.isTypeSupported(candidate)) { mimeType = candidate; break; } } catch { /* ignore */ }
    }
  }

  const recorderOptions = { ...options };
  if (mimeType) recorderOptions.mimeType = mimeType;

  try {
    return new MediaRecorder(stream, recorderOptions);
  } catch {
    return new MediaRecorder(stream);
  }
}

/**
 * AudioNode array'ini guvenli sekilde disconnect et
 * @param {Array} nodes - Disconnect edilecek node'lar (node veya {node, name} formatinda)
 * @param {boolean} logEach - Her disconnect icin log emit et (default: false)
 */
export function disconnectNodes(nodes, logEach = false) {
  if (!nodes || !Array.isArray(nodes)) return;
  nodes.forEach(item => {
    const node = item?.node || item;
    const name = item?.name || 'AudioNode';
    if (!node) return;
    try {
      node.disconnect();
      if (logEach) {
        eventBus.emit(EVENTS.LOG_WEBAUDIO, {
          message: `${name} disconnect edildi`,
          details: {}
        });
      }
    } catch { /* Node zaten disconnect olmus */ }
  });
}

/**
 * Chrome/WebRTC: Remote stream'i aktive etmek icin Audio element olustur ve play et
 * @param {MediaStream} remoteStream - WebRTC remote stream
 * @param {string} context - Log mesajlari icin context
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
    eventBus.emit(EVENTS.LOG_STREAM, {
      message: `${context}: Activator audio baslatildi`,
      details: { paused: audio.paused, muted: audio.muted }
    });
  } catch (err) {
    eventBus.emit(EVENTS.LOG_WARNING, {
      message: `${context}: Activator audio hatasi (devam ediliyor)`,
      details: { error: err.message }
    });
  }

  return audio;
}

/**
 * Activator audio element'i temizle
 * @param {HTMLAudioElement|null} audio - Temizlenecek audio element
 */
export function cleanupActivatorAudio(audio) {
  if (!audio) return;
  try {
    audio.pause();
    audio.srcObject = null;
  } catch { /* ignore */ }
}

/**
 * Duration degerinin gecerli olup olmadigini kontrol eder
 * @param {number} duration - Kontrol edilecek duration
 * @returns {boolean} - Gecerli finite pozitif sayi ise true
 */
export function isValidDuration(duration) {
  return Number.isFinite(duration) && duration > 0;
}

/**
 * Blob boyutu ve sure'den gercek bitrate hesaplar
 * @param {number} blobSize - Blob boyutu (byte)
 * @param {number} durationMs - Kayit suresi (milisaniye)
 * @returns {{bps: number, kbps: string}} - Bitrate
 */
export function calculateActualBitrate(blobSize, durationMs) {
  const durationSec = durationMs / 1000;
  const bitrate = durationSec > 0 ? Math.round((blobSize * 8) / durationSec) : 0;
  return { bps: bitrate, kbps: (bitrate / 1000).toFixed(1) };
}

/**
 * AnalyserNode factory - VU Meter icin tutarli AnalyserNode olusturma
 * DRY: BasePipeline, Monitor, AudioEngine ayni 3 satiri kullaniyordu
 * @param {AudioContext} audioContext - AudioContext instance
 * @returns {AnalyserNode} - Konfigüre edilmiş AnalyserNode
 */
export function createAnalyserNode(audioContext) {
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = AUDIO.FFT_SIZE;
  analyser.smoothingTimeConstant = AUDIO.SMOOTHING_TIME_CONSTANT;
  return analyser;
}

// === Hesaplama Fonksiyonlari (constants.js'den taşındı) ===

/**
 * Byte'i KB'a cevir
 * @param {number} bytes
 * @returns {number} Kilobytes
 */
export const bytesToKB = (bytes) => bytes / BYTES.PER_KB;

/**
 * Buffer size'dan latency hesapla
 * @param {number} bufferSize - Buffer boyutu (samples)
 * @param {number} sampleRate - Sample rate (Hz)
 * @returns {number} Latency (ms)
 */
export const calculateLatencyMs = (bufferSize, sampleRate = AUDIO.DEFAULT_SAMPLE_RATE) =>
  (bufferSize / sampleRate) * 1000;

/**
 * RMS degerini dB'e cevir
 * @param {number} rms - RMS degeri (0-1 arasi)
 * @returns {number} dB degeri (MIN_DB ile 0 arasi)
 */
export const rmsToDb = (rms) =>
  rms > VU_METER.RMS_THRESHOLD ? 20 * Math.log10(rms) : VU_METER.MIN_DB;

/**
 * dB degerini yuzdeye cevir (VU meter icin)
 * @param {number} dB - dB degeri
 * @returns {number} Yuzde (0-100 arasi)
 */
export const dbToPercent = (dB) =>
  Math.max(0, Math.min(100, (dB - VU_METER.MIN_DB) / -VU_METER.MIN_DB * 100));

/**
 * Bitrate'i kbps formatina cevir
 * @param {number} bps - Bits per second
 * @returns {string} Formatli string (orn: "64 kbps")
 */
export const bitrateToKbps = (bps) => `${Math.round(bps / 1000)} kbps`;
