/**
 * VuMeter - Ses seviyesi gostergesi
 * OCP: Farkli gorsellestirme modlari eklenebilir
 *
 * Pre-init: AudioEngine'den hazir context ve analyser kullanir
 */
import eventBus from './EventBus.js';
import audioEngine from './AudioEngine.js';
import { VU_METER, EVENTS } from './constants.js';
import MeterSource, { readMeterSamples } from './MeterSource.js';
import { log, disconnectNodes, createAudioContext, createAnalyserNode, setVisible } from './utils.js';

class VuMeter {
  constructor(config) {
    // Local (mic) VU meter elementleri
    this.barEl = document.getElementById(config.barId);
    this.peakEl = document.getElementById(config.peakId);
    this.dotEl = document.getElementById(config.dotId);
    this.readingEl = document.getElementById(config.readingId || 'vuMeterReading');
    this.activityBarEl = document.getElementById('micActivityBar');
    this.activityStatusEl = document.getElementById('micActivityStatus');
    this.detailsEl = document.getElementById('audioDetails');
    this.activityState = 'idle';

    // Remote (codec sonrasi) VU meter elementleri (opsiyonel)
    this.remoteBarEl = document.getElementById(config.remoteBarId || 'remoteVuBar');
    this.remotePeakEl = document.getElementById(config.remotePeakId || 'remoteVuPeak');
    this.remoteReadingEl = document.getElementById(config.remoteReadingId || 'remoteVuReading');
    this.remoteContainerEl = document.getElementById('remoteVuContainer');

    this.analyser = null;
    this.remoteAnalyser = null; // Remote stream icin ayri analyser
    this.remoteAudioCtx = null; // Remote stream icin ayri AudioContext
    this.remoteSourceNode = null;
    this.animationId = null;
    this.peakLevel = 0;
    this.remotePeakLevel = 0;
    this.peakHoldTime = 0;
    this.remotePeakHoldTime = 0;
    this.dotState = 'idle'; // classList optimizasyonu icin state tracking

    // VU balistik state (per-meter: local ve remote ayri)
    this._localMeterState = { smoothedRms: 0, lastRenderTime: 0 };
    this._remoteMeterState = { smoothedRms: 0, lastRenderTime: 0 };

    // Performans: VU meter container genisligini cache'le (reflow onleme)
    // clientWidth kullan (border haric) - bar'in width:% hesabiyla ayni referans alani
    this.meterWidth = this.peakEl?.parentElement?.clientWidth || VU_METER.DEFAULT_METER_WIDTH;
    this.remoteMeterWidth = this.remotePeakEl?.parentElement?.clientWidth || VU_METER.DEFAULT_METER_WIDTH;

    // Event listener referansları (memory leak önleme - stop()'da kaldırılır)
    this._onStreamStarted = (stream) => this.start(stream);
    this._onStreamStopped = () => this.stop();
    this._onLoopbackRemote = (stream) => this.startRemote(stream);
    this._onAnalyserReady = (analyserNode) => this.startWithAnalyser(analyserNode);
    this._onGuideChanged = ({ stage }) => {
      if (stage !== 'input-detected') this.guideStage = stage;
      this._renderActivity(this.activityLevel ?? null, this.activitySignalState);
    };

    // Event dinle
    eventBus.on(EVENTS.STREAM_STARTED, this._onStreamStarted);
    eventBus.on(EVENTS.STREAM_STOPPED, this._onStreamStopped);
    eventBus.on(EVENTS.LOOPBACK_REMOTE_STREAM, this._onLoopbackRemote);
    eventBus.on(EVENTS.PIPELINE_ANALYSER_READY, this._onAnalyserReady);
    eventBus.on(EVENTS.CAPTURE_GUIDE_CHANGED, this._onGuideChanged);

    // Resize event'inde meter width'i guncelle
    // Memory leak fix: Named handler, stop()'ta removeEventListener icin
    this.resizeHandler = () => {
      this.meterWidth = this.peakEl?.parentElement?.clientWidth || VU_METER.DEFAULT_METER_WIDTH;
      this.remoteMeterWidth = this.remotePeakEl?.parentElement?.clientWidth || VU_METER.DEFAULT_METER_WIDTH;
    };
    window.addEventListener('resize', this.resizeHandler);
    // A disclosure can change meter widths without a window resize.
    this.detailsEl?.addEventListener('toggle', this.resizeHandler);
  }

  /**
   * Resize handler'i yeniden ekle (DRY helper)
   * stop()'da kaldirilmis olabilir, tekrar baslatmada yeniden ekle
   */
  _ensureResizeHandler() {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      window.addEventListener('resize', this.resizeHandler);
    }
    // Container gorunur olduktan sonra cizgi konumu icin genisligi yenile.
    this.meterWidth = this.peakEl?.parentElement?.clientWidth || VU_METER.DEFAULT_METER_WIDTH;
  }

  /**
   * Pipeline'dan gelen analyserNode ile VU Meter baslat
   * Bu metod encode oncesi islenmiş sinyali gosterir (fan-out pattern)
   * @param {AnalyserNode} analyserNode - Pipeline'dan gelen analyser
   */
  startWithAnalyser(analyserNode) {
    if (!analyserNode) return;
    this._startController?.abort();
    this._localSource?.close();

    // Onceki animasyonu durdur (tekrar baslatma durumunda)
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    // AudioEngine baglantisini temizle (orphaned node onleme)
    // Defansif: stream:started event'i AudioEngine.connectStream() cagirmis olabilir
    // Guard ile onlense de, eski event siralamasindan kalan baglanti olabilir
    audioEngine.disconnect();

    // Resize handler'i yeniden ekle (DRY)
    this._ensureResizeHandler();

    // Pipeline'dan gelen analyser'i kullan
    this.analyser = analyserNode;
    this._localSource = new MeterSource(analyserNode);
    this._localMeterState = { smoothedRms: 0, lastRenderTime: 0 };
    this.peakLevel = this.peakHoldTime = 0;

    // DataArray olustur (pipeline'in audioContext'inden)
    const bufferLength = this.analyser.fftSize;
    this._pipelineDataArray = new Float32Array(bufferLength);

    this.update();

    log.audio('VU Meter: Pipeline analyser connected', { fftSize: analyserNode.fftSize, source: 'pipeline' });

    eventBus.emit(EVENTS.VUMETER_STARTED);
  }

  async start(stream) {
    if (!stream) return;

    // Guard: Pipeline analyser zaten set edilmisse AudioEngine'e baglanma
    // pipeline:analyserReady event'i stream:started'dan ONCE gelirse bu guard calisir
    if (this.analyser || this._startController) return;
    const controller = this._startController = new AbortController();
    try {
      this._ensureResizeHandler();
      // Only Call uses AudioEngine here; Record supplies its pipeline analyser.
      if (!audioEngine.isWarmedUp) await audioEngine.warmup();
      controller.signal.throwIfAborted();
      const analyser = await audioEngine.connectStream(stream, { signal: controller.signal });
      controller.signal.throwIfAborted();
      this.analyser = analyser;
      this._localSource = new MeterSource(analyser);
      this._pipelineDataArray = null;
      this.update();

      const ac = audioEngine.getContext();
      eventBus.emit(EVENTS.VUMETER_AUDIOCONTEXT, {
        sampleRate: ac.sampleRate,
        baseLatency: ac.baseLatency,
        outputLatency: ac.outputLatency,
        state: ac.state,
        fftSize: this.analyser.fftSize
      });
      eventBus.emit(EVENTS.VUMETER_STARTED);
    } catch (error) {
      if (!controller.signal.aborted) log.error('VU Meter: Local stream connection error', { error: error.message });
    } finally {
      if (this._startController === controller) this._startController = null;
    }
  }

  /**
   * Remote stream (codec sonrasi) icin VU meter baslat
   * Loopback modunda WebRTC'den gelen sesi gosterir
   */
  async startRemote(stream) {
    if (!stream) return;
    this.stopRemote();
    const controller = this._remoteStartController = new AbortController();

    // Remote container'i goster
    setVisible(this.remoteContainerEl, true);

    // DOM render sonrasi width hesapla (container artik gorunur)
    requestAnimationFrame(() => {
      if (controller.signal.aborted) return;
      this.remoteMeterWidth = this.remotePeakEl?.parentElement?.clientWidth || VU_METER.DEFAULT_METER_WIDTH;
    });

    try {
      // Remote stream icin ayri AudioContext (cakisma onleme) - DRY: utility kullan
      const context = await createAudioContext({ latencyHint: 'interactive' }, { signal: controller.signal });
      if (controller.signal.aborted) { await context.close().catch(() => {}); return; }
      this.remoteAudioCtx = context;
      this.remoteSourceNode = this.remoteAudioCtx.createMediaStreamSource(stream);
      this.remoteAnalyser = createAnalyserNode(this.remoteAudioCtx);
      this.remoteSourceNode.connect(this.remoteAnalyser);
      this._remoteSource = new MeterSource(this.remoteAnalyser);

      log.stream('VU Meter: Remote stream connected', { streamId: stream.id });
    } catch (err) {
      if (!controller.signal.aborted) {
        this.stopRemote();
        log.error('VU Meter: Remote stream connection error', { error: err.message });
      }
    }
  }

  stopRemote() {
    this._remoteStartController?.abort();
    this._remoteStartController = null;
    this._remoteSource?.close();
    this._remoteSource = null;
    this.remoteDataArray = null;
    disconnectNodes([this.remoteAnalyser, this.remoteSourceNode]);
    this.remoteAnalyser = null;
    this.remoteSourceNode = null;
    if (this.remoteAudioCtx) {
      this.remoteAudioCtx.close().catch(() => {});
      this.remoteAudioCtx = null;
    }

    // Remote VU elementlerini sifirla (container visibility'i UI tarafindan kontrol edilir)
    this._resetMeter(this.remoteBarEl, this.remotePeakEl, this.remoteReadingEl);
    // NOT: Container display'i burada degistirilmez - profil kategorisine gore UI tarafindan yonetilir

    this.remotePeakLevel = 0;
    this._remoteMeterState = { smoothedRms: 0, lastRenderTime: 0 };
  }

  _resetMeter(barEl, peakEl, readingEl) {
    if (barEl) {
      if (barEl.dataset) delete barEl.dataset.state;
      barEl.style.setProperty('--signal-color', 'var(--text-muted)');
      barEl.style.width = '0';
      barEl.parentElement?.setAttribute('aria-valuenow', String(VU_METER.MIN_DB));
      barEl.parentElement?.setAttribute('aria-valuetext', 'Not measuring');
    }
    if (peakEl) {
      peakEl.style.transform = 'translateX(0)';
      setVisible(peakEl, false);
    }
    if (readingEl) readingEl.textContent = '—';
  }

  _renderActivity(level, signalState = 'waiting', color = this.activityColor) {
    if (this.activityBarEl) this.activityBarEl.style.width = `${level ?? 0}%`;
    this.activityLevel = level;
    this.activitySignalState = signalState;
    const state = level === null ? 'idle' : signalState;
    color = level === null ? 'var(--text-muted)' : color;
    if (color !== this.activityColor) {
      this.activityColor = color;
      for (const element of [this.activityBarEl, this.activityStatusEl, this.dotEl]) {
        element?.style.setProperty('--signal-color', color);
      }
    }
    const text = state === 'idle' ? 'Not measuring yet'
      : state === 'clipping' ? 'Input too high — lower the gain'
      : state === 'high' ? 'Input level is high'
      : this.guideStage === 'quiet' ? 'Checking background sound — stay quiet'
      : state === 'detected' ? 'Sound detected'
      : this.guideStage === 'prepare' ? 'Ready — recording starts shortly' : 'No sound detected — speak normally';
    if (this.activityBarEl?.dataset && this.activityBarEl.dataset.state !== state) this.activityBarEl.dataset.state = state;
    if (this.activityState === state && this.activityStatusEl?.textContent === text) return;
    this.activityState = state;
    if (this.activityStatusEl) {
      this.activityStatusEl.dataset.state = state;
      this.activityStatusEl.textContent = text;
    }
  }

  _signalColor(db) {
    // Continuous hue interpolation between palette anchors, never status bins.
    const [from, to, low, high] = db < VU_METER.SIGNAL_PRESENT_DB
      ? ['--text-muted', '--vu-local', VU_METER.MIN_DB, VU_METER.SIGNAL_PRESENT_DB]
      : db < VU_METER.HIGH_LEVEL_DB
        ? ['--vu-local', '--vu-warning', VU_METER.SIGNAL_PRESENT_DB, VU_METER.HIGH_LEVEL_DB]
        : ['--vu-warning', '--vu-danger', VU_METER.HIGH_LEVEL_DB, VU_METER.CLIPPING_THRESHOLD_DB];
    const blend = Math.max(0, Math.min(100, (db - low) / (high - low) * 100));
    return `color-mix(in oklch, var(${from}), var(${to}) ${blend.toFixed(2)}%)`;
  }

  /**
   * DRY: Ortak meter hesaplama ve render (local + remote icin)
   * VU integration: 300ms EMA ile yumusatilmis RMS
   * Peak decay: frame-rate bagimsiz (dB/s)
   * Main activity is the fast peak envelope; level/dB remain the RMS detail.
   * @returns {{ level: number, activityLevel: number, dB: number, rawDb: number, peakLevel: number, peakHoldTime: number, isClipping: boolean, signalState: string, color: string }}
   */
  _renderMeter(analyser, dataArray, barEl, peakEl, peakLevel, peakHoldTime, meterWidth, meterState, readingEl, sample) {
    sample ??= readMeterSamples(analyser, dataArray);
    const instantRms = sample.rms;

    // Frame-rate bagimsiz zamanlama
    const now = performance.now();
    const dtMs = meterState.lastRenderTime > 0 ? (now - meterState.lastRenderTime) : 16.7;
    meterState.lastRenderTime = now;

    // Raw dB (smoothing oncesi — olcum icin)
    const rawDb = instantRms > VU_METER.RMS_THRESHOLD ? 20 * Math.log10(instantRms) : VU_METER.MIN_DB;
    const samplePeak = sample.peak;
    const peakDb = samplePeak > 0 ? 20 * Math.log10(samplePeak) : VU_METER.MIN_DB;
    const clipAge = sample.clipAgeMs ?? (peakDb >= VU_METER.CLIPPING_THRESHOLD_DB ? 0 : Infinity);
    const highAge = sample.highAgeMs ?? (peakDb >= VU_METER.HIGH_LEVEL_DB ? 0 : Infinity);
    const isClipping = clipAge < VU_METER.SAMPLE_FRESH_MS;
    if (clipAge < VU_METER.PEAK_HOLD_TIME_MS) meterState.clipUntil = now + VU_METER.PEAK_HOLD_TIME_MS - clipAge;
    if (highAge < VU_METER.PEAK_HOLD_TIME_MS) meterState.highUntil = now + VU_METER.PEAK_HOLD_TIME_MS - highAge;
    // Peak warnings hold on the existing animation clock, independent of the
    // smoothed RMS fill, so a short overload is visible without another timer.
    const signalState = now < meterState.clipUntil ? 'clipping' : now < meterState.highUntil ? 'high'
      : rawDb > VU_METER.SIGNAL_PRESENT_DB ? 'detected' : 'waiting';
    if (barEl?.dataset && barEl.dataset.state !== signalState) barEl.dataset.state = signalState;
    // Main fill and hue share one fast envelope. Warning text holds separately:
    // a previous overload must never pin the live activity bar at full scale.
    const colorTarget = Math.max(VU_METER.MIN_DB, Math.min(0, peakDb));
    const previousColorDb = meterState.colorDb ?? VU_METER.MIN_DB;
    const colorTime = colorTarget > previousColorDb ? VU_METER.ACTIVITY_ATTACK_MS : VU_METER.ACTIVITY_RELEASE_MS;
    meterState.colorDb = previousColorDb + (colorTarget - previousColorDb) * (1 - Math.exp(-dtMs / colorTime));
    const color = this._signalColor(meterState.colorDb);
    if (barEl && meterState.color !== color) barEl.style.setProperty('--signal-color', color);
    meterState.color = color;
    const activityLevel = (meterState.colorDb - VU_METER.MIN_DB) / -VU_METER.MIN_DB * 100;

    // VU integration: 300ms EMA
    const alpha = 1 - Math.exp(-dtMs / VU_METER.VU_INTEGRATION_MS);
    meterState.smoothedRms += alpha * (instantRms - meterState.smoothedRms);

    const dB = meterState.smoothedRms > VU_METER.RMS_THRESHOLD
      ? 20 * Math.log10(meterState.smoothedRms) : VU_METER.MIN_DB;
    const level = Math.max(0, Math.min(100, (dB - VU_METER.MIN_DB) / -VU_METER.MIN_DB * 100));

    if (barEl) {
      barEl.style.width = `${level}%`;
    }

    // Readout and accessible value share the displayed RMS, at most four updates/s.
    // Below the existing RMS gate, report its bound rather than a false exact -96 dBFS.
    if (meterState.readingTime === undefined || now - meterState.readingTime >= 250) {
      meterState.readingTime = now;
      const belowSensitivity = meterState.smoothedRms <= VU_METER.RMS_THRESHOLD;
      const displayDb = Math.max(VU_METER.MIN_DB, Math.min(0, dB));
      const reading = belowSensitivity
        ? `≤ ${Math.round(20 * Math.log10(VU_METER.RMS_THRESHOLD))}`.replace('-', '−')
        : displayDb.toFixed(1).replace('-', '−');
      if (reading !== meterState.reading) {
        meterState.reading = reading;
        if (readingEl) readingEl.textContent = reading;
        barEl?.parentElement?.setAttribute('aria-valuenow', displayDb.toFixed(1));
        barEl?.parentElement?.setAttribute('aria-valuetext', `${reading} dBFS`);
      }
    }

    // Peak hold + frame-rate bagimsiz decay
    if (level > peakLevel) {
      peakLevel = level;
      peakHoldTime = now;
    } else if (now - peakHoldTime > VU_METER.PEAK_HOLD_TIME_MS) {
      const decayDb = VU_METER.PEAK_DECAY_DB_PER_SEC * (dtMs / 1000);
      const decayLevel = (decayDb / (-VU_METER.MIN_DB)) * 100;
      peakLevel = Math.max(level, peakLevel - decayLevel);
    }

    if (peakEl) {
      // This line holds the recent smoothed level; it is not a sample/true-peak reading.
      setVisible(peakEl, peakLevel > 0);
      const translate = Math.min((peakLevel / 100) * meterWidth, meterWidth - VU_METER.PEAK_WIDTH);
      peakEl.style.transform = `translateX(${translate}px)`;
    }

    return { level, activityLevel, dB, rawDb, peakLevel, peakHoldTime, isClipping, signalState, color };
  }

  update() {
    if (!this.analyser) return;

    const dataArray = this._pipelineDataArray || audioEngine.getDataArray();
    const result = this._renderMeter(
      this.analyser, dataArray, this.barEl, this.peakEl,
      this.peakLevel, this.peakHoldTime, this.meterWidth, this._localMeterState, this.readingEl, this._localSource?.read()
    );
    this.peakLevel = result.peakLevel;
    this.peakHoldTime = result.peakHoldTime;
    this._renderActivity(result.activityLevel, result.signalState, result.color);
    const { isClipping } = result;

    // Sinyal noktasi - sadece state degisince guncelle
    const newDotState = result.signalState;
    if (this.dotEl && this.dotState !== newDotState) {
      this.dotEl.className = 'signal-dot ' + newDotState;
      this.dotState = newDotState;
    }

    eventBus.emit(EVENTS.VUMETER_LEVEL, {
      level: result.level, peak: this.peakLevel, dB: result.dB.toFixed(1), rawDb: result.rawDb.toFixed(1), isClipping
    });

    this.updateRemote();
    this.animationId = requestAnimationFrame(() => this.update());
  }

  updateRemote() {
    if (!this.remoteAnalyser) return;
    if (!this.remoteDataArray) {
      this.remoteDataArray = new Float32Array(this.remoteAnalyser.fftSize);
    }

    const result = this._renderMeter(
      this.remoteAnalyser, this.remoteDataArray, this.remoteBarEl, this.remotePeakEl,
      this.remotePeakLevel, this.remotePeakHoldTime, this.remoteMeterWidth, this._remoteMeterState, this.remoteReadingEl, this._remoteSource?.read()
    );
    this.remotePeakLevel = result.peakLevel;
    this.remotePeakHoldTime = result.peakHoldTime;

    const { isClipping } = result;

    eventBus.emit(EVENTS.VUMETER_REMOTE_LEVEL, {
      level: result.level,
      peak: this.remotePeakLevel,
      dB: result.dB.toFixed(1),
      rawDb: result.rawDb.toFixed(1),
      isClipping
    });
  }

  stop() {
    this._startController?.abort();
    this._startController = null;
    this._localSource?.close();
    this._localSource = null;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    // Memory leak fix: Resize listener temizle
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
    }

    // Bar'lari sifirla
    this._resetMeter(this.barEl, this.peakEl, this.readingEl);
    this._renderActivity(null);
    if (this.dotEl) {
      this.dotEl.className = 'signal-dot';
      this.dotState = 'idle';
    }

    this.peakLevel = 0;
    this._localMeterState = { smoothedRms: 0, lastRenderTime: 0 };

    // AudioEngine'den disconnect (context acik kalir - tekrar hizli baslatma icin)
    audioEngine.disconnect();
    this.analyser = null;

    // Remote stream'i de temizle
    this.stopRemote();

    eventBus.emit(EVENTS.VUMETER_STOPPED);
  }

  /**
   * VuMeter'i tamamen yok et (sayfa kapanista cagrilir)
   * EventBus listener'larini kaldirir (memory leak onleme)
   */
  destroy() {
    this.stop();
    this.detailsEl?.removeEventListener('toggle', this.resizeHandler);
    eventBus.off(EVENTS.STREAM_STARTED, this._onStreamStarted);
    eventBus.off(EVENTS.STREAM_STOPPED, this._onStreamStopped);
    eventBus.off(EVENTS.LOOPBACK_REMOTE_STREAM, this._onLoopbackRemote);
    eventBus.off(EVENTS.PIPELINE_ANALYSER_READY, this._onAnalyserReady);
    eventBus.off(EVENTS.CAPTURE_GUIDE_CHANGED, this._onGuideChanged);
  }
}

export default VuMeter;
