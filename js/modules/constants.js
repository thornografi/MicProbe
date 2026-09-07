/**
 * constants.js - Merkezi sabit degerler
 * DRY/OCP: Tum magic number'lar tek yerde, degisiklik tek noktadan
 */

// === AUDIO CONTEXT ===
export const AUDIO = {
  DEFAULT_SAMPLE_RATE: 48000,     // Varsayilan sample rate (Hz)
  FFT_SIZE: 256,                   // AnalyserNode FFT boyutu (VU meter icin)
  ANALYSIS_FFT_SIZE: 2048,         // Ayri analyser; bin araligi = context sampleRate / FFT boyutu
  SMOOTHING_TIME_CONSTANT: 0.3,    // AnalyserNode smoothing (fast responsive VU meter)
  CENTER_VALUE: 128                // 8-bit audio center point
};

// === BUFFER ===
export const BUFFER = {
  DEFAULT_SIZE: 4096,             // ScriptProcessor varsayilan buffer
  WARNING_THRESHOLD: 1024         // Dusuk buffer uyari esigi
};

// === OPUS ===
export const OPUS = {
  FRAME_SIZE: 960                 // Opus frame size: 20ms @ 48kHz = 960 samples
};

// === VU METER ===
export const VU_METER = {
  RMS_THRESHOLD: 0.0001,          // dB hesaplama icin minimum RMS
  MIN_DB: -96,                    // Minimum dB seviyesi — 16-bit dinamik aralik (Float32 ile olculebilir)
  CLIPPING_THRESHOLD_DB: -0.5,    // Bu dB ustu = clipping riski
  PEAK_HOLD_TIME_MS: 1000,        // Peak gostergesini tutma suresi (ANSI/IEC standart)
  PEAK_DECAY_DB_PER_SEC: 20,     // Peak dusme hizi (dB/s, frame-rate bagimsiz)
  VU_INTEGRATION_MS: 300,        // VU standard integration suresi (EMA)
  DOT_ACTIVE_THRESHOLD: 5,        // Sinyal noktasi aktif esigi (%)
  DEFAULT_METER_WIDTH: 200,       // Varsayilan meter genisligi (px)
  PEAK_WIDTH: 2                   // Peak cizgisi genisligi (px) - clamp icin
};

// === BYTES ===
export const BYTES = {
  PER_KB: 1024,
  PER_MB: 1024 * 1024
};

// === ENVIRONMENT ===
export const IS_DEV = ['localhost', '127.0.0.1'].includes(globalThis.location?.hostname);

// === LOG ===
export const LOG = {
  MAX_PER_CATEGORY: 500           // Kategori basina maksimum log sayisi
};

// === PIPELINE TYPES ===
export const PIPELINE_TYPES = {
  DIRECT: 'direct',
  STANDARD: 'standard',
  SCRIPTPROCESSOR: 'scriptprocessor',
  WORKLET: 'worklet'
};

// === ENCODER TYPES ===
export const ENCODER_TYPES = {
  MEDIARECORDER: 'mediarecorder',
  WASM_OPUS: 'wasm-opus',
  PCM_WAV: 'pcm-wav',
  DEFAULT: 'mediarecorder'        // Varsayilan encoder tipi
};

// === SETTING NAMES (Radio/Checkbox HTML name attribute'lari) ===
export const SETTING_NAMES = {
  PIPELINE: 'pipeline',
  ENCODER: 'encoder',
  BITRATE: 'bitrate',
  TIMESLICE: 'timeslice',
  BUFFER_SIZE: 'bufferSize',
  MEDIA_BITRATE: 'mediaBitrate',
  SAMPLE_RATE: 'sampleRate',
  CHANNEL_COUNT: 'channelCount'
};

// === UI CSS CLASS NAMES ===
// === APP STATE (body[data-app-state]) ===
// Makine fazlari; ERROR yalnizca rozet/mesaj durumudur, body'ye yazilmaz (bkz. StatusManager).
export const APP_STATE = {
  IDLE: 'idle',
  PREPARING: 'preparing',
  RECORDING: 'recording',
  TESTING: 'testing',
  ANALYSING: 'analysing',
  ERROR: 'error'
};

// === JS ile uretilen yapisal markup sinif adlari (innerHTML/createElement) ===
// CSS bu adlari bilir; string literal ile paralel kopya kurma.
export const MARKUP_CLASSES = {
  TIP: 'utip',
  TIP_STEP: 'utip-step',
  TIP_TEXT: 'utip-text',
  CUSTOM_SECTION: 'custom-settings-section',
  CUSTOM_SECTION_LABEL: 'custom-settings-section-label',
  CUSTOM_SECTION_BODY: 'custom-settings-section-body',
  CUSTOM_CHECKBOX_ROW: 'custom-settings-checkbox-row',
  CUSTOM_ITEM: 'custom-setting-item',
  CUSTOM_ITEM_LOCKED: 'dynamic-locked',
  CUSTOM_HINT: 'custom-settings-hint',
  SETTING_NAME: 'setting-name'
};

// Buton calisma durumu class ile degil body[data-app-state] + aria-pressed ile anlatilir (APP_STATE).
// Devre disi birakma class ile degil native disabled / aria-disabled / inert ile yapilir (UIStateManager).
export const UI_CLASSES = {
  ACTIVE: 'active',
  OPEN: 'open',
  VISIBLE: 'visible'
};

// === EVENT NAMES ===
export const EVENTS = {
  // Stream
  STREAM_STARTED: 'stream:started',
  STREAM_STOPPED: 'stream:stopped',
  MICROPHONE_ACCESS_CHANGED: 'microphone:accessChanged',
  // Recorder
  RECORDER_STARTED: 'recorder:started',
  RECORDER_STOPPED: 'recorder:stopped',
  RECORDING_STARTED: 'recording:started',
  RECORDING_CAPTURE_STOPPED: 'recording:capture-stopped',
  RECORDING_COMPLETED: 'recording:completed',
  RECORDING_FAILED: 'recording:failed',
  // Loopback
  LOOPBACK_REMOTE_STREAM: 'loopback:remoteStream',
  LOOPBACK_STATS: 'loopback:stats',
  // Test
  TEST_RECORDING_STARTED: 'test:recording-started',
  TEST_RECORDING_STOPPED: 'test:recording-stopped',
  TEST_ANALYSING_STARTED: 'test:analysing-started',       // Kayit bitti, analiz fazi basladi (playback yerine)
  TEST_ANALYSING_PROGRESS: 'test:analysing-progress',     // { ratio: 0..1 } — UI progress bar
  TEST_COMPLETED: 'test:completed',
  TEST_CANCELLED: 'test:cancelled',
  TEST_COUNTDOWN: 'test:countdown',
  CAPTURE_GUIDE_CHANGED: 'capture:guideChanged',
  // Pipeline
  PIPELINE_ANALYSER_READY: 'pipeline:analyserReady',
  PIPELINE_ANALYSIS_ANALYSER_READY: 'pipeline:analysisAnalyserReady',
  // Opus
  OPUS_PROGRESS: 'opus:progress',
  // Player
  PLAYER_RESET: 'player:reset',
  PLAYER_PAUSED: 'player:paused',
  PLAYER_ENDED: 'player:ended',
  PLAYER_LOADED: 'player:loaded',
  // VU Meter
  VUMETER_STARTED: 'vumeter:started',
  VUMETER_STOPPED: 'vumeter:stopped',
  VUMETER_LEVEL: 'vumeter:level',
  VUMETER_REMOTE_LEVEL: 'vumeter:remoteLevel',
  VUMETER_AUDIOCONTEXT: 'vumeter:audiocontext',
  // Profile
  PROFILE_CHANGED: 'profile:changed',
  // Constraint
  CONSTRAINT_MISMATCH: 'constraint:mismatch',
  // Status
  STATUS_CHANGED: 'status:changed',
  APP_STATE_CHANGED: 'app:stateChanged',
  UI_MESSAGE: 'ui:message',
  UI_CLEAR_MESSAGE: 'ui:clearMessage',
  UI_STATE_CHANGED: 'ui:stateChanged',
  // Log - Genel
  LOG: 'log',
  LOG_CLEAR: 'log:clear',
  LOG_DISPLAY: 'log:display',
  LOG_ADDED: 'log:added',
  // Log - Kategoriler
  LOG_ERROR: 'log:error',
  LOG_WARNING: 'log:warning',
  LOG_AUDIO: 'log:audio',
  LOG_STREAM: 'log:stream',
  LOG_WEBAUDIO: 'log:webaudio',
  LOG_RECORDER: 'log:recorder',
  LOG_SYSTEM: 'log:system',
  LOG_UI: 'log:ui',
  LOG_LOOPBACK: 'log:loopback',
  LOG_PLAYER: 'log:player',
  LOG_PIPELINE: 'log:pipeline',
  LOG_ENCODER: 'log:encoder',
  LOG_DEVICE: 'log:device',
  LOG_CONSTRAINT: 'log:constraint',
  LOG_PROFILE: 'log:profile',
  LOG_VUMETER: 'log:vumeter',
  // Diagnostik Rapor
  DIAGNOSTIC_REPORT_READY: 'diagnostic:reportReady',
  // Deep Analysis (offline spektral pass)
  DEEP_ANALYSIS_STARTED: 'deepAnalysis:started',
  DEEP_ANALYSIS_PROGRESS: 'deepAnalysis:progress',   // { ratio, stage }
  DEEP_ANALYSIS_READY: 'deepAnalysis:ready',          // deepAnalysis payload
  DEEP_ANALYSIS_FAILED: 'deepAnalysis:failed'         // { reason } — fatal DEGIL
};

// === QUALITY (Diagnostik Analiz) ===
export const QUALITY = {
  PCM_BLOCK_MS: 10,
  SAMPLE_SATURATION_THRESHOLD: 1 - 1 / 32768,
  LEVEL_PERCENTILE: 10,
  WEAK_SIGNAL_DB: -45,              // Zayif sinyal esigi (dB)
  SILENCE_DB: -55,                  // Dusuk RMS/sessizlik; kayip sample kaniti degildir
  FREQUENCY_BANDS: {
    SUB_BASS: [0, 250],
    LOW_MID: [250, 2000],
    HIGH_MID: [2000, 6000],
    PRESENCE: [6000, 20000]
  },
  // Evaluator esikleri
  SNR_GOOD_DB: 20,
  SNR_WARNING_DB: 10,
  SNR_CRITICAL_DB: 5,
  NOISE_FLOOR_GOOD_DB: -45,
  NOISE_FLOOR_WARNING_DB: -30,
  NOISE_FLOOR_CRITICAL_DB: -20,
  CLIPPING_RATE_WARNING: 0.01,
  CLIPPING_RATE_CRITICAL: 0.05,
  DROPOUT_COUNT_WARNING: 2,
  DROPOUT_COUNT_CRITICAL: 5,
  STABILITY_GOOD_STDDEV: 6,
  STABILITY_WARNING_STDDEV: 12,
  DYNAMIC_RANGE_WARNING_DB: 6,
  // Sustained level: gated integrated loudness ignores pauses, so one brief loud
  // moment cannot hide a recording that is quiet almost everywhere else.
  SUSTAINED_WEAK_LUFS: -40,
  SUSTAINED_SILENCE_LUFS: -55,
  // Ceiling: a waveform pinned just below full scale with almost no peak-to-average
  // spread was clipped before the browser received it (interface, driver or system input level).
  CEILING_PERCENTILE: 99,           // the ceiling is the 99th percentile of |x|, so resampling overshoot spikes do not move it
  CEILING_WINDOW_DB: 1,             // "at the ceiling" = within 1 dB below that level (or above it)
  FLAT_STEP_DB: -60,                // "flat" = next sample differs by less than -60 dB of the peak (exact plateaus only)
  FLAT_TOP_CREST_DB: 8,             // speech spans 12-25 dB peak-to-RMS; pure tones 3 dB; clipped audio 2-5 dB after resampling
  FLAT_TOP_NEAR_RATE_WARNING: 0.4,  // share at the ceiling: pure tones stay near 0.3, clipping reaches 0.45-0.6
  FLAT_TOP_NEAR_RATE_CRITICAL: 0.5,
  FLAT_TOP_RATE_CRITICAL: 0.25,     // exact plateau share that alone marks severe clipping
  TRUE_PEAK_WARNING_DBTP: 0,        // inter-sample peaks above full scale (BS.1770-4 Annex 2)
  DUAL_MONO_MAX_DIFF_DB: -60        // identical channels: largest difference relative to the peak
};

// === LOOPBACK (WebRTC) ===
export const LOOPBACK = {
  ICE_WAIT_MS: 10000,
  STATS_INTERVAL_MS: 500
};

export const RECORDING = {
  MAX_PCM_BYTES: 64 * 1024 * 1024,
  WORKLET_STOP_TIMEOUT_MS: 3000
};

// === SYSTEM PROBE (Dolayli Performans Sinyalleri) ===
// Tarayici OS'tan gercek CPU%/RAM% okuyamaz (sandbox). Bu esikler yalniz DOLAYLI
// proxy sinyaller uretir; her cikti confidence + disclaimer tasir.
export const JITTER = {
  SPIKE_THRESHOLD_MS: 50,          // rAF frame'i bu ms'in ustundeyse = orta seviye ana-thread stall (~3 frame kaybi @60Hz)
  SEVERE_SPIKE_THRESHOLD_MS: 150,  // duyulabilir glitch olceginde stall
  GRACE_SAMPLES: 3,                // ilk N ornek yok sayilir (kurulum jitter'i)
  MAX_SPIKE_EVENTS: 40             // bounded spike gecmisi
};

// === TEST (Loopback Test Ozelligi) ===
export const TEST = {
  DURATION_MS: 7000,              // Test suresi (7 saniye)
  STOP_WAIT_MS: 10000             // Capture must settle even if MediaRecorder never fires stop.
};

export const CAPTURE_GUIDE = {
  PREPARE_MS: 2000,
  QUIET_MS: 3000,
  EDGE_MARGIN_MS: 500,
  MIN_QUIET_MS: 1500,
  MIN_SPEAKING_MS: 3000,
  MIN_SEPARATION_DB: 3,
  MAX_QUIET_SPREAD_DB: 6,
  NOISE_BLOCK_MS: 100,
  MIN_MEASURABLE_POWER: 1e-12,
  SAMPLE_TEXT: 'I am checking my microphone for my next conversation. My voice should sound clear and natural.'
};

// === CHECKOUT SNAPSHOT (Freemius Donus State Korumasi) ===
// Checkout ayni sekmede tam navigasyonla acilir; donuste bellek-ici state kaybolur.
// Snapshot sessionStorage'da tutulur ve bu sureden eskiyse yok sayilir.
export const CHECKOUT_SNAPSHOT = {
  MAX_AGE_MS: 30 * 60 * 1000      // Terk edilmis checkout korumasi (30 dk)
};

// === DEEP ANALYSIS (Offline Spektral Pass) ===
// Kayit dosyasi decode edilir; kanal bazli PCM/LUFS ve Welch spektrumu Worker'da hesaplanir.
export const DEEP_ANALYSIS = {
  MAX_BLOB_BYTES: 64 * 1024 * 1024,
  FFT_SIZE: 4096,                 // ~11.7 Hz/bin @ 48kHz (yuksek cozunurluk)
  HOP_SIZE: 2048,                 // %50 overlap (Welch ortalamasi)
  OUTPUT_BINS: 96,                // Rapora yazilan log-spaced frekans egrisi nokta sayisi
  MAX_DURATION_SEC: 30,           // Analiz prefix'i; decoder once tum dosyayi cozer, kaynak metadata'da belirtilir
  MAX_WAIT_MS: 8000,              // Decode + worker zaman asimi: status=failed, metrikler kullanilamaz
  MIN_SAMPLES: 8192,              // Bunun altinda analiz atlanir (status:'skipped')
  PROGRESS_FRAME_INTERVAL: 8      // Her N frame'de bir progress emit
};
