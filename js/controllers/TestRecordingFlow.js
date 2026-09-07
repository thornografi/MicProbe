/**
 * TestRecordingFlow - Loopback test kayit ve analiz akisi
 * Test kaydi, iptal ve kaynak yasam dongusunun tek sahibi.
 * Bagimliliklar uygulama tarafindan dogrudan verilir.
 *
 * Akis: kayit (7sn konusma) -> stopRecording -> startAnalysing (offline deep analiz +
 * gercek progress bar) -> playback yukle (Player.load) -> TEST_COMPLETED -> rapor.
 * Kayit, analiz bittikten sonra sonuc olarak dinlenebilir (playback karti acilir).
 */
import eventBus from '../modules/EventBus.js';
import loopbackManager from '../modules/LoopbackManager.js';
import deepAnalysisEngine from '../modules/DeepAnalysisEngine.js';
import { TEST, EVENTS, PIPELINE_TYPES, ENCODER_TYPES } from '../modules/constants.js';
import { completeRunSnapshot } from '../modules/RunSnapshot.js';
import { stopStreamTracks, createMediaRecorder, createAndPlayActivatorAudio, cleanupActivatorAudio, log, beginPreparing, endPreparing, resetState, getStreamErrorMessage, formatTimestampYYMMDDHHMMSS, getExtensionForMimeType } from '../modules/utils.js';
import { requestStream } from '../modules/StreamHelper.js';
import CaptureGuide from '../modules/CaptureGuide.js';

class TestRecordingFlow {
  /**
   * @param {object} deps - Kayit ayarlari, player ve uygulama state erisimi
   */
  constructor(deps) {
    this.deps = deps;
    this.localStream = null;

    // Test state
    this.testTimerId = null;
    this.testCountdownInterval = null;
    this.testPhase = null;  // 'recording' | 'stopping' | 'analysing' | null
    this._run = null;
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
      // Finishing a capture and analysing its file share one stop operation.
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
    const snapshot = this.deps.createRunSnapshot();
    const run = { snapshot, cancelled: false, finished: false, stream: null, recorder: null, activator: null, chunks: [], analysis: null };
    run.guide = new CaptureGuide(snapshot);
    this._run = run;
    this.runSnapshot = snapshot;
    this.analysis = null;
    this._stopPromise = null;

    log.stream('Test recording starting', { constraints, opusBitrate, duration: TEST.DURATION_MS });
    eventBus.emit(EVENTS.UI_CLEAR_MESSAGE);

    try {
      // Player'i durdur
      this.deps.player?.pause();

      // Preparing state - mode'u hemen set et (UI hangi butonun preparing oldugunu bilsin)
      beginPreparing(this.deps, 'test-recording');

      // Mikrofon al
      run.stream = await requestStream(constraints);
      if (!this._isCurrent(run)) { this._disposeRunResources(run); return; }
      this.localStream = run.stream;
      this._assertInputAlive(run);
      run.onTrackEnded = () => {
        if (!this._isCurrent(run)) return;
        if (this.testPhase !== 'recording') {
          this._failCapture(run, new Error('Microphone disconnected before the test could start'));
          return;
        }
        eventBus.emit(EVENTS.UI_MESSAGE, { message: 'Microphone disconnected. Finishing the captured test sample.', tone: 'warning' });
        this.stopRecording().catch(err => log.error('Test device-ended stop failed', { error: err.message }));
      };
      run.stream.getAudioTracks().forEach(track => track.addEventListener('ended', run.onTrackEnded));

      // DRY: LoopbackManager.setup() dogrudan kullan
      // Test alici stream'i kaydeder; canli hoparlor cikisi yoktur.
      const remoteStream = await loopbackManager.setup(run.stream, {
        useWebAudio: snapshot.requestedSettings.pipeline !== PIPELINE_TYPES.DIRECT,
        opusBitrate,
        pipeline: snapshot.requestedSettings.pipeline,
        runId: snapshot.runId
      });
      if (!this._isCurrent(run)) { this._disposeRunResources(run); return; }
      this._assertInputAlive(run);
      this.runSnapshot = run.snapshot = completeRunSnapshot(snapshot, run.stream, {
        pipeline: loopbackManager.actualPipeline, encoder: null,
        audioContext: loopbackManager.audioCtx ? {
          supported: true, sampleRate: loopbackManager.audioCtx.sampleRate,
          baseLatencyMs: loopbackManager.audioCtx.baseLatency * 1000,
          outputLatencyMs: loopbackManager.audioCtx.outputLatency == null ? null : loopbackManager.audioCtx.outputLatency * 1000
        } : null
      });

      // DRY: Chrome/WebRTC activator audio helper kullan
      run.activator = await createAndPlayActivatorAudio(remoteStream, 'Test');
      if (!this._isCurrent(run)) { this._disposeRunResources(run); return; }
      this._assertInputAlive(run);

      // DRY: createMediaRecorder helper kullan
      const preparation = run.guide.prepare(run.stream);
      eventBus.emit(EVENTS.STREAM_STARTED, this.localStream);
      eventBus.emit(EVENTS.LOOPBACK_REMOTE_STREAM, remoteStream);
      if (!await preparation || !this._isCurrent(run)) return;
      this._assertInputAlive(run);
      run.recorder = createMediaRecorder(remoteStream);
      run.recorder.ondataavailable = (e) => {
        if (e.data.size) run.chunks.push(e.data);
      };
      run.recorder.onerror = event => this._failCapture(run, event.error || new Error('Audio encoder stopped unexpectedly'));
      run.recorder.start();
      run.startedAt = performance.now();

      // State guncelle - mode zaten set edildi, sadece preparing'i kapat
      this.testPhase = 'recording';
      endPreparing(this.deps);

      // Timer baslat
      run.guide.start(run.startedAt, () => this.stopRecording().catch(err => log.error('Guided test stop failed', { error: err.message })));
      if (!run.guide.guided) this._startTimer(run);
      eventBus.emit(EVENTS.TEST_RECORDING_STARTED, { durationMs: run.guide.durationMs, runSnapshot: this.runSnapshot });
      log.stream(`Test recording started (${run.guide.durationMs / 1000}s)`);

    } catch (err) {
      if (!this._isCurrent(run)) { this._disposeRunResources(run); return; }
      const userMessage = getStreamErrorMessage(err);
      log.error('Test recording failed to start', { error: err.message });
      eventBus.emit(EVENTS.UI_MESSAGE, {
        message: `${userMessage}. Check microphone access, then try Test again.`,
        tone: 'error'
      });
      // Preparing flag'i temizle (UI "Preparing" durumunda takilmasin)
      this.deps.setIsPreparing(false);
      await this._finish(EVENTS.TEST_CANCELLED, run);
    }
  }

  /**
   * Test kaydini durdur ve playback'e gec
   */
  stopRecording() {
    if (this._stopPromise) return this._stopPromise;
    if (this.testPhase !== 'recording') return Promise.resolve();
    this._stopPromise = this._stopRecording(this._run);
    return this._stopPromise;
  }

  async _stopRecording(run) {
    if (!this._isCurrent(run)) return;
    // GUARD: stopRecording async surecindeyken (timer fire + erken tiklama yarisi)
    // ikinci kez girilmesin - aksi halde onstop overwrite olur ve ilk promise asla resolve olmaz
    if (this.testPhase === 'stopping') return;
    this.testPhase = 'stopping';

    this._clearTimer();
    run.durationMs = performance.now() - run.startedAt;
    run.guidedSegments = run.guide.finish(run.durationMs);

    log.stream('Test recording stopping', {});

    try {
      // onstop handler'i ONCE set et, SONRA stop() cagir (race condition fix)
      // 'inactive' recorder onstop tetiklemez (USB cihaz cekilmesi/ICE kopmasi) -> deadlock onlemek icin direkt resolve
      const recorder = run.recorder;
      const stopPromise = new Promise((resolve, reject) => {
        run.resolveStop = () => { clearTimeout(run.stopTimeout); run.stopTimeout = null; resolve(); };
        if (!recorder || recorder.state === 'inactive') {
          this._completeRecording(run);
          log.recorder(`MediaRecorder already inactive: ${run.chunks.length} chunk`);
          run.resolveStop();
          return;
        }
        run.stopTimeout = setTimeout(() => reject(new Error('Test recorder completion timed out')), TEST.STOP_WAIT_MS);
        recorder.onstop = () => {
          this._completeRecording(run);
          log.recorder(`MediaRecorder onstop: ${run.chunks.length} chunk, ${run.blob?.size || 0} bytes`);
          run.resolveStop?.();
        };
        recorder.stop();
      });

      this._detachTrackEnded(run);
      stopStreamTracks(run.stream);
      eventBus.emit(EVENTS.STREAM_STOPPED);
      eventBus.emit(EVENTS.TEST_RECORDING_STOPPED, { runSnapshot: run.snapshot, durationMs: run.durationMs });

      // onstop'u bekle
      await stopPromise;
      run.resolveStop = null;
      if (!this._isCurrent(run)) return;

      // DRY: LoopbackManager.cleanup() dogrudan kullan
      await loopbackManager.cleanup();
      if (!this._isCurrent(run)) return;
      stopStreamTracks(run.stream);
      this.localStream = null;

      log.stream('Test recording complete, playback starting...');
    } catch (err) {
      if (!this._isCurrent(run)) return;
      // Kayit sonlandirma hatasi -> raporsuz temiz cikis (sayfa kilitlenmesin)
      log.error('Test stopRecording error', { error: err.message });
      eventBus.emit(EVENTS.UI_MESSAGE, {
        message: 'Test could not finish cleanly. Try running the test again.',
        tone: 'error'
      });
      await this._finish(EVENTS.TEST_CANCELLED, run);
      return;
    } finally {
      clearTimeout(run.stopTimeout);
      run.stopTimeout = null;
    }

    // Analize gec (kendi hata yonetimi var)
    await this.startAnalysing(run);
  }

  /**
   * Test analiz fazi: offline deep analiz + gercek progress bar.
   * Kayit bittikten sonra buffer decode edilip yuksek cozunurluklu spektral analiz yapilir;
   * progress bar bu gercek isi yansitir. Analiz tamamlaninca kayit Player'a yuklenir
   * (sonuc olarak dinlenebilir) ve rapor acilir.
   */
  async startAnalysing(run = this._run) {
    if (!this._isCurrent(run)) return;
    // Bos kayit -> raporsuz iptal (eski playback blob guard'i ile ayni davranis)
    if (!run.blob || run.blob.size === 0) {
      log.error('Test analysing skipped: no audio data', { blobExists: !!run.blob, blobSize: run.blob?.size || 0, chunksCount: run.chunks.length });
      eventBus.emit(EVENTS.UI_MESSAGE, {
        message: 'No audio was captured. Check the selected microphone and try the test again.',
        tone: 'error'
      });
      await this._finish(EVENTS.TEST_CANCELLED, run);
      return;
    }

    this.testPhase = 'analysing';
    this.deps.setCurrentMode('test-analysing');
    this.deps.uiStateManager?.updateButtonStates();
    eventBus.emit(EVENTS.TEST_ANALYSING_STARTED);
    log.stream('Test analysing starting', { blobSize: run.blob.size, blobType: run.blob.type });

    // Analiz ve playback ayni calismanin kayit dosyasini kullanir.
    const blob = run.blob;
    const runId = run.snapshot.runId;

    try {
      run.analysis = await deepAnalysisEngine.analyze(blob, {
        source: 'test',
        runId,
        guidedSegments: run.guidedSegments,
        onProgress: (ratio) => {
          if (this._isCurrent(run)) eventBus.emit(EVENTS.TEST_ANALYSING_PROGRESS, { ratio });
        }
      });
    } catch (err) {
      // A failed file analysis still produces an explicit unavailable-data report.
      log.error('Test analysing error', { error: err.message });
      run.analysis = { status: 'failed', runId, reason: err.message };
    }
    if (!this._isCurrent(run)) return;
    this.analysis = run.analysis;

    // Bar'i tamamla ve raporu ac
    eventBus.emit(EVENTS.TEST_ANALYSING_PROGRESS, { ratio: 1 });

    // Kaydi sonuc olarak Player'a yukle, sonra calismayi tamamla.
    // Call sonucu TEST_COMPLETED ile ayni run'a ait analiz ve dosyayi birlestirir.
    // RECORDING_COMPLETED ayri record analizi baslatacagi icin burada yayinlanmaz.
    // Playback keeps the measured capture duration, including early stops.
    const mimeType = run.recording?.mimeType || null;
    this.deps.player?.load({
      blob,
      mimeType,
      filename: `test_${formatTimestampYYMMDDHHMMSS()}.${getExtensionForMimeType(mimeType, 'bin')}`,
      durationMs: run.durationMs,
      runSnapshot: run.snapshot
    });

    await this._finish(EVENTS.TEST_COMPLETED, run);
  }

  /**
   * Test iptal (kayit sirasinda)
   */
  async cancel() {
    const run = this._run;
    if (!run || run.finished || run.cancelled) return;
    run.cancelled = true;
    deepAnalysisEngine.cancel(run.snapshot.runId);
    this._clearTimer();

    log.stream('Test cancelling', {});

    try {
      // null-safe: recorder yoksa stop() cagirma (aksi halde throw)
      if (run.recorder && run.recorder.state !== 'inactive') {
        run.recorder.stop();
      }

      // DRY: Mevcut cleanup fonksiyonlari kullan
      eventBus.emit(EVENTS.STREAM_STOPPED);
    } catch (err) {
      log.error('Test cancel error', { error: err.message });
    } finally {
      log.stream('Test cancelled');
      await this._finish(EVENTS.TEST_CANCELLED, run);
    }
  }

  /**
   * Test timer baslat
   * @private
   */
  _startTimer(run = this._run) {
    let remaining = TEST.DURATION_MS;

    // Ilk countdown
    eventBus.emit(EVENTS.TEST_COUNTDOWN, { remainingSec: Math.ceil(remaining / 1000) });

    // Countdown interval (her saniye)
    this.testCountdownInterval = setInterval(() => {
      if (!this._isCurrent(run)) return;
      remaining -= 1000;
      const remainingSec = Math.ceil(remaining / 1000);
      eventBus.emit(EVENTS.TEST_COUNTDOWN, { remainingSec: remainingSec > 0 ? remainingSec : 0 });
    }, 1000);

    // Ana timer (7 sn sonra dur)
    // Fire-and-forget: wrapAsyncHandler kapsaminin DISINDA -> .catch() zorunlu (unhandled rejection + UI kilidi onleme)
    this.testTimerId = setTimeout(() => {
      if (!this._isCurrent(run)) return;
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
  async _cleanup(run = this._run) {
    if (!run) return;
    const ownsRun = this._run === run;
    if (ownsRun) this._clearTimer();
    this._detachTrackEnded(run);
    this._disposeRunResources(run);

    // Idempotent loopback + mikrofon temizligi - hata/erken cikis yollarinda sizinti onleme.
    // Normal stopRecording yolunda zaten temizlenmis olur; tum cagrilar null-safe oldugundan tekrar zararsiz.
    // KRITIK: loopbackManager.cleanup() throw etse bile resetState() finally'de DAIMA calismali.
    // Aksi halde document.body.dataset.appState 'testing'de takilir ve helpers.css tum sayfayi kilitler
    // (RecordingController.stop() ile ayni try/catch/finally deseni).
    try {
      if (ownsRun) await loopbackManager.cleanup();
    } catch (err) {
      log.error('Test cleanup error', { error: err.message });
    } finally {
      run.finished = true;
      if (this._run !== run) return;
      this.localStream = null;
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
  async _finish(eventName, run = this._run) {
    if (!run) return;
    const payload = { runSnapshot: run.snapshot, analysis: run.analysis, recording: run.recording || null };
    await this._cleanup(run);
    if (this._run === run) eventBus.emit(eventName, payload);
  }

  _isCurrent(run) {
    return !!run && this._run === run && !run.cancelled && !run.finished;
  }

  // The saved receiver stream is encoded again. These API values describe that
  // file encoder, not the negotiated RTP codec or measured network throughput.
  _completeRecording(run) {
    const recorderMime = run.recorder?.mimeType || null;
    const mimeType = recorderMime || run.chunks.find(chunk => chunk.type)?.type || null;
    const reportedBitrate = run.recorder?.audioBitsPerSecond;
    run.blob = run.chunks.length ? new Blob(run.chunks, { type: mimeType || '' }) : null;
    run.recording = Object.freeze({
      durationMs: run.durationMs,
      blobSize: run.blob?.size ?? null,
      mimeType,
      mimeTypeSource: recorderMime ? 'mediarecorder' : mimeType ? 'dataavailable' : null,
      pipeline: run.snapshot.pipeline ?? null,
      encoder: ENCODER_TYPES.MEDIARECORDER,
      encoderReportedBitrate: Number.isFinite(reportedBitrate) && reportedBitrate > 0 ? reportedBitrate : null,
      durationSource: 'capture-clock',
      guidedSegments: run.guidedSegments || null
    });
  }

  _assertInputAlive(run) {
    const tracks = run.stream.getAudioTracks();
    if (!tracks.length || tracks.some(track => track.readyState === 'ended')) {
      throw new Error('Microphone disconnected before the test could start');
    }
  }

  _failCapture(run, error) {
    if (!this._isCurrent(run)) return;
    log.error('Test capture failed', { error: error.message, runId: run.snapshot.runId });
    eventBus.emit(EVENTS.UI_MESSAGE, {
      message: `Test recording failed: ${error.message}. Check microphone access, then try Test again.`, tone: 'error'
    });
    void this.cancel().catch(err => log.error('Test error cleanup failed', { error: err.message }));
  }

  _detachTrackEnded(run = this._run) {
    if (!run?.onTrackEnded) return;
    run.stream?.getAudioTracks().forEach(track => track.removeEventListener('ended', run.onTrackEnded));
    run.onTrackEnded = null;
  }

  _disposeRunResources(run) {
    run.guide?.cancel();
    clearTimeout(run.stopTimeout);
    run.stopTimeout = null;
    this._detachTrackEnded(run);
    stopStreamTracks(run.stream);
    cleanupActivatorAudio(run.activator);
    run.activator = null;
    if (run.recorder) {
      run.recorder.ondataavailable = null;
      run.recorder.onstop = null;
      run.recorder.onerror = null;
      if (run.recorder.state !== 'inactive') {
        try { run.recorder.stop(); } catch (error) { log.error('Test recorder cleanup failed', { error: error.message }); }
      }
    }
    run.resolveStop?.();
    run.resolveStop = null;
  }
}

export default TestRecordingFlow;
