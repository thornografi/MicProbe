/**
 * DeepAnalysisEngine - Offline derin ses analizi orkestratoru
 *
 * Kayit bittiginde blob'u decode eder, mono downmix yapar, tam-clip integrated LUFS'u
 * (ana thread, hizli) hesaplar ve agir spektral pass'i (yuksek cozunurluklu FFT) bir
 * Web Worker'a devreder. Worker progress'i EventBus'a koprulenerek "Analysing" progress
 * bar'ini besler. Ses hicbir zaman tarayicidan cikmaz — tum hesaplama client-side.
 *
 * Kullanim (TestRecordingFlow):
 *   await deepAnalysisEngine.analyze(blob, { source: 'test', onProgress: r => ... });
 *   const result = deepAnalysisEngine.getResults();  // DiagnosticReportBuilder da event ile yakalar
 */
import eventBus from './EventBus.js';
import { EVENTS, DEEP_ANALYSIS, QUALITY } from './constants.js';
import { log } from './utils.js';
import { LUFSCalculator } from './utils/lufs.js';

const WORKER_URL = new URL('../workers/spectral-analysis-worker.js', import.meta.url).href;

class DeepAnalysisEngine {
  constructor() {
    this._lastResults = null;
    this._worker = null;
  }

  /** @returns {Object|null} Son analiz sonucu (DiagnosticReportBuilder build aninda da okur) */
  getResults() {
    return this._lastResults;
  }

  reset() {
    this._lastResults = null;
    this._terminateWorker();
  }

  /**
   * Blob'u derinlemesine analiz et.
   * @param {Blob} blob - Kayit blob'u (webm/opus)
   * @param {Object} options - { source: 'test'|'record', onProgress: (ratio)=>void }
   * @returns {Promise<Object>} deepAnalysis payload ({ status, ... })
   */
  async analyze(blob, options = {}) {
    const { source = 'test', onProgress = null } = options;
    this._lastResults = null;

    if (!blob || blob.size === 0) {
      this._lastResults = { status: 'skipped', reason: 'empty-blob' };
      return this._lastResults;
    }

    eventBus.emit(EVENTS.DEEP_ANALYSIS_STARTED, { source });
    const started = performance.now();

    try {
      const { mono, sampleRate, numberOfChannels, durationSec, truncated } = await this._decode(blob);

      if (mono.length < DEEP_ANALYSIS.MIN_SAMPLES) {
        this._lastResults = {
          status: 'skipped',
          reason: 'clip-too-short',
          source: { blobSize: blob.size, mimeType: blob.type, sampleRate, numberOfChannels, durationSec }
        };
        eventBus.emit(EVENTS.DEEP_ANALYSIS_READY, this._lastResults);
        return this._lastResults;
      }

      // LUFS: ana thread (tam PCM tek seferde — 7s @48k ~ birkac ms, bloklamaz)
      const lufs = this._computeLufs(mono, sampleRate);

      // Agir spektral pass: Worker (mono.buffer transfer edilir)
      const spectral = await this._runWorker(mono, sampleRate, onProgress);

      const durationMs = Math.round(performance.now() - started);
      this._lastResults = {
        status: 'ready',
        version: '1.0',
        durationMs,
        source: { blobSize: blob.size, mimeType: blob.type, sampleRate, numberOfChannels, durationSec, truncated },
        frequencyResponse: spectral.frequencyResponse,
        bands: spectral.bands,
        spectralFlatness: spectral.spectralFlatness,
        noiseFloorDb: spectral.noiseFloorDb,
        peakDb: spectral.peakDb,
        rmsDb: spectral.rmsDb,
        lufsIntegratedExact: lufs.integrated
      };
      eventBus.emit(EVENTS.DEEP_ANALYSIS_READY, this._lastResults);
      log.system('Deep analysis ready', {
        durationMs,
        frames: spectral.frequencyResponse?.frameCount,
        lufs: lufs.integrated
      });
      return this._lastResults;
    } catch (err) {
      // Analiz hatasi FATAL DEGIL — rapor deepAnalysis:null ile devam eder
      log.error('Deep analysis failed', { error: err.message });
      this._lastResults = { status: 'failed', reason: err.message };
      eventBus.emit(EVENTS.DEEP_ANALYSIS_FAILED, { reason: err.message });
      return this._lastResults;
    }
  }

  /**
   * Blob -> AudioBuffer -> mono Float32 (kanal ortalamasi), MAX_DURATION_SEC ile kirpilir.
   * @private
   */
  async _decode(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();

    let audioBuffer;
    try {
      audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    } finally {
      await ctx.close().catch(() => {});
    }

    const sampleRate = audioBuffer.sampleRate;
    const numberOfChannels = audioBuffer.numberOfChannels;
    const maxSamples = Math.floor(DEEP_ANALYSIS.MAX_DURATION_SEC * sampleRate);
    const frames = Math.min(audioBuffer.length, maxSamples);
    const truncated = audioBuffer.length > maxSamples;

    // Mono downmix (kanal toplami / kanal sayisi)
    const mono = new Float32Array(frames);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) mono[i] += data[i];
    }
    if (numberOfChannels > 1) {
      const inv = 1 / numberOfChannels;
      for (let i = 0; i < frames; i++) mono[i] *= inv;
    }

    return { mono, sampleRate, numberOfChannels, durationSec: +audioBuffer.duration.toFixed(2), truncated };
  }

  /**
   * Tam-clip integrated LUFS (LUFSCalculator reuse — DRY).
   * @private
   */
  _computeLufs(mono, sampleRate) {
    const calc = new LUFSCalculator(sampleRate);
    calc.process(mono);
    return calc.getResults();
  }

  /**
   * fftSize'i clip uzunluguna sigdir (en buyuk 2^k <= n, tavan DEEP_ANALYSIS.FFT_SIZE).
   * @private
   */
  _fitFftSize(n) {
    let size = DEEP_ANALYSIS.FFT_SIZE;
    while (size > n) size >>= 1;
    return size;
  }

  /**
   * Spektral pass'i Worker'da calistir; progress'i koprule.
   * @private
   */
  _runWorker(mono, sampleRate, onProgress) {
    return new Promise((resolve, reject) => {
      this._terminateWorker();

      const fftSize = this._fitFftSize(mono.length);
      const hopSize = Math.max(1, Math.min(DEEP_ANALYSIS.HOP_SIZE, fftSize >> 1));

      const worker = new Worker(WORKER_URL);
      this._worker = worker;

      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') {
          if (onProgress) onProgress(m.ratio);
          eventBus.emit(EVENTS.DEEP_ANALYSIS_PROGRESS, { ratio: m.ratio, stage: 'spectral' });
        } else if (m.type === 'done') {
          this._terminateWorker();
          resolve(m.result);
        } else if (m.type === 'error') {
          this._terminateWorker();
          reject(new Error(m.reason || 'spectral worker error'));
        }
      };

      worker.onerror = (err) => {
        this._terminateWorker();
        reject(new Error('Spectral worker error: ' + (err.message || 'unknown')));
      };

      const pcm = mono.buffer; // LUFS zaten hesaplandi; mono artik transfer edilebilir
      worker.postMessage({
        type: 'analyze',
        pcm,
        sampleRate,
        fftSize,
        hopSize,
        outputBins: DEEP_ANALYSIS.OUTPUT_BINS,
        progressInterval: DEEP_ANALYSIS.PROGRESS_FRAME_INTERVAL,
        bands: {
          subBass: QUALITY.FREQUENCY_BANDS.SUB_BASS,
          lowMid: QUALITY.FREQUENCY_BANDS.LOW_MID,
          highMid: QUALITY.FREQUENCY_BANDS.HIGH_MID,
          presence: QUALITY.FREQUENCY_BANDS.PRESENCE
        }
      }, [pcm]);
    });
  }

  /** @private */
  _terminateWorker() {
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
  }

  destroy() {
    this._terminateWorker();
    this._lastResults = null;
  }
}

// Singleton
const deepAnalysisEngine = new DeepAnalysisEngine();
export default deepAnalysisEngine;
