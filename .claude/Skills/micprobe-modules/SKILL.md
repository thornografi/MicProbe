---
name: micprobe-modules
description: "MicProbe modulleri ve Config referansi. Anahtar kelimeler: Config, PROFILES, SETTINGS, AudioEngine, Recorder, Monitor, Player, EventBus, ProfileController, UIStateManager, LoopbackManager, LogManager, Logger, profil kategorileri, call, record"
---

Zorunlu: Bu satirlari okuyorsan konsola "micprobe-modules SKILL.md okunuyor..." yaz.

# MicProbe Modul Referansi

## Uygulama Akisi

```
┌─────────────────────────────────────────────────────────────────┐
│  CALL Kategorisi (Discord, Zoom, WhatsApp/Telegram Arama)       │
│  ───────────────────────────────────────────────────────────    │
│  User clicks Monitor → MonitoringController.start()             │
│    → LoopbackManager.setup() → WebRTC Loopback → Kendini duyma  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  RECORD Kategorisi (WhatsApp/Telegram Voice, Legacy, Ham)       │
│  ───────────────────────────────────────────────────────────    │
│  User clicks Record → Recorder.start()                          │
│    → MediaRecorder → Blob                                       │
│  User clicks Play → Player.load(blob)                           │
└─────────────────────────────────────────────────────────────────┘
```

## Dosya Yapisi

```
js/
├── app.js                       # Orchestrator, event wiring
├── landing.js                   # Landing/App view switching, lazy loading
├── controllers/
│   ├── RecordingController.js   # Normal kayit wrapper
│   └── MonitoringController.js  # Loopback monitor + sinyal bekleme
├── pipelines/                   # Pipeline Strategy Pattern (OCP)
│   ├── index.js                 # Export barrel
│   ├── BasePipeline.js          # Abstract base class
│   ├── PipelineFactory.js       # Factory Method Pattern
│   ├── DirectPipeline.js        # WebAudio bypass
│   ├── StandardPipeline.js      # Source -> Destination
│   ├── ScriptProcessorPipeline.js # ScriptProcessor + WASM Opus
│   ├── WorkletPipeline.js       # AudioWorkletNode
│   └── effects/                 # Decorator Pattern (OCP)
│       ├── index.js             # Effect exports + factory
│       ├── EffectDecorator.js   # Abstract decorator base
│       ├── JitterEffect.js      # Network jitter simulation
│       └── PacketLossEffect.js  # Packet loss simulation
├── tests/                       # Browser-based unit tests
│   ├── TestRunner.js            # Minimal test framework
│   └── pipelines.test.js        # Pipeline unit tests
├── ui/
│   ├── ProfileUIManager.js      # Profil UI, scenario cards
│   ├── CustomSettingsPanelHandler.js # Ozel ayarlar paneli
│   ├── RadioGroupHandler.js     # Radio/checkbox event handler
│   └── DebugConsole.js          # Debug fonksiyonlari
├── lib/opus/
│   └── encoderWorker.min.js     # opus-recorder WASM encoder
├── worklets/
│   └── passthrough-processor.js # AudioWorklet processor
└── modules/
    ├── Config.js                # PROFILES, SETTINGS
    ├── constants.js             # Sabitler ve helper fonksiyonlar
    ├── EventBus.js              # Pub/Sub singleton
    ├── ProfileController.js     # applyProfile, constraint logic
    ├── UIStateManager.js        # Buton state yonetimi
    ├── StatusManager.js         # Durum yonetimi
    ├── LoopbackManager.js       # WebRTC loopback setup
    ├── Recorder.js              # MediaRecorder + Pipeline Strategy
    ├── OpusWorkerHelper.js      # WASM Opus worker yonetimi
    ├── Monitor.js               # Modlar: direct, standard, worklet
    ├── Player.js                # Blob oynatma
    ├── VuMeter.js               # dB gostergesi
    ├── AudioEngine.js           # AudioContext yonetimi
    ├── DeviceInfo.js            # Mikrofon/cihaz bilgileri
    ├── StreamHelper.js          # MediaStream yardimci
    ├── WorkletHelper.js         # AudioWorklet yardimci
    ├── Logger.js                # UI log paneli
    ├── LogManager.js            # IndexedDB log yonetimi
    ├── WaveAnimator.js          # Landing page animasyon
    └── utils.js                 # Genel yardimci fonksiyonlar
```

## Kategori & Profiller

| Kategori | Yetenek | Profiller |
|----------|---------|-----------|
| `call` | Monitoring only | discord, zoom, whatsapp-call, telegram-call |
| `record` | Recording + Playback | whatsapp-voice, telegram-voice, legacy, raw |

Profil detaylari: `Config.js` → `PROFILES`

## Controllers (Yeni)

### RecordingController
```javascript
import recordingController from './controllers/RecordingController.js';

// Normal kayit (record kategorisi icin) - Loopback YOK
await recordingController.toggle();
await recordingController.start();
await recordingController.stop();
```
**Not:** Loopback recording kaldirildi. Recording sadece MediaRecorder uzerinden (Recorder.js).

### MonitoringController
```javascript
import monitoringController from './controllers/MonitoringController.js';

// Loopback modunda monitor (call kategorisi icin)
await monitoringController.toggle();
await monitoringController.start();  // Sinyal bekler, sonra UI gunceller
await monitoringController.stop();

// 7 saniyelik loopback test (call kategorisi)
await monitoringController.toggleTest();
await monitoringController.startTestRecording();  // Kayit baslar, hoparlor muted
await monitoringController.stopTestRecording();   // Otomatik playback'e gecer
await monitoringController.startTestPlayback();   // Kaydi oynatir
await monitoringController.stopTestPlayback();    // Playback durdurur
await monitoringController.cancelTest();          // Kayit sirasinda iptal
```
**Emits:** `monitor:started`, `monitor:stopped`, `stream:started`, `stream:stopped`, `loopback:remoteStream`
**Test Emits:** `test:recording-started`, `test:countdown`, `test:recording-stopped`, `test:playback-started`, `test:playback-stopped`, `test:completed`, `test:cancelled`
**Ozellik:** `_waitForSignal()` - WebRTC codec hazir olana kadar UI bekler

### ProfileUIManager
```javascript
import profileUIManager from './ui/ProfileUIManager.js';

profileUIManager.init(scenarioCards, navItems);
profileUIManager.updateSettingsPanel(profileId);
profileUIManager.handleProfileSelect(profileId);
```

### RadioGroupHandler (DRY Pattern)
```javascript
import { RadioGroupHandler } from './ui/RadioGroupHandler.js';
RadioGroupHandler.attachGroup('Pipeline', radios, { labels, logCategory, onChange });
RadioGroupHandler.attachGroups({ Pipeline: {...}, Encoder: {...} }); // Toplu kayit
RadioGroupHandler.attachToggle(toggleEl, 'AutoGain', { logCategory, onChange });
```
**Emits:** `setting:<name>:changed`

### DrawerController Factory (DRY Pattern)
```javascript
// app.js - createDrawerController(drawerEl, { overlay, lockBody })
const drawer = createDrawerController(el, { overlay });
drawer.open(); drawer.close(); drawer.toggle();
drawer.bindButtons(btn1, btn2); drawer.bindCloseButtons(closeBtn);
```

## Core Modules

### Config
```javascript
import { PROFILES, SETTINGS } from './Config.js';

PROFILES['discord'].values.bitrate     // 64000
PROFILES['discord'].canMonitor         // true (OCP: otomatik)
PROFILES['discord'].canRecord          // false
```

### EventBus
```javascript
import eventBus from './EventBus.js';
eventBus.emit('event:name', data);
eventBus.on('event:name', callback);
```

### Recorder (record kategorisi icin)
```javascript
const recorder = new Recorder({ constraints });
await recorder.start(constraints, pipeline, encoder, timeslice, bufferSize, mediaBitrate);
recorder.stop();
```
**Not:** `constraints.channelCount` pipeline'a `channels` olarak aktarilir (WASM Opus icin)

**Pipeline Strategy Pattern (OCP):**
Recorder, pipeline kurulumu icin Strategy Pattern kullanir. Yeni pipeline eklemek icin:
1. `js/pipelines/NewPipeline.js` olustur (BasePipeline extend)
2. `PipelineFactory.js`'e ekle

**Mevcut Pipeline'lar:**
- `direct` → Web Audio yok, dogrudan MediaRecorder
- `standard` → AudioContext → MediaRecorder
- `scriptprocessor` → ScriptProcessorNode → **SADECE WASM Opus** (MediaRecorder passthrough kaldirildi)
- `worklet` → AudioWorkletNode → **WASM Opus veya PCM/WAV** (Raw Recording icin 16-bit WAV destegi)

**NOT:** ScriptProcessor pipeline sadece WASM Opus kullanir. WorkletPipeline hem WASM Opus hem PCM/WAV destekler.
MediaRecorder passthrough desteği ölü kod olarak tespit edilip kaldırıldı.

**AudioWorklet process() Lifetime:**
- `process()` metodu `true` dönerse processor aktif kalır
- `false` dönerse processor ve node garbage collect edilir
- Kayıt bitene kadar `true` dönmeli, aksi halde ses kesilir

**Pipeline Cleanup Pattern (Race Condition Prevention):**
Cleanup sırasında audio thread'den hala event'ler gelebilir:
1. Önce mesajı gönder (postMessage) - worklet son komutu alsın
2. Sonra handler'ı temizle (null yap)
3. Guard clause ekle (fallback için null check)

**Örnek:** `WorkletPipeline.cleanup()` - sıra önemli!

**DirectPipeline AudioContext:**
DirectPipeline kendi AudioContext oluşturmaz, dışarıdan alır (Recorder'dan).
Cleanup'ta context kapatılmaz - Recorder yönetir.

**Encoder (Kayit Formati):**
- `mediarecorder` → Tarayici MediaRecorder API
- `wasm-opus` → WASM Opus encoder (WhatsApp Web pattern)
- `pcm-wav` → Raw PCM 16-bit WAV (sifir compression, Raw Recording profili)

**NOT:** PCM/WAV encoder sadece Worklet pipeline ile calisir. Raw Recording profili varsayilan olarak `worklet + pcm-wav` kombinasyonunu kullanir (locked).

**Emits:** `recording:started`, `recording:completed`, `opus:progress`

### OpusWorkerHelper (WASM Opus icin)
```javascript
import { isWasmOpusSupported, createOpusWorker } from './OpusWorkerHelper.js';
// VBR modu: bitrate = 0 veya undefined
const worker = await createOpusWorker({ sampleRate, channels, bitrate: 0 });
// CBR modu: bitrate > 0 (ör: 16000, 24000, 32000)
const worker = await createOpusWorker({ sampleRate, channels, bitrate: 24000 });
worker.encode(pcmData); const result = await worker.finish();
```
**Pattern:** `ScriptProcessorNode(4096, 1, 1) + WASM Opus` (WhatsApp Web)

**VBR/CBR Destegi:**
- `bitrate: 0` veya `undefined` → VBR (Variable Bit Rate) - Opus varsayilani
- `bitrate: 16000+` → CBR (Constant Bit Rate) - Sabit bitrate

### Monitor (MonitoringController uzerinden)
Modlar:
- `worklet` → Call kategorisi (WebRTC Loopback + AudioWorklet)
- `direct`, `standard` → Record kategorisi veya non-loopback monitoring
- `scriptprocessor` → **SADECE record kategorisi** (legacy profili, raw secenebilir). Call/arama modunda YASAK!

**Onemli:** ScriptProcessorNode deprecated API'dir ve sadece eski web kayit sitelerini simule etmek icin kullanilir. Call kategorisinde (WebRTC loopback) asla kullanilamaz.

### VuMeter
```javascript
new VuMeter({ barId, peakId, dotId });
```
**Listens:** `stream:started`, `loopback:remoteStream`

### Player
```javascript
new Player({ containerId, playBtnId, ... });
```
**Listens:** `recording:completed`

## Event Akisi

```
Recording (record):
  Recorder.start() → stream:started → recording:started
  Recorder.stop()  → recording:completed → stream:stopped

Monitoring (call):
  MonitoringController.start() → stream:started → loopback:remoteStream → monitor:started
  MonitoringController.stop()  → monitor:stopped → stream:stopped

Test (call - 7sn loopback test):
  startTestRecording() → stream:started → loopback:remoteStream → test:recording-started
                       → test:countdown (her saniye) → stopTestRecording()
  stopTestRecording()  → test:recording-stopped → stream:stopped → startTestPlayback()
  startTestPlayback()  → test:playback-started → (playback biter) → test:completed
  cancelTest()         → stream:stopped → test:cancelled
```

## Gelistirme

**Yeni ayar eklemek:**
1. `Config.js` → SETTINGS'e ekle
2. `index.html` → HTML kontrol ekle (Settings Drawer icinde)
3. `ProfileUIManager.js` otomatik isle

**Yeni profil eklemek:**
1. `Config.js` → PROFILES'a createProfile() ile ekle
2. Sidebar'a HTML ekle (data-profile attribute)

---

## Mevcut Helper Katalogu

> Kod yazarken once bu listeyi kontrol et! DRY ihlalinden kacin.

### utils.js (js/modules/utils.js)

| Helper | Amac |
|--------|------|
| `stopStreamTracks(stream)` | MediaStream track'lerini durdur |
| `createAudioContext(opts)` | AudioContext factory + resume |
| `getAudioContextOptions(stream)` | Sample rate matching |
| `createMediaRecorder(stream, opts)` | MimeType fallback |
| `getStreamErrorMessage(err)` | getUserMedia hata mesaji cevirisi |
| `wrapAsyncHandler(fn, msg)` | Async try-catch wrapper |
| `toggleDisplay(el, show, display)` | DOM visibility |
| `formatTime(seconds)` | MM:SS format |
| `getBestAudioMimeType()` | Tarayici destekli mimeType |
| `createAndPlayActivatorAudio(stream, ctx)` | Chrome/WebRTC remote stream aktivasyonu |
| `cleanupActivatorAudio(audio)` | Activator audio element temizligi |

### Pipeline Helper'lari (utils.js)

| Helper | Amac |
|--------|------|
| `needsBufferSetting(pipeline)` | Buffer ayari gerekli mi? |
| `usesWebAudio(pipeline)` | WebAudio kullaniyor mu? |
| `usesWasmOpus(encoder)` | WASM Opus kullaniyor mu? |
| `usesMediaRecorder(encoder)` | MediaRecorder kullaniyor mu? |
| `usesPcmWav(encoder)` | PCM/WAV kullaniyor mu? |
| `supportsWasmOpusEncoder(pipeline)` | WASM Opus destekler mi? |

### SettingTypeHandlers (utils.js - OCP)

```javascript
// Yeni setting tipi eklemek (OCP uyumlu)
SettingTypeHandlers.register('newType', {
  group: 'newTypes',
  render({ key, setting, isLocked, currentValue }) { ... }
});
```

### BasePipeline (js/pipelines/BasePipeline.js)

| Method | Amac |
|--------|------|
| `cleanup()` | Node disconnect loop (DRY) |
| `log(msg, details)` | Merkezi log:webaudio emit |
| `createAnalyser()` | VU Meter icin AnalyserNode olustur |
| `_initOpusWorker(mediaBitrate, channels)` | WASM Opus worker kurulumu (VBR/CBR) |
| `_cleanupOpusWorker()` | Opus worker temizligi |
| `_createMuteGain(sourceNode)` | WASM Opus icin mute GainNode |
| `getOpusWorker()` | Opus worker referansi |
| `finishOpusEncoding()` | Encoding bitir, blob dondur |

### constants.js (js/modules/constants.js)

| Sabit | Amac |
|-------|------|
| `AUDIO` | FFT_SIZE, SMOOTHING_TIME_CONSTANT, DEFAULT_SAMPLE_RATE |
| `DELAY` | DEFAULT_SECONDS (1.7), MAX_SECONDS (3.0) |
| `BUFFER` | DEFAULT_SIZE (4096), WARNING_THRESHOLD |
| `OPUS` | FRAME_SIZE (960) - 20ms @ 48kHz |
| `TEST` | DURATION_MS (7000) - Test kayit suresi |
| `SIGNAL` | MAX_WAIT_MS, POLL_INTERVAL_MS, RMS_THRESHOLD |
| `LOOPBACK` | ICE_WAIT_MS |

| Helper | Amac |
|--------|------|
| `rmsToDb(rms)` | RMS -> dB donusumu |
| `dbToPercent(dB)` | dB -> yuzde donusumu |
| `calculateLatencyMs(sampleRate, bufferSize)` | Gecikme hesaplama |
| `bitrateToKbps(bps)` | Bitrate format |
| `bytesToKB(bytes)` | Boyut format |

---

## Effect Decorator Pattern (Gelecek Ozellik)

Pipeline'lara runtime'da efekt eklemek icin Decorator Pattern altyapisi.

```javascript
import { JitterEffect, PacketLossEffect, applyEffects } from '../pipelines/effects/index.js';
const withJitter = new JitterEffect(basePipeline, { maxDelay: 0.15 });
// veya toplu: applyEffects(pipeline, [{ type: 'jitter', options: {...} }])
```

| Efekt | Amac | Ayarlar |
|-------|------|---------|
| `JitterEffect` | Network gecikme | `minDelay`, `maxDelay`, `interval` |
| `PacketLossEffect` | Paket kaybi | `lossRate`, `burstLength` |

**Yeni efekt:** `EffectDecorator` extend et, `_setupEffect()` implement et, `effects/index.js`'e ekle

---

## Unit Test Altyapisi

Browser-based minimal test framework. Console'da calistir:
```javascript
import('./js/tests/pipelines.test.js').then(m => m.runPipelineTests())
```

Yeni test: `TestRunner` import et, `runner.test('desc', async () => { assert.equal(...) })`, `runner.run()`
