/**
 * Config - Merkezi yapilandirma modulu
 * Ayar tanimlari ve profil degerleri
 */
import { PIPELINE_TYPES, ENCODER_TYPES } from './constants.js';
import { PLATFORM_REFERENCE_VERSION } from './PlatformContext.js';

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
function createProfileEvidence(sources = [], observations = {}) {
  return {
    schemaVersion: 1,
    verifiedAt: sources.length ? '2026-09-05' : null,
    classification: 'local-approximation',
    clientVersion: null,
    clientCodec: null,
    sources,
    basis: 'heuristic',
    summary: 'Estimated local preset; the platform\'s current web audio behavior has not been verified.',
    ...observations
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
    referenceVersion: PLATFORM_REFERENCE_VERSION,
    values: overrides === null ? null : { ...DEFAULT_VALUES, ...overrides },
    lockedSettings,
    editableSettings,
    allowedValues, // Profil bazli deger kisitlamalari
    detection, // Teknoloji tespit detaylari
    evidence: settings.evidence || (id === 'raw' ? null : createProfileEvidence()),
    transport: isCallCategory ? { dtx: null, fec: null, ...settings.transport } : null,
    // OCP: Yetenekler profilde tanimli
    canTest: isCallCategory,
    canRecord: !isCallCategory,
    // Geriye uyumluluk
    allowedSettings: editableSettings.length > 0 ? editableSettings : 'all'
  };
}

// Platform observations only replace the fields they establish. Unknown codec/DSP
// behavior keeps a local baseline; null Opus preferences leave browser defaults intact.
function createWebCall(id, label, bitrate, evidence = {}, transport = {}) {
  return createProfile(id, label, 'Local browser call approximation', 'video', 'call',
    { ec: true, ns: true, agc: true, loopback: true, pipeline: PIPELINE_TYPES.WORKLET,
      encoder: ENCODER_TYPES.MEDIARECORDER, bitrate, sampleRate: 48000, channelCount: 1 },
    { locked: ['loopback', 'pipeline', 'encoder', 'channelCount', 'sampleRate', 'ec', 'ns', 'agc'],
      editable: ['bitrate'], allowedValues: { bitrate: [16000, 24000, 32000, 48000, 64000] },
      transport, evidence: createProfileEvidence([], { verifiedAt: null, ...evidence }),
      detection: { method: 'AudioWorklet + WebRTC', source: 'local approximation',
        details: 'Local Opus with browser echo cancellation, noise suppression and automatic gain. Bitrate is a ceiling; platform-specific processing and network behavior are not reproduced.' } });
}

// Davranis bazli profil tanimlari
// İKİ ANA KATEGORİ: call (sesli görüşme) ve record (kayıt)
export const PROFILES = {
  'teams': createWebCall('teams', 'Microsoft Teams', 32000, {
    basis: 'observed-web', verifiedAt: '2026-09-11', clientCodec: 'audio/opus',
    observed: { bitrate: 32000, dtx: true },
    summary: 'Informed by a Teams web test: Opus, a 32 kbps target and DTX enabled. Full defaults and proprietary processing remain unverified; remaining settings are estimated.'
  }, { dtx: true }),
  'webex': createWebCall('webex', 'Cisco Webex', 64000, {
    basis: 'observed-web', verifiedAt: '2026-09-11', clientCodec: 'audio/opus',
    observed: { bitrate: 64000, dtx: false, fec: true },
    summary: 'Informed by a Webex web test: Opus, a 64 kbps limit, DTX disabled and FEC enabled. Webex noise removal is not reproduced; remaining settings are estimated.'
  }, { dtx: false, fec: true }),
  'zoom': createWebCall('zoom', 'Zoom', 48000, {
    basis: 'observed-web', verifiedAt: '2026-09-11',
    observed: { sampleRate: 48000, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    summary: 'Informed by a Zoom web capture at 48 kHz with browser sound enhancements on. Codec and bitrate were not measured; this preset uses an estimated mono Opus path. Zoom-specific processing is not reproduced.'
  }),
  'google-meet': createWebCall('google-meet', 'Google Meet', 48000),
  'whatsapp-call': createWebCall('whatsapp-call', 'WhatsApp Call', 24000),
  'telegram-call': createWebCall('telegram-call', 'Telegram Call', 24000),
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

  'meeting-call': createProfile('meeting-call', 'General meeting', 'General browser meeting preset',
    'video', 'call', { ec: true, ns: true, agc: true, loopback: true, pipeline: 'worklet', encoder: 'mediarecorder', bitrate: 48000, sampleRate: 48000, channelCount: 1 },
    { locked: ['loopback', 'pipeline', 'encoder', 'channelCount', 'ec', 'ns', 'agc'],
      editable: ['bitrate', 'sampleRate'],
      allowedValues: { bitrate: [32000, 48000, 64000], sampleRate: [16000, 24000, 48000] },
      detection: { method: 'AudioWorklet + WebRTC', source: 'local approximation', details: 'Default meeting-call behavior: mono Opus with browser EC/NS/AGC enabled' } }),

  'zoom-hifi': createProfile('zoom-hifi', 'Music call', 'Higher-bitrate local music test with browser sound enhancements off',
    'music', 'call', { ec: false, ns: false, agc: false, loopback: true, pipeline: 'worklet', encoder: 'mediarecorder', bitrate: 96000, sampleRate: 48000, channelCount: 1 },
    { locked: ['loopback', 'pipeline', 'encoder', 'sampleRate', 'ec', 'ns', 'agc'],
      editable: ['bitrate', 'channelCount'],
      allowedValues: { bitrate: [96000, 128000, 192000], channelCount: [1, 2] },
      detection: { method: 'AudioWorklet + WebRTC', source: 'local approximation', details: 'High-fidelity meeting mode: 48kHz, higher Opus bitrate, browser EC/NS/AGC disabled' } }),

  'whatsapp-telegram-call': createProfile('whatsapp-telegram-call', 'Compact call', 'General low-bitrate voice-call preset',
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

  'raw': createProfile('raw', 'Microphone check', 'Worklet + PCM/WAV - uncompressed 16-bit WAV recording',
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
    desc: 'Teams, Webex, Zoom, Meet, Discord, WhatsApp, Telegram and general call checks',
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

export default {
  SETTINGS,
  PROFILES,
  PROFILE_CATEGORIES
};
