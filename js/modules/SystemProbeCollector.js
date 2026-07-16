/**
 * SystemProbeCollector - Pasif sistem/performans sinyali toplayici
 *
 * DURUSTLUK CERCEVESI: Tarayici sandbox'i gercek CPU%/RAM%/process listesi VEREMEZ.
 * Bu modul yalnizca DOLAYLI proxy sinyaller uretir; her cikti raporda confidence +
 * disclaimer ile etiketlenir. Hicbir yerde "CPU %85" gibi kesin sayi uretilmez.
 *
 * Topladiklari (ses grafigine HIC dokunmadan):
 *  - Ana-thread jitter (rAF sapmasi = CPU spike / arka plan yuku proxy'si)
 *  - Network glitch gecmisi (LOOPBACK_STATS'e pasif tutunur: concealment/jitter)
 *  - Ortam anlik okumalari (hardwareConcurrency, deviceMemory, AudioContext latency, JS heap)
 *
 * Yasam dongusu AudioMetricsCollector ile ayni sozlesme (start/stop/getResults/destroy),
 * kayit fazina senkron (TEST_RECORDING_STARTED/STOPPED, RECORDING_STARTED/COMPLETED).
 */
import eventBus from './EventBus.js';
import { EVENTS, JITTER } from './constants.js';
import { log } from './utils.js';

class SystemProbeCollector {
  constructor() {
    this._isProbing = false;
    this._rafId = null;
    this._startTime = 0;
    this._lastResults = null;

    // Jitter istatistikleri (Welford online)
    this._jitterCount = 0;
    this._jitterMean = 0;
    this._jitterM2 = 0;
    this._jitterMax = 0;
    this._spikeCount = 0;
    this._severeSpikeCount = 0;
    this._spikeEvents = [];
    this._lastFrameTs = 0;
    this._graceLeft = 0;

    // Network (LOOPBACK_STATS'ten)
    this._net = null;
    this._lastConcealedSamples = null;
    this._concealmentBursts = [];

    // Ortam
    this._env = null;
    this._heapStartMB = null;
    this._tabWasHidden = false;

    // Event handler referanslari
    this._onRecordingStarted = () => this.start({ source: 'record' });
    this._onTestStarted = () => this.start({ source: 'test' });
    this._onRecordingCompleted = () => this.stop();
    this._onTestStopped = () => this.stop();
    this._onForceStop = () => { if (this._isProbing) this.stop(); };
    this._onLoopbackStats = (stats) => this._collectLoopbackStats(stats);
    this._onVisibility = () => { if (document.hidden) this._tabWasHidden = true; };

    eventBus.on(EVENTS.RECORDING_STARTED, this._onRecordingStarted);
    eventBus.on(EVENTS.TEST_RECORDING_STARTED, this._onTestStarted);
    eventBus.on(EVENTS.RECORDING_COMPLETED, this._onRecordingCompleted);
    eventBus.on(EVENTS.TEST_RECORDING_STOPPED, this._onTestStopped);
    eventBus.on(EVENTS.STREAM_STOPPED, this._onForceStop);
    eventBus.on(EVENTS.TEST_CANCELLED, this._onForceStop);
    eventBus.on(EVENTS.LOOPBACK_STATS, this._onLoopbackStats);
  }

  // === PUBLIC API ===

  start() {
    if (this._isProbing) return;
    this._reset();
    this._isProbing = true;
    this._startTime = performance.now();
    this._graceLeft = JITTER.GRACE_SAMPLES;
    this._lastFrameTs = this._startTime;

    document.addEventListener('visibilitychange', this._onVisibility);
    if (document.hidden) this._tabWasHidden = true;

    this._readEnvironment();
    this._rafId = requestAnimationFrame(() => this._tick());
    log.system('SystemProbeCollector started');
  }

  stop() {
    if (!this._isProbing) return this._lastResults;
    this._isProbing = false;

    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    document.removeEventListener('visibilitychange', this._onVisibility);

    // JS heap bitis okumasi (delta = GC baskisi proxy'si)
    let heapDeltaMB = null, heapEndMB = null;
    try {
      const mem = performance.memory;
      if (mem && this._heapStartMB != null) {
        heapEndMB = +(mem.usedJSHeapSize / 1048576).toFixed(1);
        heapDeltaMB = +(heapEndMB - this._heapStartMB).toFixed(1);
      }
    } catch { /* Chrome-only */ }
    if (this._env && this._env.jsHeap) {
      this._env.jsHeap.usedMBEnd = heapEndMB;
      this._env.jsHeap.deltaMB = heapDeltaMB;
    }

    this._lastResults = this._computeResults();
    log.system('SystemProbeCollector stopped', {
      jitterSpikes: this._lastResults.mainThreadJitter?.spikeCount,
      maxFrameMs: this._lastResults.mainThreadJitter?.maxFrameMs
    });
    return this._lastResults;
  }

  getResults() {
    if (this._isProbing) return this._computeResults();
    return this._lastResults;
  }

  destroy() {
    this.stop();
    eventBus.off(EVENTS.RECORDING_STARTED, this._onRecordingStarted);
    eventBus.off(EVENTS.TEST_RECORDING_STARTED, this._onTestStarted);
    eventBus.off(EVENTS.RECORDING_COMPLETED, this._onRecordingCompleted);
    eventBus.off(EVENTS.TEST_RECORDING_STOPPED, this._onTestStopped);
    eventBus.off(EVENTS.STREAM_STOPPED, this._onForceStop);
    eventBus.off(EVENTS.TEST_CANCELLED, this._onForceStop);
    eventBus.off(EVENTS.LOOPBACK_STATS, this._onLoopbackStats);
  }

  // === PRIVATE ===

  _reset() {
    this._jitterCount = 0;
    this._jitterMean = 0;
    this._jitterM2 = 0;
    this._jitterMax = 0;
    this._spikeCount = 0;
    this._severeSpikeCount = 0;
    this._spikeEvents = [];
    this._net = null;
    this._lastConcealedSamples = null;
    this._concealmentBursts = [];
    this._env = null;
    this._heapStartMB = null;
    this._tabWasHidden = false;
  }

  /**
   * Ana-thread jitter olcum dongusu (rAF). Frame delta'si beklenenden buyukse = stall.
   * @private
   */
  _tick() {
    if (!this._isProbing) return;
    const now = performance.now();
    const delta = now - this._lastFrameTs;
    this._lastFrameTs = now;

    if (this._graceLeft > 0) {
      this._graceLeft--;
    } else {
      // Welford online mean/variance
      this._jitterCount++;
      const d = delta - this._jitterMean;
      this._jitterMean += d / this._jitterCount;
      this._jitterM2 += d * (delta - this._jitterMean);
      if (delta > this._jitterMax) this._jitterMax = delta;

      if (delta >= JITTER.SPIKE_THRESHOLD_MS) {
        this._spikeCount++;
        if (delta >= JITTER.SEVERE_SPIKE_THRESHOLD_MS) this._severeSpikeCount++;
        if (this._spikeEvents.length < JITTER.MAX_SPIKE_EVENTS) {
          this._spikeEvents.push({ tRelMs: Math.round(now - this._startTime), deltaMs: +delta.toFixed(1) });
        }
      }
    }

    this._rafId = requestAnimationFrame(() => this._tick());
  }

  /**
   * LOOPBACK_STATS'e pasif tutunur; concealment burst'lerini timestamp'ler.
   * @private
   */
  _collectLoopbackStats(stats) {
    if (!this._isProbing || !stats) return;
    // En guncel degerleri sakla
    this._net = {
      jitterMs: stats.jitterMs ?? null,
      jitterBufferDelayMsAvg: stats.jitterBufferDelayMsAvg ?? null,
      concealedSamples: stats.concealedSamples ?? null,
      concealmentEvents: stats.concealmentEvents ?? null,
      insertedSamplesForDeceleration: stats.insertedSamplesForDeceleration ?? null,
      removedSamplesForAcceleration: stats.removedSamplesForAcceleration ?? null,
      totalSamplesReceived: stats.totalSamplesReceived ?? null,
      packetLossRate: stats.packetLossRate ?? null
    };

    // Concealment delta -> burst
    if (typeof stats.concealedSamples === 'number') {
      if (this._lastConcealedSamples != null) {
        const delta = stats.concealedSamples - this._lastConcealedSamples;
        if (delta > 0 && this._concealmentBursts.length < JITTER.MAX_SPIKE_EVENTS) {
          this._concealmentBursts.push({
            tRelMs: Math.round(performance.now() - this._startTime),
            deltaConcealedSamples: delta
          });
        }
      }
      this._lastConcealedSamples = stats.concealedSamples;
    }
  }

  /**
   * Ortam anlik okumalari. AudioContext.latency icin kisa omurlu bagimsiz context.
   * @private
   */
  _readEnvironment() {
    const env = {
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemoryGB: navigator.deviceMemory ?? null,  // Chrome-only, KABA (banded), "yaklasik"
      audioContext: { supported: false, baseLatencyMs: null, outputLatencyMs: null, sampleRate: null },
      jsHeap: { supported: false, usedMBStart: null, usedMBEnd: null, deltaMB: null }
    };

    // JS heap baslangic (Chrome-only)
    try {
      const mem = performance.memory;
      if (mem) {
        env.jsHeap.supported = true;
        env.jsHeap.usedMBStart = +(mem.usedJSHeapSize / 1048576).toFixed(1);
        this._heapStartMB = env.jsHeap.usedMBStart;
      }
    } catch { /* */ }

    // AudioContext latency: kisa omurlu, bagimsiz, resume EDILMEDEN okunur (yan etki yok).
    // baseLatency suspended durumda da mevcut; outputLatency context calismadan 0 olabilir -> null birak.
    // Not: bu context gercek pipeline context'i ile birebir olmayabilir (farkli latencyHint/sample rate).
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (Ctor) {
        const ctx = new Ctor();
        env.audioContext.supported = true;
        env.audioContext.baseLatencyMs = ctx.baseLatency != null ? +(ctx.baseLatency * 1000).toFixed(2) : null;
        env.audioContext.outputLatencyMs = (ctx.outputLatency != null && ctx.outputLatency > 0) ? +(ctx.outputLatency * 1000).toFixed(2) : null;
        env.audioContext.sampleRate = ctx.sampleRate ?? null;
        ctx.close?.().catch?.(() => {});
      }
    } catch { /* */ }

    this._env = env;
  }

  /**
   * Toplanan sinyalleri rapor sema'sina donustur (correlation DiagnosticReportBuilder'da).
   * @private
   */
  _computeResults() {
    const durationMs = Math.round(performance.now() - this._startTime);
    const variance = this._jitterCount > 1 ? this._jitterM2 / (this._jitterCount - 1) : 0;

    const mainThreadJitter = {
      supported: true,
      sampleCount: this._jitterCount,
      durationMs,
      avgFrameMs: +this._jitterMean.toFixed(2),
      maxFrameMs: +this._jitterMax.toFixed(1),
      stdDevMs: +Math.sqrt(variance).toFixed(2),
      spikeThresholdMs: JITTER.SPIKE_THRESHOLD_MS,
      spikeCount: this._spikeCount,
      severeSpikeThresholdMs: JITTER.SEVERE_SPIKE_THRESHOLD_MS,
      severeSpikeCount: this._severeSpikeCount,
      spikeEvents: this._spikeEvents.slice()
    };

    let network = null;
    if (this._net) {
      const cs = this._net.concealedSamples;
      const tot = this._net.totalSamplesReceived;
      network = {
        supported: cs != null || this._net.concealmentEvents != null,
        jitterMs: this._net.jitterMs,
        jitterBufferDelayMsAvg: this._net.jitterBufferDelayMsAvg,
        concealedSamples: cs,
        concealmentEvents: this._net.concealmentEvents,
        concealmentRatio: (cs != null && tot) ? +(cs / tot).toFixed(5) : null,
        insertedSamplesForDeceleration: this._net.insertedSamplesForDeceleration,
        removedSamplesForAcceleration: this._net.removedSamplesForAcceleration,
        packetLossRate: this._net.packetLossRate,
        concealmentBursts: this._concealmentBursts.slice()
      };
    }

    return {
      environment: this._env,
      mainThreadJitter,
      network,
      tabWasHidden: this._tabWasHidden
    };
  }
}

// Singleton
const systemProbeCollector = new SystemProbeCollector();
export default systemProbeCollector;
