/**
 * TestRecordingFlow - Loopback test kayit ve analiz akisi
 * SRP: MonitoringController'dan ayrildi, sadece test flow'undan sorumlu
 * DIP: Bagimliliklar controller uzerinden alinir
 *
 * Akis: kayit (7sn konusma) -> stopRecording -> startAnalysing (offline deep analiz +
 * gercek progress bar) -> TEST_COMPLETED -> rapor. Playback (geri dinletme) kaldirildi;
 * yerini kullanicinin duydugu "Analysing" fazi aldi.
 */
import eventBus from '../modules/EventBus.js';
import loopbackManager from '../modules/LoopbackManager.js';
import deepAnalysisEngine from '../modules/DeepAnalysisEngine.js';
import { TEST, EVENTS, DEEP_ANALYSIS } from '../modules/constants.js';
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
    this.testActivatorAudio = null;  // Chrome/WebRTC activator
    this.testPhase = null;  // 'recording' | 'stopping' | 'analysing' | null
    this.testChunks = [];
  }

  /** @returns {object} Controller deps */
  get deps() {
    return this.controller.deps;
  }

  /**
   * Test toggle (test butonuna tiklandiginda)
   * Kayit sirasinda tiklanirsa erken durdur ve analize gec.
   */
  async toggle() {
    // GUARD: Async islem devam ederken tekrar cagrilmasin (rapid click korunmasi)
    if (this.deps.getIsPreparing?.()) return;

    if (this.testPhase === 'recording') {
      // Erken durdur -> analize gec (iptal degil)
      await this.stopRecording();
    } else if (this.testPhase === 'stopping' || this.testPhase === 'analysing') {
      // Durdurma/analiz async surecinde - tiklamayi yut (re-entry onleme; analiz kisa surer,
      // MAX_WAIT_MS butcesi asilsa bile startAnalysing raporu yine acar)
      return;
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

    try {
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
    } catch (err) {
      // Kayit sonlandirma hatasi -> raporsuz temiz cikis (sayfa kilitlenmesin)
      log.error('Test stopRecording error', { error: err.message });
      eventBus.emit(EVENTS.UI_MESSAGE, {
        message: 'Test could not finish cleanly. Try running the test again.',
        tone: 'error'
      });
      await this._finish(EVENTS.TEST_CANCELLED);
      return;
    }

    // Analize gec (kendi hata yonetimi var)
    await this.startAnalysing();
  }

  /**
   * Test analiz fazi (playback yerine): offline deep analiz + gercek progress bar.
   * Kayit bittikten sonra buffer decode edilip yuksek cozunurluklu spektral analiz yapilir;
   * progress bar bu gercek isi yansitir, tamamlaninca rapor acilir.
   */
  async startAnalysing() {
    // Bos kayit -> raporsuz iptal (eski playback blob guard'i ile ayni davranis)
    if (!this.testAudioBlob || this.testAudioBlob.size === 0) {
      log.error('Test analysing skipped: no audio data', { blobExists: !!this.testAudioBlob, blobSize: this.testAudioBlob?.size || 0, chunksCount: this.testChunks?.length || 0 });
      eventBus.emit(EVENTS.UI_MESSAGE, {
        message: 'No audio was captured. Check the selected microphone and try the test again.',
        tone: 'error'
      });
      await this._finish(EVENTS.TEST_CANCELLED);
      return;
    }

    this.testPhase = 'analysing';
    this.deps.setCurrentMode('test-analysing');
    this.deps.uiStateManager?.updateButtonStates();
    eventBus.emit(EVENTS.TEST_ANALYSING_STARTED);
    log.stream('Test analysing starting', { blobSize: this.testAudioBlob.size, blobType: this.testAudioBlob.type });

    // Blob referansini yakala (_cleanup testAudioBlob'u null'lar; deepAnalysisEngine kendi referansini tutar)
    const blob = this.testAudioBlob;

    try {
      const analyzePromise = deepAnalysisEngine.analyze(blob, {
        source: 'test',
        onProgress: (ratio) => eventBus.emit(EVENTS.TEST_ANALYSING_PROGRESS, { ratio })
      });

      // Guvenlik butcesi: analiz asilirsa (worker takilirsa) rapor yine acilir (degrade)
      await Promise.race([
        analyzePromise,
        new Promise(resolve => setTimeout(resolve, DEEP_ANALYSIS.MAX_WAIT_MS))
      ]);
    } catch (err) {
      // Analiz hatasi raporu iptal ETMEZ — audioMetrics zaten kayit sirasinda toplandi
      log.error('Test analysing error', { error: err.message });
    }

    // Bar'i tamamla ve raporu ac
    eventBus.emit(EVENTS.TEST_ANALYSING_PROGRESS, { ratio: 1 });
    await this._finish(EVENTS.TEST_COMPLETED);
  }

  /**
   * Test iptal (kayit sirasinda)
   */
  async cancel() {
    this._clearTimer();

    log.stream('Test cancelling', {});

    try {
      // null-safe: recorder yoksa stop() cagirma (aksi halde throw)
      if (this.testMediaRecorder && this.testMediaRecorder.state !== 'inactive') {
        this.testMediaRecorder.stop();
      }

      // DRY: Mevcut cleanup fonksiyonlari kullan
      eventBus.emit(EVENTS.STREAM_STOPPED);
      await loopbackManager.cleanup();
      stopStreamTracks(this.controller.loopbackLocalStream);
      this.controller.loopbackLocalStream = null;
    } catch (err) {
      log.error('Test cancel error', { error: err.message });
    } finally {
      log.stream('Test cancelled');
      await this._finish(EVENTS.TEST_CANCELLED);
    }
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
    // Fire-and-forget: wrapAsyncHandler kapsaminin DISINDA -> .catch() zorunlu (unhandled rejection + UI kilidi onleme)
    this.testTimerId = setTimeout(() => {
      this.stopRecording().catch(err => log.error('Test auto-stop failed', { error: err.message }));
    }, TEST.DURATION_MS);
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
    // KRITIK: loopbackManager.cleanup() throw etse bile resetState() finally'de DAIMA calismali.
    // Aksi halde document.body.dataset.appState 'testing'de takilir ve helpers.css tum sayfayi kilitler
    // (RecordingController.stop() / MonitoringController.stop() ile ayni try/catch/finally deseni).
    try {
      await loopbackManager.cleanup();
      stopStreamTracks(this.controller.loopbackLocalStream);
    } catch (err) {
      log.error('Test cleanup error', { error: err.message });
    } finally {
      this.controller.loopbackLocalStream = null;
      this.testMediaRecorder = null;
      this.testChunks = [];
      this.testAudioBlob = null;

      // DRY: Activator audio temizle
      cleanupActivatorAudio(this.testActivatorAudio);
      this.testActivatorAudio = null;

      this.testPhase = null;
      resetState(this.deps);
    }
  }

  /**
   * Cleanup + terminal event'i atomik olarak birlikte tetikle (DRY).
   * _cleanup() -> resetState() (appState) ile terminal event -> StatusManager idle gecisinin
   * asenkron ayrismasini yapisal olarak imkansiz kilar.
   * @param {string} eventName - EVENTS.TEST_COMPLETED | TEST_CANCELLED
   * @private
   */
  async _finish(eventName) {
    await this._cleanup();
    eventBus.emit(eventName);
  }
}

export default TestRecordingFlow;
