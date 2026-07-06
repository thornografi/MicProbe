/**
 * TestRecordingFlow - Loopback test kayit ve playback akisi
 * SRP: MonitoringController'dan ayrildi, sadece test flow'undan sorumlu
 * DIP: Bagimliliklar controller uzerinden alinir
 */
import eventBus from '../modules/EventBus.js';
import loopbackManager from '../modules/LoopbackManager.js';
import { TEST, EVENTS } from '../modules/constants.js';
import { stopStreamTracks, createMediaRecorder, createAndPlayActivatorAudio, cleanupActivatorAudio, log, beginPreparing, endPreparing, resetState, getStreamErrorMessage } from '../modules/utils.js';
import { requestStream } from '../modules/StreamHelper.js';

class TestRecordingFlow {
  /**
   * @param {object} controller - MonitoringController referansi (deps ve loopbackLocalStream icin)
   */
  constructor(controller) {
    this.controller = controller;

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
  }

  /** @returns {object} Controller deps */
  get deps() {
    return this.controller.deps;
  }

  /**
   * Test toggle (test butonuna tiklandiginda)
   * Skype/Zoom pattern: Kayit sirasinda tiklanirsa erken durdur ve playback'e gec
   */
  async toggle() {
    // GUARD: Async islem devam ederken tekrar cagrilmasin (rapid click korunmasi)
    if (this.deps.getIsPreparing?.()) return;

    if (this.testPhase === 'recording') {
      // Erken durdur -> playback'e gec (iptal degil)
      await this.stopRecording();
    } else if (this.testPhase === 'stopping') {
      // Durdurma async surecinde - ikinci tiklamayi yut (re-entry/deadlock onleme)
      return;
    } else if (this.testPhase === 'playback') {
      await this.stopPlayback();
    } else {
      await this.startRecording();
    }
  }

  /**
   * Test kaydi baslat (7sn loopback buffer)
   */
  async startRecording() {
    const constraints = this.deps.getConstraints();
    const opusBitrate = this.deps.getOpusBitrate();

    log.stream('Test recording starting', { constraints, opusBitrate, duration: TEST.DURATION_MS });
    eventBus.emit(EVENTS.UI_CLEAR_MESSAGE);

    try {
      // Player'i durdur
      this.deps.player?.pause();

      // Preparing state - mode'u hemen set et (UI hangi butonun preparing oldugunu bilsin)
      beginPreparing(this.deps, 'test-recording');

      // Mikrofon al
      this.controller.loopbackLocalStream = await requestStream(constraints);

      // DRY: LoopbackManager.setup() dogrudan kullan
      // NOT: startMonitorPlayback() CAGRILMIYOR - hoparlor muted
      const remoteStream = await loopbackManager.setup(this.controller.loopbackLocalStream, {
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
      eventBus.emit(EVENTS.STREAM_STARTED, this.controller.loopbackLocalStream);
      eventBus.emit(EVENTS.LOOPBACK_REMOTE_STREAM, remoteStream);

      // Timer baslat
      this._startTimer();
      eventBus.emit(EVENTS.TEST_RECORDING_STARTED, { durationMs: TEST.DURATION_MS });
      log.stream(`Test recording started (${TEST.DURATION_MS / 1000}s)`);

    } catch (err) {
      const userMessage = getStreamErrorMessage(err);
      log.error('Test recording failed to start', { error: err.message });
      eventBus.emit(EVENTS.UI_MESSAGE, {
        message: `${userMessage}. Check microphone access, then try Test again.`,
        tone: 'error'
      });
      // Preparing flag'i temizle (UI "Preparing" durumunda takilmasin)
      this.deps.setIsPreparing(false);
      await this._cleanup();
    }
  }

  /**
   * Test kaydini durdur ve playback'e gec
   */
  async stopRecording() {
    // GUARD: stopRecording async surecindeyken (timer fire + erken tiklama yarisi)
    // ikinci kez girilmesin - aksi halde onstop overwrite olur ve ilk promise asla resolve olmaz
    if (this.testPhase === 'stopping') return;
    this.testPhase = 'stopping';

    this._clearTimer();

    log.stream('Test recording stopping', {});

    // onstop handler'i ONCE set et, SONRA stop() cagir (race condition fix)
    // 'inactive' recorder onstop tetiklemez (USB cihaz cekilmesi/ICE kopmasi) -> deadlock onlemek icin direkt resolve
    const recorder = this.testMediaRecorder;
    const stopPromise = new Promise(resolve => {
      if (!recorder || recorder.state === 'inactive') {
        this.testAudioBlob = this.testChunks.length
          ? new Blob(this.testChunks, { type: recorder?.mimeType || 'audio/webm' })
          : null;
        log.recorder(`MediaRecorder already inactive: ${this.testChunks.length} chunk`);
        resolve();
        return;
      }
      recorder.onstop = () => {
        this.testAudioBlob = new Blob(this.testChunks, { type: recorder.mimeType || 'audio/webm' });
        log.recorder(`MediaRecorder onstop: ${this.testChunks.length} chunk, ${this.testAudioBlob.size} bytes`);
        resolve();
      };
      recorder.stop();
    });

    // onstop'u bekle
    await stopPromise;

    // VU Meter event'leri
    eventBus.emit(EVENTS.STREAM_STOPPED);

    // DRY: LoopbackManager.cleanup() dogrudan kullan
    await loopbackManager.cleanup();
    stopStreamTracks(this.controller.loopbackLocalStream);
    this.controller.loopbackLocalStream = null;

    eventBus.emit(EVENTS.TEST_RECORDING_STOPPED);
    log.stream('Test recording complete, playback starting...');

    // Playback'e gec
    await this.startPlayback();
  }

  /**
   * Test playback baslat
   */
  async startPlayback() {
    // Blob kontrolu
    if (!this.testAudioBlob || this.testAudioBlob.size === 0) {
      log.error('Test playback error: No audio data', { blobExists: !!this.testAudioBlob, blobSize: this.testAudioBlob?.size || 0, chunksCount: this.testChunks?.length || 0 });
      log.error('Test recording empty - no audio data received');
      eventBus.emit(EVENTS.UI_MESSAGE, {
        message: 'No audio was captured. Check the selected microphone and try the test again.',
        tone: 'error'
      });
      await this._cleanup();
      eventBus.emit(EVENTS.TEST_CANCELLED);
      return;
    }

    this.testPhase = 'playback';
    this.deps.setCurrentMode('test-playback');
    this.deps.uiStateManager?.updateButtonStates();

    log.stream('Test playback starting', { blobSize: this.testAudioBlob.size, blobType: this.testAudioBlob.type });

    // Basit Audio element ile oynat
    this.testAudioUrl = URL.createObjectURL(this.testAudioBlob);
    this.testAudioElement = new Audio(this.testAudioUrl);

    this.testAudioElement.onended = async () => {
      log.stream('Test complete');
      await this._cleanup();
      eventBus.emit(EVENTS.TEST_COMPLETED);
    };

    this.testAudioElement.onerror = async (e) => {
      // Audio element error event'i MediaError objesi dondurur
      const mediaError = this.testAudioElement?.error;
      const errorCode = mediaError?.code;
      const errorMsg = mediaError?.message || 'Unknown error';
      log.error('Test playback error', { errorCode, errorMsg, blobType: this.testAudioBlob?.type });
      eventBus.emit(EVENTS.UI_MESSAGE, {
        message: 'Test playback failed. Try running the test again.',
        tone: 'error'
      });
      await this._cleanup();
      eventBus.emit(EVENTS.TEST_CANCELLED);
    };

    try {
      await this.testAudioElement.play();
      eventBus.emit(EVENTS.TEST_PLAYBACK_STARTED);
      log.player('Test playback started');
    } catch (err) {
      log.error('Test play error', { error: err.message, name: err.name, blobSize: this.testAudioBlob?.size });
      eventBus.emit(EVENTS.UI_MESSAGE, {
        message: 'Test playback failed. Try running the test again.',
        tone: 'error'
      });
      await this._cleanup();
      eventBus.emit(EVENTS.TEST_CANCELLED);
    }
  }

  /**
   * Test playback durdur
   */
  async stopPlayback() {
    if (this.testAudioElement) {
      this.testAudioElement.pause();
      this.testAudioElement.onended = null;
      this.testAudioElement.onerror = null;
    }
    log.player('Test playback stopped');
    await this._cleanup();
    eventBus.emit(EVENTS.TEST_PLAYBACK_STOPPED);
  }

  /**
   * Test iptal (kayit sirasinda)
   */
  async cancel() {
    this._clearTimer();

    log.stream('Test cancelling', {});

    if (this.testMediaRecorder?.state !== 'inactive') {
      this.testMediaRecorder.stop();
    }

    // DRY: Mevcut cleanup fonksiyonlari kullan
    eventBus.emit(EVENTS.STREAM_STOPPED);
    await loopbackManager.cleanup();
    stopStreamTracks(this.controller.loopbackLocalStream);
    this.controller.loopbackLocalStream = null;

    log.stream('Test cancelled');
    await this._cleanup();
    eventBus.emit(EVENTS.TEST_CANCELLED);
  }

  /**
   * Test timer baslat
   * @private
   */
  _startTimer() {
    let remaining = TEST.DURATION_MS;

    // Ilk countdown
    eventBus.emit(EVENTS.TEST_COUNTDOWN, { remainingSec: Math.ceil(remaining / 1000) });

    // Countdown interval (her saniye)
    this.testCountdownInterval = setInterval(() => {
      remaining -= 1000;
      const remainingSec = Math.ceil(remaining / 1000);
      eventBus.emit(EVENTS.TEST_COUNTDOWN, { remainingSec: remainingSec > 0 ? remainingSec : 0 });
    }, 1000);

    // Ana timer (7 sn sonra dur)
    this.testTimerId = setTimeout(() => this.stopRecording(), TEST.DURATION_MS);
  }

  /**
   * Test timer'larini temizle
   * @private
   */
  _clearTimer() {
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
  async _cleanup() {
    this._clearTimer();

    // Idempotent loopback + mikrofon temizligi - hata/erken cikis yollarinda sizinti onleme.
    // Normal stopRecording yolunda zaten temizlenmis olur; tum cagrilar null-safe oldugundan tekrar zararsiz.
    await loopbackManager.cleanup();
    stopStreamTracks(this.controller.loopbackLocalStream);
    this.controller.loopbackLocalStream = null;

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
}

export default TestRecordingFlow;
