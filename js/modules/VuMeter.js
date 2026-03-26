/**
 * VuMeter - Ses seviyesi gostergesi
 * OCP: Farkli gorsellestirme modlari eklenebilir
 *
 * Pre-init: AudioEngine'den hazir context ve analyser kullanir
 */
import eventBus from './EventBus.js';
import audioEngine from './AudioEngine.js';
import { AUDIO, VU_METER, EVENTS } from './constants.js';
import { log, disconnectNodes } from './utils.js';

class VuMeter {
  constructor(config) {
    // Local (mic) VU meter elementleri
    this.barEl = document.getElementById(config.barId);
    this.peakEl = document.getElementById(config.peakId);
    this.dotEl = document.getElementById(config.dotId);

    // Remote (codec sonrasi) VU meter elementleri (opsiyonel)
    this.remoteBarEl = document.getElementById(config.remoteBarId || 'remoteVuBar');
    this.remotePeakEl = document.getElementById(config.remotePeakId || 'remoteVuPeak');
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

    // Performans: VU meter container genisligini cache'le (reflow onleme)
    this.meterWidth = this.peakEl?.parentElement?.offsetWidth || VU_METER.DEFAULT_METER_WIDTH;
    this.remoteMeterWidth = this.remotePeakEl?.parentElement?.offsetWidth || VU_METER.DEFAULT_METER_WIDTH;

    // Event listener referansları (memory leak önleme - stop()'da kaldırılır)
    this._onStreamStarted = (stream) => this.start(stream);
    this._onStreamStopped = () => this.stop();
    this._onLoopbackRemote = (stream) => this.startRemote(stream);
    this._onAnalyserReady = (analyserNode) => this.startWithAnalyser(analyserNode);

    // Event dinle
    eventBus.on(EVENTS.STREAM_STARTED, this._onStreamStarted);
    eventBus.on(EVENTS.STREAM_STOPPED, this._onStreamStopped);
    eventBus.on(EVENTS.LOOPBACK_REMOTE_STREAM, this._onLoopbackRemote);
    eventBus.on(EVENTS.PIPELINE_ANALYSER_READY, this._onAnalyserReady);

    // Resize event'inde meter width'i guncelle
    // Memory leak fix: Named handler, stop()'ta removeEventListener icin
    this.resizeHandler = () => {
      this.meterWidth = this.peakEl?.parentElement?.offsetWidth || VU_METER.DEFAULT_METER_WIDTH;
      this.remoteMeterWidth = this.remotePeakEl?.parentElement?.offsetWidth || VU_METER.DEFAULT_METER_WIDTH;
    };
    window.addEventListener('resize', this.resizeHandler);
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
  }

  /**
   * Pipeline'dan gelen analyserNode ile VU Meter baslat
   * Bu metod encode oncesi islenmiş sinyali gosterir (fan-out pattern)
   * @param {AnalyserNode} analyserNode - Pipeline'dan gelen analyser
   */
  startWithAnalyser(analyserNode) {
    if (!analyserNode) return;

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

    // DataArray olustur (pipeline'in audioContext'inden)
    const bufferLength = this.analyser.frequencyBinCount;
    this._pipelineDataArray = new Uint8Array(bufferLength);

    this.update();

    log.audio('VU Meter: Pipeline analyser baglandi', { fftSize: analyserNode.fftSize, source: 'pipeline' });

    eventBus.emit(EVENTS.VUMETER_STARTED);
  }

  async start(stream) {
    if (!stream) return;

    // Guard: Pipeline analyser zaten set edilmisse AudioEngine'e baglanma
    // pipeline:analyserReady event'i stream:started'dan ONCE gelirse bu guard calisir
    if (this.analyser) return;

    // Resize handler'i yeniden ekle (DRY)
    this._ensureResizeHandler();

    // Lazy warmup - AudioEngine henuz warmup yapilmamissa yap
    // Bu yol sadece Loopback/Monitor modunda kullanilir (kayit modunda pipeline analyser kullanilir)
    if (!audioEngine.isWarmedUp) {
      await audioEngine.warmup();
    }

    // AudioEngine'den hazir analyser al
    // Bu yol sadece Loopback modunda kullanilir (Local VU = HAM mikrofon)
    this.analyser = await audioEngine.connectStream(stream);
    this._pipelineDataArray = null; // AudioEngine kendi dataArray'ini kullanir
    this.update();

    // AudioContext bilgisini gonder (null kontrol ile)
    const ac = audioEngine.getContext();
    if (!ac) {
      log.error('VuMeter: AudioEngine context hazir degil', { isWarmedUp: audioEngine.isWarmedUp });
      return;
    }
    eventBus.emit(EVENTS.VUMETER_AUDIOCONTEXT, {
      sampleRate: ac.sampleRate,
      baseLatency: ac.baseLatency,
      outputLatency: ac.outputLatency,
      state: ac.state,
      fftSize: this.analyser.fftSize
    });

    eventBus.emit(EVENTS.VUMETER_STARTED);
  }

  /**
   * Remote stream (codec sonrasi) icin VU meter baslat
   * Loopback modunda WebRTC'den gelen sesi gosterir
   */
  async startRemote(stream) {
    if (!stream) return;

    // Remote container'i goster
    if (this.remoteContainerEl) {
      this.remoteContainerEl.style.display = 'block';
    }

    // DOM render sonrasi width hesapla (container artik gorunur)
    requestAnimationFrame(() => {
      this.remoteMeterWidth = this.remotePeakEl?.parentElement?.offsetWidth || VU_METER.DEFAULT_METER_WIDTH;
    });

    try {
      // Remote stream icin ayri AudioContext (cakisma onleme)
      this.remoteAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.remoteAudioCtx.state === 'suspended') {
        await this.remoteAudioCtx.resume();
      }

      this.remoteSourceNode = this.remoteAudioCtx.createMediaStreamSource(stream);
      this.remoteAnalyser = this.remoteAudioCtx.createAnalyser();
      this.remoteAnalyser.fftSize = AUDIO.FFT_SIZE;
      this.remoteSourceNode.connect(this.remoteAnalyser);

      log.stream('VU Meter: Remote stream baglandi', { streamId: stream.id });
    } catch (err) {
      log.error('VU Meter: Remote stream baglanti hatasi', { error: err.message });
    }
  }

  stopRemote() {
    disconnectNodes([this.remoteAnalyser, this.remoteSourceNode]);
    this.remoteAnalyser = null;
    this.remoteSourceNode = null;
    if (this.remoteAudioCtx) {
      this.remoteAudioCtx.close().catch(() => {});
      this.remoteAudioCtx = null;
    }

    // Remote VU elementlerini sifirla (container visibility'i UI tarafindan kontrol edilir)
    if (this.remoteBarEl) this.remoteBarEl.style.width = '0';
    if (this.remotePeakEl) this.remotePeakEl.style.transform = 'translateX(0)';
    // NOT: Container display'i burada degistirilmez - profil kategorisine gore UI tarafindan yonetilir

    this.remotePeakLevel = 0;
  }

  // DRY: RMS hesaplama (clipping tespiti icin hala kullanilabilir)
  calculateRMS(dataArray) {
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const val = (dataArray[i] - AUDIO.CENTER_VALUE) / AUDIO.CENTER_VALUE;
      sum += val * val;
    }
    return Math.sqrt(sum / dataArray.length);
  }

  // DRY: Peak hesaplama (update ve updateRemote icin ortak)
  calculatePeak(dataArray) {
    let maxSample = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const val = Math.abs((dataArray[i] - AUDIO.CENTER_VALUE) / AUDIO.CENTER_VALUE);
      if (val > maxSample) maxSample = val;
    }
    return maxSample;
  }

  /**
   * DRY: Ortak meter hesaplama ve render (local + remote icin)
   * @returns {{ level: number, dB: number, peakLevel: number, peakHoldTime: number }}
   */
  _renderMeter(analyser, dataArray, barEl, peakEl, peakLevel, peakHoldTime, meterWidth) {
    analyser.getByteTimeDomainData(dataArray);
    const rms = this.calculateRMS(dataArray);
    const dB = rms > VU_METER.RMS_THRESHOLD ? 20 * Math.log10(rms) : VU_METER.MIN_DB;
    const level = Math.max(0, Math.min(100, (dB - VU_METER.MIN_DB) / -VU_METER.MIN_DB * 100));

    if (barEl) barEl.style.width = `${level}%`;

    // Peak hold + decay
    if (level > peakLevel) {
      peakLevel = level;
      peakHoldTime = Date.now();
    } else if (Date.now() - peakHoldTime > VU_METER.PEAK_HOLD_TIME_MS) {
      peakLevel = Math.max(level, peakLevel - VU_METER.PEAK_DECAY_RATE);
    }

    if (peakEl) {
      peakEl.style.transform = `translateX(${(peakLevel / 100) * meterWidth}px)`;
    }

    return { level, dB, peakLevel, peakHoldTime };
  }

  update() {
    if (!this.analyser) return;

    const dataArray = this._pipelineDataArray || audioEngine.getDataArray();
    const result = this._renderMeter(
      this.analyser, dataArray, this.barEl, this.peakEl,
      this.peakLevel, this.peakHoldTime, this.meterWidth
    );
    this.peakLevel = result.peakLevel;
    this.peakHoldTime = result.peakHoldTime;

    // Clipping tespiti (peak dB kullan - anlik tepe degeri)
    const maxSample = this.calculatePeak(dataArray);
    const peakdB = maxSample > VU_METER.RMS_THRESHOLD ? 20 * Math.log10(maxSample) : VU_METER.MIN_DB;
    const isClipping = peakdB >= VU_METER.CLIPPING_THRESHOLD_DB;

    // Sinyal noktasi - sadece state degisince guncelle
    const newDotState = isClipping ? 'clipping' : (result.level > VU_METER.DOT_ACTIVE_THRESHOLD ? 'active' : 'idle');
    if (this.dotEl && this.dotState !== newDotState) {
      this.dotEl.className = 'signal-dot' + (newDotState !== 'idle' ? ' ' + newDotState : '');
      this.dotState = newDotState;
    }

    eventBus.emit(EVENTS.VUMETER_LEVEL, {
      level: result.level, peak: this.peakLevel, dB: result.dB.toFixed(1), isClipping
    });

    this.updateRemote();
    this.animationId = requestAnimationFrame(() => this.update());
  }

  updateRemote() {
    if (!this.remoteAnalyser) return;
    if (!this.remoteDataArray) {
      this.remoteDataArray = new Uint8Array(this.remoteAnalyser.frequencyBinCount);
    }

    const result = this._renderMeter(
      this.remoteAnalyser, this.remoteDataArray, this.remoteBarEl, this.remotePeakEl,
      this.remotePeakLevel, this.remotePeakHoldTime, this.remoteMeterWidth
    );
    this.remotePeakLevel = result.peakLevel;
    this.remotePeakHoldTime = result.peakHoldTime;
  }

  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    // Memory leak fix: Resize listener temizle
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
    }

    // Bar'lari sifirla
    if (this.barEl) this.barEl.style.width = '0';
    if (this.peakEl) this.peakEl.style.transform = 'translateX(0)';
    if (this.dotEl) {
      this.dotEl.className = 'signal-dot';
      this.dotState = 'idle';
    }

    this.peakLevel = 0;

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
    eventBus.off(EVENTS.STREAM_STARTED, this._onStreamStarted);
    eventBus.off(EVENTS.STREAM_STOPPED, this._onStreamStopped);
    eventBus.off(EVENTS.LOOPBACK_REMOTE_STREAM, this._onLoopbackRemote);
    eventBus.off(EVENTS.PIPELINE_ANALYSER_READY, this._onAnalyserReady);
  }
}

export default VuMeter;
