/**
 * MonitoringController - Monitor islemlerini yonetir
 * OCP: Loopback ve normal monitor modlari ayri metodlarda
 * DIP: Bagimliliklar dependency injection ile alinir
 * SRP: Test flow TestRecordingFlow'a delege edildi
 */
import eventBus from '../modules/EventBus.js';
import loopbackManager from '../modules/LoopbackManager.js';
import { DELAY, PIPELINE_TYPES, EVENTS } from '../modules/constants.js';
import { stopStreamTracks, log, beginPreparing, endPreparing, resetState, getStreamErrorMessage } from '../modules/utils.js';
import { requestStream } from '../modules/StreamHelper.js';
import TestRecordingFlow from './TestRecordingFlow.js';

class MonitoringController {
  constructor() {
    // Monitoring state
    this.loopbackLocalStream = null;
    this._startedWithLoopback = false; // BUG-1 fix: start-time loopback durumunu kaydet

    // Dependency injection ile gelen fonksiyonlar
    this.deps = {
      getConstraints: () => ({}),
      getPipeline: () => PIPELINE_TYPES.DIRECT,
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

    // SRP: Test flow ayri sinifta
    this._testFlow = new TestRecordingFlow(this);
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
    const pipeline = useWebAudio ? this.deps.getPipeline() : PIPELINE_TYPES.DIRECT;

    // Pipeline aciklamasi
    const pipelineDesc = this._buildPipelineDescription(useLoopback, pipeline);

    log.stream('Monitor Start button pressed', { constraints, webAudioEnabled: useWebAudio, loopbackEnabled: useLoopback, pipeline, pipelineDesc });
    eventBus.emit(EVENTS.UI_CLEAR_MESSAGE);

    try {
      // Player'i durdur
      this.deps.player?.pause();

      // Preparing state - mode'u hemen set et (UI hangi butonun preparing oldugunu bilsin)
      beginPreparing(this.deps, 'monitoring');

      // BUG-1 fix: start-time'da loopback durumunu kaydet (stop'da kullanilacak)
      this._startedWithLoopback = useLoopback;

      if (useLoopback) {
        await this._startLoopbackMonitoring(constraints, pipeline);
      } else {
        await this._startNormalMonitoring(constraints, pipeline);
      }

    } catch (err) {
      const userMessage = getStreamErrorMessage(err);
      log.error('Monitor failed to start', { error: err.message });
      eventBus.emit(EVENTS.UI_MESSAGE, {
        message: `${userMessage}. Check microphone access, then try Monitor again.`,
        tone: 'error'
      });

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
    log.loopback('Starting monitor in loopback mode...');

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
    eventBus.emit(EVENTS.STREAM_STARTED, this.loopbackLocalStream);  // Local VU Meter
    eventBus.emit(EVENTS.LOOPBACK_REMOTE_STREAM, remoteStream);       // Remote VU Meter

    log.loopback('Loopback monitor ready');
  }

  /**
   * Normal monitoring (loopback kapali)
   */
  async _startNormalMonitoring(constraints, pipeline) {
    const monitor = this.deps.monitor;
    const useWebAudio = this.deps.isWebAudioEnabled();

    // OCP: Pipeline tipine gore dispatch — yeni tip eklemek icin Monitor.MONITOR_DISPATCH'e satir ekle
    const type = useWebAudio ? pipeline : PIPELINE_TYPES.DIRECT;
    await monitor.start(type, constraints, { bufferSize: this.deps.getBufferSize() });

    // UI guncelle - mode zaten set edildi, sadece preparing'i kapat
    endPreparing(this.deps);
  }

  /**
   * Monitor durdur
   */
  async stop() {
    // BUG-1 fix: start-time'daki loopback durumunu oku (checkbox'in o anki hali degil)
    const useLoopback = this._startedWithLoopback;

    log.stream('Monitor stopping', { loopbackEnabled: useLoopback });

    try {
      if (useLoopback) {
        await this._stopLoopbackMonitoring();
      } else {
        await this.deps.monitor?.stop();
      }
    } catch (err) {
      log.error('Monitor stop error', { error: err.message, stack: err.stack, loopback: useLoopback });
    } finally {
      // Her durumda state reset - hata olsa bile UI tutarli kalsin
      resetState(this.deps);
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

    eventBus.emit(EVENTS.STREAM_STOPPED);
    log.loopback('Loopback monitor stopped');
    eventBus.emit(EVENTS.MONITOR_STOPPED, { mode: stoppedMode, loopback: true });
  }

  // === TEST DELEGASYONU (SRP: TestRecordingFlow) ===

  /** Test toggle - TestRecordingFlow'a delege */
  async toggleTest() { return this._testFlow.toggle(); }

  /** Test kayit baslat - TestRecordingFlow'a delege */
  async startTestRecording() { return this._testFlow.startRecording(); }

  /** Test kayit durdur - TestRecordingFlow'a delege */
  async stopTestRecording() { return this._testFlow.stopRecording(); }

  /** Test playback baslat - TestRecordingFlow'a delege */
  async startTestPlayback() { return this._testFlow.startPlayback(); }

  /** Test playback durdur - TestRecordingFlow'a delege */
  async stopTestPlayback() { return this._testFlow.stopPlayback(); }

  /** Test iptal - TestRecordingFlow'a delege */
  async cancelTest() { return this._testFlow.cancel(); }

  /** Test phase getter (UI state icin) */
  get testPhase() { return this._testFlow.testPhase; }

  // === HELPER METODLAR ===

  _buildPipelineDescription(useLoopback, pipeline) {
    const delayStr = `${DELAY.DEFAULT_SECONDS}sn Delay`;
    const pipelineStr = pipeline === PIPELINE_TYPES.SCRIPTPROCESSOR ? 'ScriptProcessor (WebAudio)'
                      : pipeline === PIPELINE_TYPES.WORKLET ? 'Worklet (WebAudio)'
                      : pipeline === PIPELINE_TYPES.DIRECT ? 'Direct'
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
