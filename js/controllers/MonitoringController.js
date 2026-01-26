/**
 * MonitoringController - Monitor islemlerini yonetir
 * OCP: Loopback ve normal monitor modlari ayri metodlarda
 * DIP: Bagimliliklar dependency injection ile alinir
 */
import eventBus from '../modules/EventBus.js';
import loopbackManager from '../modules/LoopbackManager.js';
import { DELAY, TEST } from '../modules/constants.js';
import { stopStreamTracks, createMediaRecorder, createAndPlayActivatorAudio, cleanupActivatorAudio, log, beginPreparing, endPreparing, resetState } from '../modules/utils.js';
import { requestStream } from '../modules/StreamHelper.js';

class MonitoringController {
  constructor() {
    // Monitoring state
    this.loopbackLocalStream = null;

    // Test state
    this.testTimerId = null;
    this.testCountdownInterval = null;
    this.testMediaRecorder = null;
    this.testAudioBlob = null;
    this.testAudioElement = null;
    this.testAudioUrl = null;
    this.testActivatorAudio = null;  // Chrome/WebRTC activator
    this.testPhase = null;  // 'recording' | 'playback' | null
    this.testChunks = [];

    // Dependency injection ile gelen fonksiyonlar
    this.deps = {
      getConstraints: () => ({}),
      getPipeline: () => 'direct',
      isLoopbackEnabled: () => false,
      isWebAudioEnabled: () => false,
      getOpusBitrate: () => 64000,
      getTimeslice: () => 0,
      getBufferSize: () => 4096,
      getMediaBitrate: () => 0,
      // Modul referanslari
      monitor: null,
      player: null,
      uiStateManager: null,
      // State yonetimi
      setCurrentMode: () => {},
      getCurrentMode: () => null,
      setIsPreparing: () => {}
    };
  }

  /**
   * Bagimliliklari set et
   */
  setDependencies(deps) {
    Object.assign(this.deps, deps);
  }

  /**
   * Monitor toggle
   */
  async toggle() {
    // GUARD: Async islem devam ederken tekrar cagrilmasin (rapid click korunmasi)
    if (this.deps.getIsPreparing?.()) return;

    if (this.deps.getCurrentMode() === 'monitoring') {
      await this.stop();
    } else {
      await this.start();
    }
  }

  /**
   * Monitor baslat
   */
  async start() {
    const useWebAudio = this.deps.isWebAudioEnabled();
    const useLoopback = this.deps.isLoopbackEnabled();
    const constraints = this.deps.getConstraints();
    const pipeline = useWebAudio ? this.deps.getPipeline() : 'direct';

    // Pipeline aciklamasi
    const pipelineDesc = this._buildPipelineDescription(useLoopback, pipeline);

    log.stream('Monitor Baslat butonuna basildi', { constraints, webAudioEnabled: useWebAudio, loopbackEnabled: useLoopback, pipeline, pipelineDesc });

    try {
      // Player'i durdur
      this.deps.player?.pause();

      // Preparing state - mode'u hemen set et (UI hangi butonun preparing oldugunu bilsin)
      beginPreparing(this.deps, 'monitoring');

      if (useLoopback) {
        await this._startLoopbackMonitoring(constraints, pipeline);
      } else {
        await this._startNormalMonitoring(constraints, pipeline);
      }

    } catch (err) {
      log.error('Monitor baslatilamadi', { error: err.message });
      log.error(`HATA: ${err.message}`);

      // Temizlik
      resetState(this.deps);
      await loopbackManager.cleanupMonitorPlayback();
      await loopbackManager.cleanup();
      stopStreamTracks(this.loopbackLocalStream);
      this.loopbackLocalStream = null;
    }
  }

  /**
   * Loopback monitoring
   */
  async _startLoopbackMonitoring(constraints, pipeline) {
    log.loopback('Loopback modunda monitor baslatiliyor...');

    // Mikrofon al (requestStream ile constraint mismatch kontrolu dahil)
    this.loopbackLocalStream = await requestStream(constraints);

    // WebRTC loopback kur
    const opusBitrate = this.deps.getOpusBitrate();
    const remoteStream = await loopbackManager.setup(this.loopbackLocalStream, {
      useWebAudio: this.deps.isWebAudioEnabled(),
      opusBitrate
    });

    // Remote stream'i hoparlore bagla
    await loopbackManager.startMonitorPlayback(remoteStream, {
      mode: pipeline,
      bufferSize: this.deps.getBufferSize()
    });

    // UI guncelle - mode zaten set edildi, sadece preparing'i kapat
    endPreparing(this.deps);

    // Events
    eventBus.emit('stream:started', this.loopbackLocalStream);  // Local VU Meter
    eventBus.emit('loopback:remoteStream', remoteStream);       // Remote VU Meter

    log.loopback('Loopback monitor hazir');
  }

  /**
   * Normal monitoring (loopback kapali)
   */
  async _startNormalMonitoring(constraints, pipeline) {
    const monitor = this.deps.monitor;
    const useWebAudio = this.deps.isWebAudioEnabled();

    if (useWebAudio) {
      // WEBAUDIO MODE
      if (pipeline === 'direct') {
        await monitor.startDirect(constraints);
      } else if (pipeline === 'scriptprocessor') {
        await monitor.startScriptProcessor(constraints, this.deps.getBufferSize());
      } else if (pipeline === 'worklet') {
        await monitor.startAudioWorklet(constraints);
      } else {
        await monitor.startWebAudio(constraints);
      }
    } else {
      await monitor.startDirect(constraints);
    }

    // UI guncelle - mode zaten set edildi, sadece preparing'i kapat
    endPreparing(this.deps);
  }

  /**
   * Monitor durdur
   */
  async stop() {
    const useLoopback = this.deps.isLoopbackEnabled();

    log.stream('Monitor durduruluyor', { loopbackEnabled: useLoopback });

    try {
      if (useLoopback) {
        await this._stopLoopbackMonitoring();
      } else {
        await this.deps.monitor?.stop();
      }
    } catch (err) {
      log.error('Monitor durdurma hatasi', { error: err.message, stack: err.stack, loopback: useLoopback });
    } finally {
      // Her durumda state reset - hata olsa bile UI tutarli kalsin
      this.deps.setCurrentMode(null);
      this.deps.uiStateManager?.updateButtonStates();
    }
  }

  /**
   * Loopback monitoring durdur
   */
  async _stopLoopbackMonitoring() {
    // Mode bilgisini al (cleanup oncesi)
    const stoppedMode = loopbackManager.monitorMode;

    // Loopback monitor playback temizle
    await loopbackManager.cleanupMonitorPlayback();

    // Local stream durdur
    stopStreamTracks(this.loopbackLocalStream);
    this.loopbackLocalStream = null;

    // WebRTC temizle
    await loopbackManager.cleanup();

    eventBus.emit('stream:stopped');
    log.loopback('Loopback monitor durduruldu');
    eventBus.emit('monitor:stopped', { mode: stoppedMode, loopback: true });
  }

  // === TEST METODLARI ===

  /**
   * Test toggle (test butonuna tiklandiginda)
   * Skype/Zoom pattern: Kayit sirasinda tiklanirsa erken durdur ve playback'e gec
   */
  async toggleTest() {
    // GUARD: Async islem devam ederken tekrar cagrilmasin (rapid click korunmasi)
    if (this.deps.getIsPreparing?.()) return;

    if (this.testPhase === 'recording') {
      // Erken durdur -> playback'e gec (iptal degil)
      await this.stopTestRecording();
    } else if (this.testPhase === 'playback') {
      await this.stopTestPlayback();
    } else {
      await this.startTestRecording();
    }
  }

  /**
   * Test kaydi baslat (7sn loopback buffer)
   */
  async startTestRecording() {
    const constraints = this.deps.getConstraints();
    const opusBitrate = this.deps.getOpusBitrate();

    log.stream('Test kaydi baslatiliyor', { constraints, opusBitrate, duration: TEST.DURATION_MS });

    try {
      // Player'i durdur
      this.deps.player?.pause();

      // Preparing state - mode'u hemen set et (UI hangi butonun preparing oldugunu bilsin)
      beginPreparing(this.deps, 'test-recording');

      // Mikrofon al
      this.loopbackLocalStream = await requestStream(constraints);

      // DRY: LoopbackManager.setup() dogrudan kullan
      // NOT: startMonitorPlayback() CAGRILMIYOR - hoparlor muted
      const remoteStream = await loopbackManager.setup(this.loopbackLocalStream, {
        useWebAudio: this.deps.isWebAudioEnabled(),
        opusBitrate
      });

      // DRY: Chrome/WebRTC activator audio helper kullan
      this.testActivatorAudio = await createAndPlayActivatorAudio(remoteStream, 'Test');

      // DRY: createMediaRecorder helper kullan
      this.testChunks = [];
      this.testMediaRecorder = createMediaRecorder(remoteStream);
      this.testMediaRecorder.ondataavailable = (e) => {
        if (e.data.size) this.testChunks.push(e.data);
      };
      this.testMediaRecorder.start();

      // State guncelle - mode zaten set edildi, sadece preparing'i kapat
      this.testPhase = 'recording';
      endPreparing(this.deps);

      // VU Meter icin event'ler
      eventBus.emit('stream:started', this.loopbackLocalStream);
      eventBus.emit('loopback:remoteStream', remoteStream);

      // Timer baslat
      this._startTestTimer();
      eventBus.emit('test:recording-started', { durationMs: TEST.DURATION_MS });
      log.stream(`Test kaydi basladi (${TEST.DURATION_MS / 1000}sn)`);

    } catch (err) {
      log.error('Test kaydi baslatilamadi', { error: err.message });
      log.error(`Test hatasi: ${err.message}`);
      // Preparing flag'i temizle (UI "Preparing" durumunda takilmasin)
      this.deps.setIsPreparing(false);
      await this._cleanupTest();
    }
  }

  /**
   * Test kaydini durdur ve playback'e gec
   */
  async stopTestRecording() {
    this._clearTestTimer();

    log.stream('Test kaydi durduruluyor', {});

    // onstop handler'i ONCE set et, SONRA stop() cagir (race condition fix)
    const stopPromise = new Promise(resolve => {
      this.testMediaRecorder.onstop = () => {
        this.testAudioBlob = new Blob(this.testChunks, { type: this.testMediaRecorder.mimeType || 'audio/webm' });
        log.recorder(`MediaRecorder onstop: ${this.testChunks.length} chunk, ${this.testAudioBlob.size} bytes`);
        resolve();
      };
    });

    // MediaRecorder'i durdur
    if (this.testMediaRecorder?.state !== 'inactive') {
      this.testMediaRecorder.stop();
    }

    // onstop'u bekle
    await stopPromise;

    // VU Meter event'leri
    eventBus.emit('stream:stopped');

    // DRY: LoopbackManager.cleanup() dogrudan kullan
    await loopbackManager.cleanup();
    stopStreamTracks(this.loopbackLocalStream);
    this.loopbackLocalStream = null;

    eventBus.emit('test:recording-stopped');
    log.stream('Test kaydi tamamlandi, playback basliyor...');

    // Playback'e gec
    await this.startTestPlayback();
  }

  /**
   * Test playback baslat
   */
  async startTestPlayback() {
    // Blob kontrolu
    if (!this.testAudioBlob || this.testAudioBlob.size === 0) {
      log.error('Test playback hatasi: Ses verisi yok', { blobExists: !!this.testAudioBlob, blobSize: this.testAudioBlob?.size || 0, chunksCount: this.testChunks?.length || 0 });
      log.error('Test kaydi bos - ses verisi alinamadi');
      await this._cleanupTest();
      return;
    }

    this.testPhase = 'playback';
    this.deps.setCurrentMode('test-playback');
    this.deps.uiStateManager?.updateButtonStates();

    log.stream('Test playback baslatiliyor', { blobSize: this.testAudioBlob.size, blobType: this.testAudioBlob.type });

    // Basit Audio element ile oynat
    this.testAudioUrl = URL.createObjectURL(this.testAudioBlob);
    this.testAudioElement = new Audio(this.testAudioUrl);

    this.testAudioElement.onended = async () => {
      log.stream('Test tamamlandi');
      await this._cleanupTest();
      eventBus.emit('test:completed');
    };

    this.testAudioElement.onerror = async (e) => {
      // Audio element error event'i MediaError objesi dondurur
      const mediaError = this.testAudioElement?.error;
      const errorCode = mediaError?.code;
      const errorMsg = mediaError?.message || 'Unknown error';
      log.error('Test playback hatasi', { errorCode, errorMsg, blobType: this.testAudioBlob?.type });
      await this._cleanupTest();
    };

    try {
      await this.testAudioElement.play();
      eventBus.emit('test:playback-started');
      log.player('Test playback basladi');
    } catch (err) {
      log.error('Test play hatasi', { error: err.message, name: err.name, blobSize: this.testAudioBlob?.size });
      await this._cleanupTest();
    }
  }

  /**
   * Test playback durdur
   */
  async stopTestPlayback() {
    if (this.testAudioElement) {
      this.testAudioElement.pause();
      this.testAudioElement.onended = null;
      this.testAudioElement.onerror = null;
    }
    log.player('Test playback durduruldu');
    await this._cleanupTest();
    eventBus.emit('test:playback-stopped');
  }

  /**
   * Test iptal (kayit sirasinda)
   */
  async cancelTest() {
    this._clearTestTimer();

    log.stream('Test iptal ediliyor', {});

    if (this.testMediaRecorder?.state !== 'inactive') {
      this.testMediaRecorder.stop();
    }

    // DRY: Mevcut cleanup fonksiyonlari kullan
    eventBus.emit('stream:stopped');
    await loopbackManager.cleanup();
    stopStreamTracks(this.loopbackLocalStream);
    this.loopbackLocalStream = null;

    log.stream('Test iptal edildi');
    await this._cleanupTest();
    eventBus.emit('test:cancelled');
  }

  /**
   * Test timer baslat
   * @private
   */
  _startTestTimer() {
    let remaining = TEST.DURATION_MS;

    // Ilk countdown
    eventBus.emit('test:countdown', { remainingSec: Math.ceil(remaining / 1000) });

    // Countdown interval (her saniye)
    this.testCountdownInterval = setInterval(() => {
      remaining -= 1000;
      const remainingSec = Math.ceil(remaining / 1000);
      eventBus.emit('test:countdown', { remainingSec: remainingSec > 0 ? remainingSec : 0 });
    }, 1000);

    // Ana timer (7 sn sonra dur)
    this.testTimerId = setTimeout(() => this.stopTestRecording(), TEST.DURATION_MS);
  }

  /**
   * Test timer'larini temizle
   * @private
   */
  _clearTestTimer() {
    if (this.testTimerId) {
      clearTimeout(this.testTimerId);
      this.testTimerId = null;
    }
    if (this.testCountdownInterval) {
      clearInterval(this.testCountdownInterval);
      this.testCountdownInterval = null;
    }
  }

  /**
   * Test kaynaklarini temizle
   * @private
   */
  async _cleanupTest() {
    this._clearTestTimer();

    this.testMediaRecorder = null;
    this.testChunks = [];
    this.testAudioBlob = null;

    if (this.testAudioUrl) {
      URL.revokeObjectURL(this.testAudioUrl);
      this.testAudioUrl = null;
    }

    if (this.testAudioElement) {
      this.testAudioElement.pause();
      this.testAudioElement.onended = null;
      this.testAudioElement.onerror = null;
      this.testAudioElement = null;
    }

    // DRY: Activator audio temizle
    cleanupActivatorAudio(this.testActivatorAudio);
    this.testActivatorAudio = null;

    this.testPhase = null;
    resetState(this.deps);
  }

  // === HELPER METODLAR ===

  _buildPipelineDescription(useLoopback, pipeline) {
    const delayStr = `${DELAY.DEFAULT_SECONDS}sn Delay`;
    const pipelineStr = pipeline === 'scriptprocessor' ? 'ScriptProcessor (WebAudio)'
                      : pipeline === 'worklet' ? 'Worklet (WebAudio)'
                      : pipeline === 'direct' ? 'Direct'
                      : 'Direct (WebAudio)';

    if (useLoopback) {
      return `WebRTC Loopback + ${pipelineStr} + ${delayStr} -> Speaker`;
    } else {
      return `${pipelineStr} + ${delayStr} -> Speaker`;
    }
  }

  /**
   * Loopback local stream'e erisim (VuMeter icin)
   */
  getLoopbackLocalStream() {
    return this.loopbackLocalStream;
  }
}

// Singleton export
const monitoringController = new MonitoringController();
export default monitoringController;
