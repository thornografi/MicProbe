/**
 * constants.js - Merkezi sabit degerler
 * DRY/OCP: Tum magic number'lar tek yerde, degisiklik tek noktadan
 */

// === AUDIO CONTEXT ===
export const AUDIO = {
  DEFAULT_SAMPLE_RATE: 48000,     // Varsayilan sample rate (Hz)
  FFT_SIZE: 256,                   // AnalyserNode FFT boyutu (VU meter icin)
  ANALYSIS_FFT_SIZE: 2048,         // Frekans analizi icin ayri analyser (11.7 Hz/bin @ 48kHz)
  SMOOTHING_TIME_CONSTANT: 0.3,    // AnalyserNode smoothing (fast responsive VU meter)
  CENTER_VALUE: 128                // 8-bit audio center point
};

// === DELAY (Echo/Feedback Onleme) ===
export const DELAY = {
  MAX_SECONDS: 3.0,               // DelayNode maksimum delay suresi
  DEFAULT_SECONDS: 1.7            // Varsayilan delay suresi (feedback onleme)
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
  PEAK_WIDTH: 4                   // Peak cizgisi genisligi (px) - clamp icin
};

// === BYTES ===
export const BYTES = {
  PER_KB: 1024,
  PER_MB: 1024 * 1024
};

// === ENVIRONMENT ===
export const IS_DEV = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

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
export const UI_CLASSES = {
  ACTIVE: 'active',
  DISABLED: 'ui-disabled',
  PREPARING: 'preparing',
  RECORDING: 'recording',
  PLAYBACK: 'playback',
  OPEN: 'open',
  VISIBLE: 'visible',
  LOCKED: 'locked',
  HIDDEN: 'hidden',
  NO_POINTER: 'no-pointer-events'
};

// === EVENT NAMES ===
export const EVENTS = {
  // Stream
  STREAM_STARTED: 'stream:started',
  STREAM_STOPPED: 'stream:stopped',
  // Recorder
  RECORDER_STARTED: 'recorder:started',
  RECORDER_STOPPED: 'recorder:stopped',
  RECORDING_STARTED: 'recording:started',
  RECORDING_COMPLETED: 'recording:completed',
  RECORDING_FAILED: 'recording:failed',
  // Monitor
  MONITOR_STARTED: 'monitor:started',
  MONITOR_STOPPED: 'monitor:stopped',
  MONITOR_ERROR: 'monitor:error',
  // Loopback
  LOOPBACK_STARTED: 'loopback:started',
  LOOPBACK_STOPPED: 'loopback:stopped',
  LOOPBACK_REMOTE_STREAM: 'loopback:remoteStream',
  LOOPBACK_STATS: 'loopback:stats',
  // Test
  TEST_RECORDING_STARTED: 'test:recording-started',
  TEST_RECORDING_STOPPED: 'test:recording-stopped',
  TEST_PLAYBACK_STARTED: 'test:playback-started',
  TEST_PLAYBACK_STOPPED: 'test:playback-stopped',
  TEST_COMPLETED: 'test:completed',
  TEST_CANCELLED: 'test:cancelled',
  TEST_COUNTDOWN: 'test:countdown',
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
  VUMETER_AUDIOCONTEXT: 'vumeter:audiocontext',
  // Profile
  PROFILE_CHANGED: 'profile:changed',
  // Constraint
  CONSTRAINT_MISMATCH: 'constraint:mismatch',
  // Status
  STATUS_CHANGED: 'status:changed',
  UI_MESSAGE: 'ui:message',
  UI_CLEAR_MESSAGE: 'ui:clearMessage',
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
  METRICS_STARTED: 'metrics:started',
  METRICS_STOPPED: 'metrics:stopped',
  DIAGNOSTIC_REPORT_READY: 'diagnostic:reportReady'
};

// === QUALITY (Diagnostik Analiz) ===
export const QUALITY = {
  UPDATE_INTERVAL_MS: 250,          // Frekans snapshot araligi (ms)
  WEAK_SIGNAL_DB: -45,              // Zayif sinyal esigi (dB)
  SILENCE_DB: -55,                  // Sessizlik/dropout esigi (dB)
  DROPOUT_CONSECUTIVE_FRAMES: 5,    // Art arda sessiz frame = dropout
  CLIPPING_THRESHOLD: 0.98,         // Normalized peak > bu = clipping
  NOISE_FLOOR_PERCENTILE: 10,       // En dusuk %N frame = noise floor
  DROPOUT_LEVEL_THRESHOLD: 2,       // Level < %N = dropout adayi
  FREQUENCY_BANDS: {
    SUB_BASS: [0, 250],
    LOW_MID: [250, 2000],
    HIGH_MID: [2000, 6000],
    PRESENCE: [6000, 20000]
  },
  // Evaluator esikleri
  SNR_GOOD_DB: 20,
  SNR_WARNING_DB: 10,
  NOISE_FLOOR_GOOD_DB: -45,
  NOISE_FLOOR_WARNING_DB: -30,
  NOISE_FLOOR_CRITICAL_DB: -20,
  CLIPPING_RATE_WARNING: 0.01,
  CLIPPING_RATE_CRITICAL: 0.05,
  DROPOUT_COUNT_WARNING: 2,
  DROPOUT_COUNT_CRITICAL: 5,
  STABILITY_GOOD_STDDEV: 6,
  STABILITY_WARNING_STDDEV: 12,
  BITRATE_DEVIATION_WARNING: 0.3,
  DYNAMIC_RANGE_WARNING_DB: 6
};

// === LOOPBACK (WebRTC) ===
export const LOOPBACK = {
  ICE_WAIT_MS: 10000              // ICE baglanti timeout suresi (ms)
};

// === TEST (Loopback Test Ozelligi) ===
export const TEST = {
  DURATION_MS: 7000               // Test suresi (7 saniye)
};
