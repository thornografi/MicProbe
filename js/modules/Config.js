/**
 * Config - Merkezi yapilandirma modulu
 * Ayar tanimlari ve profil degerleri
 */

// Ayar tanimlari (metadata + UI binding)
export const SETTINGS = {
  // Mikrofon constraints
  ec: {
    type: 'boolean',
    default: true,
    label: 'Echo Cancellation',
    category: 'constraints',
    ui: { type: 'checkbox', id: 'ec' }
  },
  ns: {
    type: 'boolean',
    default: true,
    label: 'Noise Suppression',
    category: 'constraints',
    ui: { type: 'checkbox', id: 'ns' }
  },
  agc: {
    type: 'boolean',
    default: true,
    label: 'Auto Gain Control',
    category: 'constraints',
    ui: { type: 'checkbox', id: 'agc' }
  },
  sampleRate: {
    type: 'enum',
    values: [16000, 24000, 44100, 48000],  // Opus-uyumlu + 44100 (yaygin Windows mik default'u)
    default: 48000,
    label: 'Sample Rate',
    category: 'constraints',
    unit: 'Hz',
    ui: { type: 'radio', name: 'sampleRate' }
  },
  channelCount: {
    type: 'enum',
    values: [1, 2],
    default: 1,
    label: 'Channel Count',
    category: 'constraints',
    labels: { 1: 'Mono', 2: 'Stereo' },
    ui: { type: 'radio', name: 'channelCount' }
  },

  // Ses Isleme Pipeline (WebAudio graph)
  // direct: WebAudio yok, ham MediaStream
  // standard: WebAudio basit graph (Source -> Destination)
  // scriptprocessor: WebAudio + ScriptProcessorNode (eski API, buffer ayarlanabilir)
  // worklet: WebAudio + AudioWorkletNode (modern API, sabit 128 sample)
  pipeline: {
    type: 'enum',
    values: ['direct', 'standard', 'scriptprocessor', 'worklet'],
    default: 'standard',
    label: 'Pipeline',
    category: 'pipeline',
    labels: {
      direct: 'Direct (No Web Audio)',
      standard: 'Direct (WebAudio)',
      scriptprocessor: 'ScriptProcessorNode (WebAudio)',
      worklet: 'Worklet (WebAudio)'
    },
    ui: { type: 'radio', name: 'pipeline' }
  },

  // Encoder (Kayit formati)
  // mediarecorder: Tarayici MediaRecorder API (varsayilan codec)
  // wasm-opus: WASM Opus encoder (WhatsApp Web pattern)
  // pcm-wav: Raw PCM 16-bit WAV (sifir compression)
  encoder: {
    type: 'enum',
    values: ['mediarecorder', 'wasm-opus', 'pcm-wav'],
    default: 'mediarecorder',
    label: 'Encoder',
    category: 'pipeline',
    labels: {
      mediarecorder: 'MediaRecorder',
      'wasm-opus': 'WASM Opus',
      'pcm-wav': 'PCM/WAV (Raw)'
    },
    ui: { type: 'radio', name: 'encoder' }
  },
  buffer: {
    type: 'enum',
    values: [1024, 2048, 4096],
    default: 4096,
    label: 'Buffer Size',
    category: 'pipeline',
    unit: 'samples',
    ui: { type: 'radio', name: 'bufferSize' }
  },

  // Loopback (WebRTC)
  loopback: {
    type: 'boolean',
    default: true,
    label: 'WebRTC Loopback',
    category: 'loopback',
    ui: { type: 'toggle', id: 'loopbackToggle' }
  },
  bitrate: {
    type: 'enum',
    values: [16000, 24000, 32000, 48000, 64000, 96000, 128000, 192000, 256000, 384000],  // Discord Nitro: 256k, 384k; Zoom Hi-Fi stereo: 192k
    default: 64000,
    label: 'Opus Bitrate (WebRTC)',
    category: 'loopback',
    unit: 'bps',
    ui: { type: 'radio', name: 'bitrate' }
  },

  // Ses bitrate (MediaRecorder veya WASM Opus encoder icin)
  mediaBitrate: {
    type: 'enum',
    values: [0, 16000, 24000, 32000, 64000, 128000],
    default: 0,
    label: 'Voice Message Bitrate',
    category: 'recording',
    unit: 'bps',
    ui: { type: 'radio', name: 'mediaBitrate' }
  },

  // Kayit
  timeslice: {
    type: 'enum',
    values: [0, 100, 250, 500, 1000],
    default: 0,
    label: 'Timeslice',
    category: 'recording',
    unit: 'ms',
    ui: { type: 'radio', name: 'timeslice' }
  }
  // NOT: delay ayari kaldirildi - monitoring'de sabit 1.7sn kullaniliyor (constants.js → DELAY.DEFAULT_SECONDS)
};

// Varsayilan profil degerleri
// DRY: SETTINGS.*.default'dan otomatik türetilir (manuel sync gereksiz)
const DEFAULT_VALUES = Object.fromEntries(
  Object.entries(SETTINGS).map(([key, setting]) => [key, setting.default])
);

// Profil fabrika fonksiyonu - tekrari onler
// settings objesi: { locked: [], editable: [], allowedValues: [], detection: {} } veya 'all' string'i
// locked: Deger sabit, UI'da disabled (kullanici degistiremez)
// editable: Kullanici degistirebilir
// allowedValues: Her ayar icin izin verilen degerler (profil bazli kisitlama)
// detection: Teknoloji tespit bilgisi { method, source, details }
// 'all': Tum ayarlar editable, tum degerler izinli (test modlari icin)
function createProfile(id, label, desc, icon, category, overrides = {}, settings = {}) {
  // Geriye uyumluluk: Eski array format veya 'all' string destegi
  let lockedSettings = [];
  let editableSettings = [];
  let allowedValues = {};

  if (settings === 'all') {
    // Tum ayarlar editable, tum degerler izinli
    editableSettings = Object.keys(SETTINGS);
    lockedSettings = [];
    allowedValues = {}; // Bos = tum degerler izinli
  } else if (Array.isArray(settings)) {
    // Eski format: array = editable listesi (geriye uyumluluk)
    editableSettings = settings;
    lockedSettings = [];
    allowedValues = {};
  } else {
    // Yeni format: { locked: [], editable: [], allowedValues: {} }
    lockedSettings = settings.locked || [];
    editableSettings = settings.editable || [];
    allowedValues = settings.allowedValues || {};
  }

  // OCP: Profil kendi yeteneklerini biliyor
  // call kategorisi = monitoring, record kategorisi = kayit
  // Istisna: loopback editable ise monitoring de yapilabilir
  const isCallCategory = category === 'call';
  const loopbackEditable = settings === 'all' || editableSettings.includes('loopback');

  // Detection bilgisi (opsiyonel)
  const detection = settings.detection || null;

  return {
    id, label, desc, icon, category,
    values: overrides === null ? null : { ...DEFAULT_VALUES, ...overrides },
    lockedSettings,
    editableSettings,
    allowedValues, // Profil bazli deger kisitlamalari
    detection, // Teknoloji tespit detaylari
    // OCP: Yetenekler profilde tanimli
    canMonitor: isCallCategory || loopbackEditable,
    canRecord: !isCallCategory,
    // Geriye uyumluluk
    allowedSettings: editableSettings.length > 0 ? editableSettings : 'all'
  };
}

// Davranis bazli profil tanimlari
// İKİ ANA KATEGORİ: call (sesli görüşme) ve record (kayıt)
export const PROFILES = {
  // ═══════════════════════════════════════════════════════════════
  // 📞 SESLİ GÖRÜŞME (call) - WebRTC Loopback, Test primary + Monitor advanced
  // ═══════════════════════════════════════════════════════════════
  // Call profilleri platform klonu degil, duyulur codec/DSP davranisi yaklasimidir.
  'discord': createProfile('discord', 'Discord Voice', 'Discord-style voice channel with Krisp-like processing and higher Opus bitrate range',
    'gamepad', 'call', { ec: true, ns: true, agc: true, loopback: true, pipeline: 'worklet', encoder: 'mediarecorder', bitrate: 64000, sampleRate: 48000, channelCount: 1 },
    { locked: ['loopback', 'pipeline', 'encoder', 'sampleRate', 'channelCount', 'ec', 'ns', 'agc'],
      editable: ['bitrate'],
      allowedValues: { bitrate: [64000, 96000, 128000, 256000, 384000] },
      detection: { method: 'AudioWorklet + WebRTC', source: 'local approximation', details: 'Discord-style Opus bitrate test with browser noise processing; not an exact Discord client clone' } }),

  'meeting-call': createProfile('meeting-call', 'Meeting Call', 'Default browser meeting call approximation for Zoom, Google Meet, and Microsoft Teams',
    'video', 'call', { ec: true, ns: true, agc: true, loopback: true, pipeline: 'worklet', encoder: 'mediarecorder', bitrate: 48000, sampleRate: 48000, channelCount: 1 },
    { locked: ['loopback', 'pipeline', 'encoder', 'channelCount', 'ec', 'ns', 'agc'],
      editable: ['bitrate', 'sampleRate'],
      allowedValues: { bitrate: [32000, 48000, 64000], sampleRate: [16000, 24000, 48000] },
      detection: { method: 'AudioWorklet + WebRTC', source: 'local approximation', details: 'Default meeting-call behavior: mono Opus with browser EC/NS/AGC enabled' } }),

  'zoom-hifi': createProfile('zoom-hifi', 'Zoom High Fidelity', 'Zoom Original Sound / high fidelity music mode approximation',
    'music', 'call', { ec: false, ns: false, agc: false, loopback: true, pipeline: 'worklet', encoder: 'mediarecorder', bitrate: 96000, sampleRate: 48000, channelCount: 1 },
    { locked: ['loopback', 'pipeline', 'encoder', 'sampleRate', 'ec', 'ns', 'agc'],
      editable: ['bitrate', 'channelCount'],
      allowedValues: { bitrate: [96000, 128000, 192000], channelCount: [1, 2] },
      detection: { method: 'AudioWorklet + WebRTC', source: 'local approximation', details: 'High-fidelity meeting mode: 48kHz, higher Opus bitrate, browser EC/NS/AGC disabled' } }),

  'whatsapp-telegram-call': createProfile('whatsapp-telegram-call', 'WhatsApp / Telegram Call', 'Practical test for WhatsApp, Telegram, and similar app voice calls',
    'phone', 'call', { ec: true, ns: true, agc: true, loopback: true, pipeline: 'worklet', encoder: 'mediarecorder', bitrate: 24000, sampleRate: 48000, channelCount: 1 },
    { locked: ['loopback', 'pipeline', 'encoder', 'channelCount', 'ec', 'ns', 'agc'],
      editable: ['bitrate'],
      allowedValues: { bitrate: [16000, 24000, 32000, 48000] },
      detection: { method: 'WebRTC', source: 'local peerconnection', details: 'WhatsApp/Telegram call approximation; exact native app codecs are not reproduced' } }),

  // ═══════════════════════════════════════════════════════════════
  // 🎙️ KAYIT (record) - MediaRecorder, Recording Primary
  // ═══════════════════════════════════════════════════════════════
  'whatsapp-voice': createProfile('whatsapp-voice', 'WhatsApp Voice Message',
    'Legacy-style low bitrate Opus voice message approximation',
    'message', 'record', { mediaBitrate: 16000, timeslice: 0, loopback: false, pipeline: 'scriptprocessor', encoder: 'wasm-opus', buffer: 4096 },
    { locked: ['pipeline', 'encoder', 'buffer', 'timeslice'],
      editable: ['ec', 'ns', 'agc', 'mediaBitrate'],
      allowedValues: { mediaBitrate: [16000, 24000, 32000] },
      detection: { method: 'ScriptProcessor + WASM Opus', source: 'local encoder', details: 'Low bitrate voice-message approximation using the legacy ScriptProcessor path' } }),

  'telegram-voice': createProfile('telegram-voice', 'Telegram Voice Message',
    'Modern Opus voice message approximation with VBR support',
    'send', 'record', { mediaBitrate: 0, timeslice: 0, loopback: false, pipeline: 'worklet', encoder: 'wasm-opus', channelCount: 1 },
    { locked: ['pipeline', 'encoder', 'timeslice', 'channelCount'],
      editable: ['ec', 'ns', 'agc', 'mediaBitrate'],
      allowedValues: { mediaBitrate: [0, 16000, 24000, 32000] },  // 0 = VBR (varsayılan)
      detection: { method: 'AudioWorklet + WASM Opus', source: 'local encoder', details: 'Voice-message Opus path with VBR as a valid default mode' } }),

  'raw': createProfile('raw', 'Raw Recording', 'Worklet + PCM/WAV - uncompressed 16-bit WAV recording',
    'mic', 'record', { ec: false, ns: false, agc: false, pipeline: 'worklet', encoder: 'pcm-wav', loopback: false },
    { locked: ['pipeline', 'encoder'], editable: ['ec', 'ns', 'agc', 'sampleRate', 'channelCount'],
      detection: { method: 'AudioWorklet', source: 'pcm-wav', details: 'AudioWorkletNode + PCM/WAV (16-bit uncompressed)' } })
};

// Kategori tanimlari (UI siralama icin)
// Sadece iki ana kategori: call ve record
export const PROFILE_CATEGORIES = {
  call: {
    id: 'call',
    label: 'Voice Calls',
    icon: '📞',
    desc: 'Discord, meetings, Zoom Hi-Fi, WhatsApp/Telegram',
    order: 1
  },
  record: {
    id: 'record',
    label: 'Voice Messages',
    icon: '🎙️',
    desc: 'WhatsApp/Telegram voice messages, raw recording',
    order: 2
  }
};

// Profil bazli Tips mesajlari
// Her profil icin 3 adimlik rehber (tek satir)
export const PROFILE_TIPS = {
  // === CALL Category ===
  'discord': [
    { step: 1, text: 'Run a short Discord voice <strong>Test</strong>' },
    { step: 2, text: 'Play back the codec-processed audio' },
    { step: 3, text: 'Open the report for fixes' }
  ],
  'meeting-call': [
    { step: 1, text: 'Run a default meeting-call <strong>Test</strong>' },
    { step: 2, text: 'Try <strong>Sample Rate</strong> compatibility' },
    { step: 3, text: 'Review the report for fixes' }
  ],
  'zoom-hifi': [
    { step: 1, text: 'Run a high-fidelity meeting <strong>Test</strong>' },
    { step: 2, text: 'Compare mono/stereo and high bitrate' },
    { step: 3, text: 'Review clipping and room noise' }
  ],
  'whatsapp-telegram-call': [
    { step: 1, text: 'Run a WhatsApp / Telegram Call <strong>Test</strong>' },
    { step: 2, text: 'Check whether speech stays clear after heavier call compression' },
    { step: 3, text: 'Use the report to diagnose noise' }
  ],

  // === RECORD Category ===
  'whatsapp-voice': [
    { step: 1, text: 'Record voice message with <strong>Record</strong>' },
    { step: 2, text: 'Play back and hear WASM Opus quality' },
    { step: 3, text: 'Open the report for fixes' }
  ],
  'telegram-voice': [
    { step: 1, text: 'Make audio recording with <strong>Record</strong>' },
    { step: 2, text: 'Play back and compare quality' },
    { step: 3, text: 'Review the report for fixes' }
  ],
  'raw': [
    { step: 1, text: 'Make raw recording with <strong>Record</strong>' },
    { step: 2, text: 'Compare with other profiles' },
    { step: 3, text: 'Use the report as a clean baseline' }
  ],

  // Default (fallback)
  'default': [
    { step: 1, text: 'Select a profile from the sidebar' },
    { step: 2, text: 'Run a <strong>Test</strong> or make a <strong>Record</strong>' },
    { step: 3, text: 'Review the report and fixes' }
  ]
};

export default {
  SETTINGS,
  PROFILES,
  PROFILE_CATEGORIES,
  PROFILE_TIPS
};
