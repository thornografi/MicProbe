/**
 * RecordingController - Kayit islemlerini yonetir
 * Record kategorisinin UI/state akisi; encoder secimini Recorder'a iletir
 * DIP: Bagimliliklar dependency injection ile alinir
 */
import eventBus from '../modules/EventBus.js';
import { PIPELINE_TYPES, EVENTS } from '../modules/constants.js';
import { log, beginPreparing, endPreparing, resetState, getStreamErrorMessage } from '../modules/utils.js';

class RecordingController {
  constructor() {
    // Dependency injection ile gelen fonksiyonlar
    this.deps = {
      getConstraints: () => ({}),
      getPipeline: () => PIPELINE_TYPES.DIRECT,
      getEncoder: () => 'mediarecorder',
      isWebAudioEnabled: () => false,
      getTimeslice: () => 0,
      getBufferSize: () => 4096,
      getMediaBitrate: () => 0,
      // Modul referanslari
      recorder: null,
      player: null,
      uiStateManager: null,
      // State yonetimi
      setCurrentMode: () => {},
      getCurrentMode: () => null,
      setIsPreparing: () => {}
    };
    this._stopPromise = null;
    this._startAttempt = null;
    eventBus.on(EVENTS.RECORDER_STOPPED, () => {
      if (this.deps.getCurrentMode() === 'recording') {
        this.deps.uiStateManager?.stopTimer();
        resetState(this.deps);
      }
    });
    eventBus.on(EVENTS.RECORDING_CAPTURE_STOPPED, () => {
      if (this.deps.getCurrentMode() === 'recording') {
        this.deps.uiStateManager?.stopTimer();
        beginPreparing(this.deps, 'recording');
      }
    });
  }

  /**
   * Bagimliliklari set et
   * @param {Object} deps - Bagimliliklar
   */
  setDependencies(deps) {
    Object.assign(this.deps, deps);
  }

  /**
   * Kayit baslatma - toggle mantigi
   */
  async toggle() {
    if (this.deps.getIsPreparing?.()) {
      // Preparation can be cancelled; file finalization still shares one Stop.
      if (this._startAttempt) await this.stop();
      return;
    }

    if (this.deps.getCurrentMode() === 'recording') {
      await this.stop();
    } else {
      await this.start();
    }
  }

  /**
   * Kayit baslat
   */
  async start() {
    if (this._stopPromise || this.deps.getIsPreparing?.() || this.deps.getCurrentMode()) return;
    const attempt = this._startAttempt = { cancelled: false, snapshot: this.deps.createRunSnapshot?.() };
    const useWebAudio = this.deps.isWebAudioEnabled();
    const constraints = this.deps.getConstraints();
    const pipeline = useWebAudio ? this.deps.getPipeline() : PIPELINE_TYPES.DIRECT;
    // Encoder profil tarafindan belirleniyor (artik kullanici secimi yok)
    const encoder = this.deps.getEncoder();

    log.recorder('Record Start button pressed', { constraints, webAudioEnabled: useWebAudio, pipeline, encoder });
    eventBus.emit(EVENTS.UI_CLEAR_MESSAGE);

    try {
      // Preparing state - mode'u hemen set et (UI hangi butonun preparing oldugunu bilsin)
      beginPreparing(this.deps, 'recording');

      if (this.deps.testAccess && !await this.deps.testAccess.begin(attempt.snapshot)) {
        if (this._startAttempt === attempt) resetState(this.deps);
        return;
      }
      if (attempt.cancelled) { await this.deps.testAccess?.release(attempt.snapshot?.runId); return; }
      this.deps.player?.pause();

      // Normal kayit (Recorder modulu uzerinden)
      const timeslice = this.deps.getTimeslice();
      const mediaBitrate = this.deps.getMediaBitrate();
      const bufferSize = this.deps.getBufferSize();

      const runSnapshot = attempt.snapshot;
      await this.deps.recorder.start(constraints, pipeline, encoder, timeslice, bufferSize, mediaBitrate, runSnapshot);
      if (attempt.cancelled) { await this.deps.testAccess?.release(runSnapshot?.runId); return; }

      // UI guncelle - mode zaten set edildi, sadece preparing'i kapat
      endPreparing(this.deps);
      this.deps.uiStateManager?.startTimer();

    } catch (err) {
      void this.deps.testAccess?.release(attempt.snapshot?.runId);
      if (attempt.cancelled) return;
      const userMessage = getStreamErrorMessage(err);
      log.error('Recording failed to start', { error: err.message });
      eventBus.emit(EVENTS.UI_MESSAGE, {
        message: `${userMessage}. Check microphone access and try recording again.`,
        tone: 'error'
      });

      // Temizlik
      resetState(this.deps);
      this.deps.uiStateManager?.stopTimer();
    } finally {
      if (this._startAttempt === attempt) this._startAttempt = null;
    }
  }

  /**
   * Kayit durdur
   */
  stop() {
    if (this._stopPromise) return this._stopPromise;
    if (this._startAttempt) this._startAttempt.cancelled = true;
    this._stopPromise = this._stop().finally(() => { this._stopPromise = null; });
    return this._stopPromise;
  }

  async _stop() {
    log.recorder('Recording stopping', {});

    try {
      this.deps.uiStateManager?.stopTimer();
      await this.deps.recorder?.stop();
    } catch (err) {
      log.error('Recording stop error', { error: err.message, stack: err.stack });
    } finally {
      // Her durumda state reset - hata olsa bile UI tutarli kalsin
      resetState(this.deps);
    }
  }
}

// Singleton export
const recordingController = new RecordingController();
export default recordingController;
