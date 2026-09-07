/** Decode the saved file, preserve channels, and compute report metrics off-thread. */
import eventBus from './EventBus.js';
import { EVENTS, DEEP_ANALYSIS, QUALITY } from './constants.js';
import { log } from './utils/log.js';

const WORKER_URL = new URL('../workers/spectral-analysis-worker.js', import.meta.url).href;

export class DeepAnalysisEngine {
  constructor() {
    this._lastResults = null;
    this._job = null;
    this._runCounter = 0;
  }

  getResults() { return this._lastResults; }

  reset() {
    this.cancel();
    this._lastResults = null;
  }

  /** Cancel only the matching owner, or all work when no runId is supplied. */
  cancel(runId = null) {
    const job = this._job;
    if (!job || (runId !== null && job.runId !== runId)) return false;
    this._interrupt(job, 'cancelled', 'analysis-cancelled');
    return true;
  }

  _interrupt(job, status, reason) {
    if (!this._isCurrent(job)) return;
    job.cancelled = true;
    this._job = null;
    clearTimeout(job.timeoutId);
    const result = { runId: job.runId, status, reason, audioMetrics: null };
    if (status === 'failed') this._lastResults = result;
    job.resolveCancelled(result);
    job.rejectWorker?.(new Error(reason));
    this._terminateWorker(job);
    if (job.context) {
      job.context.close().catch(() => {});
      job.context = null;
    }
    if (status === 'failed') eventBus.emit(EVENTS.DEEP_ANALYSIS_FAILED, result);
  }

  /** @param {Object} options {source:'test'|'record', runId, onProgress} */
  async analyze(blob, { source = 'test', runId = null, onProgress = null, guidedSegments = null } = {}) {
    this.cancel();
    this._lastResults = null;
    const job = { runId: runId ?? `analysis-${++this._runCounter}`, guidedSegments: guidedSegments ? structuredClone(guidedSegments) : null, cancelled: false, worker: null, context: null };
    const cancelled = new Promise(resolve => { job.resolveCancelled = resolve; });
    this._job = job;
    job.timeoutId = setTimeout(() => this._interrupt(job, 'failed', 'analysis-timeout'), DEEP_ANALYSIS.MAX_WAIT_MS);
    eventBus.emit(EVENTS.DEEP_ANALYSIS_STARTED, { source, runId: job.runId });
    // decodeAudioData cannot be aborted reliably. The public promise still settles
    // immediately on cancel, and identity checks discard any later decode result.
    return Promise.race([this._performAnalysis(blob, source, onProgress, job), cancelled]);
  }

  _isCurrent(job) { return this._job === job && !job.cancelled; }

  _publish(job, result) {
    if (!this._isCurrent(job)) return { runId: job.runId, status: 'cancelled', audioMetrics: null };
    clearTimeout(job.timeoutId);
    this._lastResults = { runId: job.runId, ...result };
    this._job = null;
    eventBus.emit(result.status === 'failed' ? EVENTS.DEEP_ANALYSIS_FAILED : EVENTS.DEEP_ANALYSIS_READY, this._lastResults);
    return this._lastResults;
  }

  async _performAnalysis(blob, kind, onProgress, job) {
    const started = performance.now();
    try {
      if (!blob?.size) return this._publish(job, { status: 'skipped', reason: 'empty-blob', audioMetrics: null });
      // decodeAudioData decodes the whole container before we can select a prefix.
      // Bound encoded input as well as the subsequent PCM/FFT workload.
      if (blob.size > DEEP_ANALYSIS.MAX_BLOB_BYTES) {
        return this._publish(job, { status: 'skipped', reason: 'file-too-large-for-analysis', audioMetrics: null });
      }
      const decoded = await this._decode(blob, job);
      if (!this._isCurrent(job)) return { runId: job.runId, status: 'cancelled', audioMetrics: null };
      const { channels, sampleRate, numberOfChannels, durationSec, analyzedDurationSec, truncated } = decoded;
      const source = { kind, blobSize: blob.size, mimeType: blob.type, sampleRate, numberOfChannels,
        durationSec, analyzedDurationSec, truncated, sampleRateBasis: 'decoded-pcm' };
      if (channels[0].length < DEEP_ANALYSIS.MIN_SAMPLES) {
        return this._publish(job, { status: 'skipped', reason: 'clip-too-short', source, audioMetrics: null });
      }
      const spectral = await this._runWorker(channels, sampleRate, onProgress, job);
      if (!this._isCurrent(job)) return { runId: job.runId, status: 'cancelled', audioMetrics: null };
      const audioMetrics = {
        ...spectral.audioMetrics, runId: job.runId,
        coverage: { sampleRate, sampleRateBasis: 'decoded-pcm', numberOfChannels, durationSec, analyzedDurationSec, truncated },
        frequencyResponse: spectral.frequencyResponse,
        frequencyProfile: { ...spectral.bands, unit: 'dB-relative-to-spectrum-mean',
          method: 'welch-channel-power-average', snapshotCount: spectral.frequencyResponse.frameCount }
      };
      const result = this._publish(job, {
        status: 'ready', version: '2.0', durationMs: Math.round(performance.now() - started), source,
        frequencyResponse: spectral.frequencyResponse, bands: spectral.bands,
        spectralFlatness: spectral.spectralFlatness, lowLevelPercentileDb: spectral.lowLevelPercentileDb,
        peakDb: spectral.peakDb, rmsDb: spectral.rmsDb,
        lufsIntegrated: audioMetrics.lufs.integrated, audioMetrics
      });
      log.system('Decoded file analysis ready', { runId: job.runId, durationMs: result.durationMs, truncated });
      return result;
    } catch (err) {
      if (!this._isCurrent(job)) return { runId: job.runId, status: 'cancelled', audioMetrics: null };
      log.error('Decoded file analysis failed', { error: err.message });
      return this._publish(job, { status: 'failed', reason: err.message, audioMetrics: null });
    } finally {
      this._terminateWorker(job);
    }
  }

  async _decode(blob, job) {
    const arrayBuffer = await blob.arrayBuffer();
    if (!this._isCurrent(job)) throw new Error('analysis-cancelled');
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    const context = new AudioCtx();
    job.context = context;
    let audioBuffer;
    try {
      audioBuffer = await context.decodeAudioData(arrayBuffer);
    } finally {
      if (job.context === context) job.context = null;
      await context.close().catch(() => {});
    }
    if (!this._isCurrent(job)) throw new Error('analysis-cancelled');
    const { sampleRate, numberOfChannels } = audioBuffer;
    const frames = Math.min(audioBuffer.length, Math.floor(DEEP_ANALYSIS.MAX_DURATION_SEC * sampleRate));
    const channels = Array.from({ length: numberOfChannels }, (_, index) => audioBuffer.getChannelData(index).slice(0, frames));
    return { channels, sampleRate, numberOfChannels,
      durationSec: audioBuffer.length / sampleRate, analyzedDurationSec: frames / sampleRate,
      truncated: audioBuffer.length > frames };
  }

  _runWorker(channels, sampleRate, onProgress, job) {
    return new Promise((resolve, reject) => {
      job.rejectWorker = reject;
      let fftSize = DEEP_ANALYSIS.FFT_SIZE;
      while (fftSize > channels[0].length) fftSize >>= 1;
      const worker = new Worker(WORKER_URL, { type: 'module' });
      job.worker = worker;
      worker.onmessage = ({ data: message }) => {
        if (!this._isCurrent(job) || message.runId !== job.runId) return;
        if (message.type === 'progress') {
          if (onProgress) onProgress(message.ratio);
          eventBus.emit(EVENTS.DEEP_ANALYSIS_PROGRESS, { runId: job.runId, ratio: message.ratio, stage: 'pcm-and-spectral' });
        } else if (message.type === 'done') {
          this._terminateWorker(job);
          resolve(message.result);
        } else if (message.type === 'error') {
          this._terminateWorker(job);
          reject(new Error(message.reason || 'PCM analysis worker error'));
        }
      };
      worker.onerror = error => {
        this._terminateWorker(job);
        reject(new Error(error.message || 'PCM analysis worker error'));
      };
      const buffers = channels.map(channel => channel.buffer);
      worker.postMessage({ type: 'analyze', runId: job.runId, channels: buffers, sampleRate, fftSize,
        guidedSegments: job.guidedSegments,
        hopSize: Math.max(1, Math.min(DEEP_ANALYSIS.HOP_SIZE, fftSize >> 1)),
        outputBins: DEEP_ANALYSIS.OUTPUT_BINS, progressInterval: DEEP_ANALYSIS.PROGRESS_FRAME_INTERVAL,
        bands: { subBass: QUALITY.FREQUENCY_BANDS.SUB_BASS, lowMid: QUALITY.FREQUENCY_BANDS.LOW_MID,
          highMid: QUALITY.FREQUENCY_BANDS.HIGH_MID, presence: QUALITY.FREQUENCY_BANDS.PRESENCE }
      }, buffers);
    });
  }

  _terminateWorker(job) {
    if (job.worker) {
      job.worker.onmessage = null; job.worker.onerror = null;
      job.worker.terminate(); job.worker = null;
    }
    job.rejectWorker = null;
  }

  destroy() { this.reset(); }
}

export default new DeepAnalysisEngine();
