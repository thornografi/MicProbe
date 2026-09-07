/**
 * Config - Merkezi yapilandirma modulu
 * Ayar tanimlari ve profil degerleri
 */
import { PIPELINE_TYPES, ENCODER_TYPES } from './constants.js';

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
  // direct: Kayit ham MediaStream'den; VU icin WebAudio kullanilabilir
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
  // wasm-opus: Yerel WASM Opus encoder; platform istemcisinin birebir kopyasi degildir
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
    label: 'Opus Bitrate Limit (WebRTC)',
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
};

// Varsayilan profil degerleri
// DRY: SETTINGS.*.default'dan otomatik türetilir (manuel sync gereksiz)
const DEFAULT_VALUES = Object.fromEntries(
  Object.entries(SETTINGS).map(([key, setting]) => [key, setting.default])
);

// Source review dates are separate from publication dates and do not certify client defaults.
function createProfileEvidence(sources) {
  return {
    schemaVersion: 1,
    verifiedAt: '2026-09-05',
    classification: 'local-approximation',
    clientVersion: null,
    clientCodec: null,
    sources
  };
}

// Profil fabrika fonksiyonu - tekrari onler
// settings objesi: { locked: [], editable: [], allowedValues: {}, detection: {}, evidence: {} }
// locked: Deger sabit, UI'da disabled (kullanici degistiremez)
// editable: Kullanici degistirebilir
// allowedValues: Her ayar icin izin verilen degerler (profil bazli kisitlama)
// detection: Yerel test teknolojisi { method, source, details }; evidence: platform kaynaklari ve belirsizlikler
function createProfile(id, label, desc, icon, category, overrides = {}, settings = {}) {
  const lockedSettings = settings.locked || [];
  const editableSettings = settings.editable || [];
  const allowedValues = settings.allowedValues || {};

  // OCP: Profil kendi yeteneklerini biliyor
  // call kategorisi = kisa WebRTC testi, record kategorisi = kayit
  const isCallCategory = category === 'call';

  // Detection bilgisi (opsiyonel)
  const detection = settings.detection || null;

  return {
    id, label, desc, icon, category,
    values: overrides === null ? null : { ...DEFAULT_VALUES, ...overrides },
    lockedSettings,
    editableSettings,
    allowedValues, // Profil bazli deger kisitlamalari
    detection, // Teknoloji tespit detaylari
    evidence: settings.evidence || null,
    // OCP: Yetenekler profilde tanimli
    canTest: isCallCategory,
    canRecord: !isCallCategory,
    // Geriye uyumluluk
    allowedSettings: editableSettings.length > 0 ? editableSettings : 'all'
  };
}

// Davranis bazli profil tanimlari
// İKİ ANA KATEGORİ: call (sesli görüşme) ve record (kayıt)
export const PROFILES = {
  // ═══════════════════════════════════════════════════════════════
  // 📞 SESLİ GÖRÜŞME (call) - WebRTC Loopback testi ve rapor
  // ═══════════════════════════════════════════════════════════════
  // Call profilleri platform klonu degil, duyulur codec/DSP davranisi yaklasimidir.
  'discord': createProfile('discord', 'Discord Voice', 'Local Opus voice test with browser noise processing; Discord and Krisp processing are not reproduced',
    'gamepad', 'call', { ec: true, ns: true, agc: true, loopback: true, pipeline: 'worklet', encoder: 'mediarecorder', bitrate: 64000, sampleRate: 48000, channelCount: 1 },
    { locked: ['loopback', 'pipeline', 'encoder', 'sampleRate', 'channelCount', 'ec', 'ns', 'agc'],
      editable: ['bitrate'],
      allowedValues: { bitrate: [64000, 96000, 128000, 256000, 384000] },
      evidence: createProfileEvidence([
        { platform: 'discord', title: 'Discord voice architecture', publishedAt: '2018-09-10',
          url: 'https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc' },
        { platform: 'discord', title: 'Krisp FAQ', publishedAt: null,
          url: 'https://support.discord.com/hc/en-us/articles/360040843952-Krisp-FAQ' }
      ]),
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

  'whatsapp-telegram-call': createProfile('whatsapp-telegram-call', 'WhatsApp / Telegram Call', 'Local voice-call preset; mobile and desktop app codecs and processing are not reproduced',
    'phone', 'call', { ec: true, ns: true, agc: true, loopback: true, pipeline: 'worklet', encoder: 'mediarecorder', bitrate: 24000, sampleRate: 48000, channelCount: 1 },
    { locked: ['loopback', 'pipeline', 'encoder', 'channelCount', 'ec', 'ns', 'agc'],
      editable: ['bitrate'],
      allowedValues: { bitrate: [16000, 24000, 32000, 48000] },
      evidence: createProfileEvidence([
        { platform: 'whatsapp', title: "MLow: Meta's low bitrate audio codec", publishedAt: '2024-06-13',
          url: 'https://engineering.fb.com/2024/06/13/web/mlow-metas-low-bitrate-audio-codec/' },
        { platform: 'whatsapp', title: 'Better calling across desktop and mobile', publishedAt: '2024-06-13',
          url: 'https://blog.whatsapp.com/better-calling-across-desktop-and-mobile' },
        { platform: 'whatsapp', title: 'Introducing Web Calling on WhatsApp', publishedAt: '2026-07-28',
          url: 'https://blog.whatsapp.com/introducing-web-calling-on-whatsapp-plus-more-new-updates' }
      ]),
      detection: { method: 'AudioWorklet + WebRTC', source: 'local approximation', details: 'MicProbe local Opus call test; the selected bitrate does not reproduce WhatsApp/Telegram client defaults or adaptive codecs' } }),

  // ═══════════════════════════════════════════════════════════════
  // 🎙️ KAYIT (record) - Profiller WASM Opus veya PCM/WAV kullanir
  // ═══════════════════════════════════════════════════════════════
  'whatsapp-voice': createProfile('whatsapp-voice', 'WhatsApp Voice Message',
    'Local Opus voice-message preset; the selected bitrate is a test setting, not a native app default',
    'message', 'record', { mediaBitrate: 16000, timeslice: 0, loopback: false, pipeline: PIPELINE_TYPES.WORKLET, encoder: ENCODER_TYPES.WASM_OPUS },
    { locked: ['pipeline', 'encoder', 'timeslice'],
      editable: ['ec', 'ns', 'agc', 'mediaBitrate'],
      allowedValues: { mediaBitrate: [16000, 24000, 32000] },
      evidence: createProfileEvidence([
        { platform: 'whatsapp', title: 'Voice message recording and playback', publishedAt: '2022-03-30',
          url: 'https://blog.whatsapp.com/making-voice-messages-better' },
        { platform: 'whatsapp', title: 'Cloud API voice-message input format, not native recorder defaults', publishedAt: null,
          url: 'https://www.postman.com/meta/whatsapp-business-platform/request/juzqcg2/send-audio-message-by-url' }
      ]),
      detection: { method: 'AudioWorklet + WASM Opus', source: 'local encoder', details: 'MicProbe local Opus encoder; Worklet and the selected bitrate do not identify a WhatsApp client implementation' } }),

  'telegram-voice': createProfile('telegram-voice', 'Telegram Voice Message',
    'Local Opus voice-message preset using the encoder default; native app processing is not reproduced',
    'send', 'record', { mediaBitrate: 0, timeslice: 0, loopback: false, pipeline: 'worklet', encoder: 'wasm-opus', channelCount: 1 },
    { locked: ['pipeline', 'encoder', 'timeslice', 'channelCount'],
      editable: ['ec', 'ns', 'agc', 'mediaBitrate'],
      allowedValues: { mediaBitrate: [0, 16000, 24000, 32000] },  // 0 = VBR (varsayılan)
      detection: { method: 'AudioWorklet + WASM Opus', source: 'local encoder', details: 'MicProbe local Opus encoder; Worklet and its VBR default do not identify a Telegram client implementation' } }),

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
    desc: 'Discord, Zoom/Meet/Teams meetings, Zoom Hi-Fi, WhatsApp/Telegram',
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
    { step: 1, text: 'Select <strong>Run Test</strong> and follow the on-screen steps' },
    { step: 2, text: 'Play back the codec-processed audio' },
    { step: 3, text: 'Review your result and open the report for details' }
  ],
  'meeting-call': [
    { step: 1, text: 'Select <strong>Run Test</strong> and follow the on-screen steps' },
    { step: 2, text: 'Listen to your sample and review the result' },
    { step: 3, text: 'Adjust one setting and test again to compare' }
  ],
  'zoom-hifi': [
    { step: 1, text: 'Select <strong>Run Test</strong> and follow the on-screen steps' },
    { step: 2, text: 'Listen for room noise and review the result' },
    { step: 3, text: 'Try mono or stereo, then test again to compare' }
  ],
  'whatsapp-telegram-call': [
    { step: 1, text: 'Select <strong>Run Test</strong> and follow the on-screen steps' },
    { step: 2, text: 'Check whether speech stays clear after heavier call compression' },
    { step: 3, text: 'Review measured levels and listen for background noise' }
  ],

  // === RECORD Category ===
  'whatsapp-voice': [
    { step: 1, text: 'Select <strong>Record</strong> and follow the on-screen steps' },
    { step: 2, text: 'Wait for the recording to finish, then listen to your sample' },
    { step: 3, text: 'Review your result and open the report for details' }
  ],
  'telegram-voice': [
    { step: 1, text: 'Select <strong>Record</strong> and follow the on-screen steps' },
    { step: 2, text: 'Wait for the recording to finish, then listen to your sample' },
    { step: 3, text: 'Adjust one setting and test again to compare' }
  ],
  'raw': [
    { step: 1, text: 'Select <strong>Record</strong> and follow the on-screen steps' },
    { step: 2, text: 'Wait for the recording to finish, then listen to your sample' },
    { step: 3, text: 'Review your result before changing your setup' }
  ],

  // Default (fallback)
  'default': [
    { step: 1, text: 'Select a profile from the sidebar' },
    { step: 2, text: 'Select <strong>Run Test</strong> or <strong>Record</strong>, then follow the on-screen steps' },
    { step: 3, text: 'Listen to your sample and review the result' }
  ]
};

export default {
  SETTINGS,
  PROFILES,
  PROFILE_CATEGORIES,
  PROFILE_TIPS
};
