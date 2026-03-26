/**
 * constants.js - Merkezi sabit degerler
 * DRY/OCP: Tum magic number'lar tek yerde, degisiklik tek noktadan
 */

// === AUDIO CONTEXT ===
export const AUDIO = {
  DEFAULT_SAMPLE_RATE: 48000,     // Varsayilan sample rate (Hz)
  FFT_SIZE: 256,                   // AnalyserNode FFT boyutu
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
  MIN_DB: -60,                    // Minimum dB seviyesi (sessizlik)
  CLIPPING_THRESHOLD_DB: -0.5,    // Bu dB ustu = clipping riski
  PEAK_HOLD_TIME_MS: 4500,        // Peak gostergesini tutma suresi (4.5 saniye)
  PEAK_DECAY_RATE: 2,             // Peak dusme hizi (dB/frame)
  DOT_ACTIVE_THRESHOLD: 5,        // Sinyal noktasi aktif esigi (%)
  DEFAULT_METER_WIDTH: 200        // Varsayilan meter genisligi (px)
};

// === BYTES ===
export const BYTES = {
  PER_KB: 1024,
  PER_MB: 1024 * 1024
};

// === THROTTLING ===
export const THROTTLE = {
  ERROR_LOG_MS: 5000              // Error log throttle suresi (ms)
};

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
  RECORDER_ERROR: 'recorder:error',
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
  LOG_VUMETER: 'log:vumeter'
};

// === LOOPBACK (WebRTC) ===
export const LOOPBACK = {
  ICE_WAIT_MS: 10000              // ICE baglanti timeout suresi (ms)
};

// === TEST (Loopback Test Ozelligi) ===
export const TEST = {
  DURATION_MS: 7000               // Test suresi (7 saniye)
};

