/**
 * RecordingController - Kayit islemlerini yonetir
 * Sadece normal kayit (MediaRecorder) - Loopback recording kaldirildi
 * DIP: Bagimliliklar dependency injection ile alinir
 */
import eventBus from '../modules/EventBus.js';
import { PIPELINE_TYPES } from '../modules/constants.js';
import { log, beginPreparing, endPreparing, resetState } from '../modules/utils.js';

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
    // GUARD: Async islem devam ederken tekrar cagrilmasin (rapid click korunmasi)
    if (this.deps.getIsPreparing?.()) return;

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
    const useWebAudio = this.deps.isWebAudioEnabled();
    const constraints = this.deps.getConstraints();
    const pipeline = useWebAudio ? this.deps.getPipeline() : PIPELINE_TYPES.DIRECT;
    // Encoder profil tarafindan belirleniyor (artik kullanici secimi yok)
    const encoder = this.deps.getEncoder();

    log.recorder('Kayit baslat butonuna basildi', { constraints, webAudioEnabled: useWebAudio, pipeline, encoder });

    try {
      // Kayit baslarken oynaticiyi durdur
      this.deps.player?.pause();

      // Preparing state - mode'u hemen set et (UI hangi butonun preparing oldugunu bilsin)
      beginPreparing(this.deps, 'recording');

      // Normal kayit (Recorder modulu uzerinden)
      const timeslice = this.deps.getTimeslice();
      const mediaBitrate = this.deps.getMediaBitrate();
      const bufferSize = this.deps.getBufferSize();

      await this.deps.recorder.start(constraints, pipeline, encoder, timeslice, bufferSize, mediaBitrate);

      // UI guncelle - mode zaten set edildi, sadece preparing'i kapat
      endPreparing(this.deps);
      this.deps.uiStateManager?.startTimer();

    } catch (err) {
      log.error('Kayit baslatilamadi', { error: err.message });

      // Temizlik
      resetState(this.deps);
      this.deps.uiStateManager?.stopTimer();
    }
  }

  /**
   * Kayit durdur
   */
  async stop() {
    log.recorder('Kayit durduruluyor', {});

    try {
      this.deps.uiStateManager?.stopTimer();
      await this.deps.recorder?.stop();
    } catch (err) {
      log.error('Kayit durdurma hatasi', { error: err.message, stack: err.stack });
    } finally {
      // Her durumda state reset - hata olsa bile UI tutarli kalsin
      resetState(this.deps);
    }
  }
}

// Singleton export
const recordingController = new RecordingController();
export default recordingController;
