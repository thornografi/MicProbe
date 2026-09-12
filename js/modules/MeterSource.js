import { VU_METER } from './constants.js';
import { log } from './utils/log.js';

const workletUrl = new URL('../worklets/meter-processor.js', import.meta.url).href;
const loading = new WeakMap();

// Single-pass fallback; also usable without an AudioWorklet in presentation tests.
export function readMeterSamples(analyser, data) {
  analyser.getFloatTimeDomainData(data);
  let sum = 0, peak = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
    peak = Math.max(peak, Math.abs(data[i]));
  }
  return { rms: Math.sqrt(sum / data.length), peak };
}

export default class MeterSource {
  constructor(analyser) {
    this.analyser = analyser;
    this.context = analyser.context;
    // Best effort during loading/unsupported browsers. Cover at least 25 ms
    // at this context's rate, without changing the separate spectral analyser.
    analyser.fftSize = Math.min(32768, Math.max(32, 2 ** Math.ceil(Math.log2(this.context.sampleRate * 0.025))));
    this.data = new Float32Array(analyser.fftSize);
    this.mode = 'analyser';
    this.peak = 0;
    this.peakTime = -Infinity;
    this.sumSquares = 0;
    this.sampleCount = 0;
    this.discardBefore = -Infinity;
    this._onStateChange = () => {
      this.discardBefore = this.context.currentTime;
      this.latest = null;
      this.peak = this.sumSquares = this.sampleCount = 0;
      this.peakTime = -Infinity;
    };
    this.context.addEventListener('statechange', this._onStateChange);
    this.closed = false;
    this.ready = this._connect();
  }

  async _connect() {
    const context = this.context;
    if (!context.audioWorklet || typeof AudioWorkletNode !== 'function') return;
    try {
      if (!loading.has(context)) {
        const promise = context.audioWorklet.addModule(workletUrl);
        loading.set(context, promise);
        promise.catch(() => loading.delete(context));
      }
      await loading.get(context);
      if (this.closed || context.state === 'closed') return;
      const node = new AudioWorkletNode(context, 'meter-processor', {
        channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: {
          intervalMs: VU_METER.SAMPLE_INTERVAL_MS,
          clipThreshold: 10 ** (VU_METER.CLIPPING_THRESHOLD_DB / 20),
          highThreshold: 10 ** (VU_METER.HIGH_LEVEL_DB / 20)
        }
      });
      this.node = node;
      node.port.onmessage = ({ data }) => {
        if (this.closed || this.node !== node) return;
        if (data.time <= this.discardBefore) { node.port.postMessage('ack'); return; }
        this.latest = data;
        this.sumSquares += data.sumSquares;
        this.sampleCount += data.sampleCount;
        this.receivedAt = performance.now();
        if (data.peak >= this.peak || data.time - this.peakTime > VU_METER.SAMPLE_FRESH_MS / 1000) {
          this.peak = data.peak;
          this.peakTime = data.peakTime;
        }
        this.mode = 'worklet';
        node.port.postMessage('ack');
      };
      node.onprocessorerror = () => this._fallback(new Error('Meter processor stopped'));
      this.analyser.connect(node);
      node.connect(context.destination);
    } catch (error) {
      if (!this.closed) this._fallback(error);
    }
  }

  read() {
    if (this.context.state !== 'running') return { rms: 0, peak: 0 };
    if (!this.latest) return this.mode === 'worklet' ? { rms: 0, peak: 0 } : readMeterSamples(this.analyser, this.data);
    const latest = this.latest;
    // Both clocks matter: AudioContext time freezes when suspended, while a
    // queued message may already be old when it reaches a busy main thread.
    const time = Math.max(this.context.currentTime, latest.time + (performance.now() - this.receivedAt) / 1000);
    const fresh = (time - latest.time) * 1000 <= VU_METER.SAMPLE_FRESH_MS;
    const peak = fresh ? Math.max(latest.livePeak,
      this.peakTime > this.discardBefore && (time - this.peakTime) * 1000 <= VU_METER.SAMPLE_FRESH_MS ? this.peak : 0) : 0;
    // Account for all packets between paints. After a long stall use the latest
    // bucket instead of diluting live RMS with the stalled interval's history.
    const rms = this.sampleCount > 0 && this.sampleCount / this.context.sampleRate * 1000 <= VU_METER.SAMPLE_FRESH_MS
      ? Math.sqrt(this.sumSquares / this.sampleCount) : latest.rms;
    this.sumSquares = this.sampleCount = 0;
    this.peak = 0;
    this.peakTime = -Infinity;
    return {
      rms: fresh ? rms : 0, peak,
      clipAgeMs: latest.clipTime > this.discardBefore ? Math.max(0, (time - latest.clipTime) * 1000) : Infinity,
      highAgeMs: latest.highTime > this.discardBefore ? Math.max(0, (time - latest.highTime) * 1000) : Infinity
    };
  }

  _disconnect() {
    const node = this.node;
    if (!node) return;
    this.node = null;
    node.onprocessorerror = null;
    node.port.onmessage = null;
    node.port.postMessage('stop');
    node.port.close();
    // Remove only our sidechain; the analyser and its context belong to capture.
    try { this.analyser.disconnect(node); } catch { /* already disconnected */ }
    node.disconnect();
  }

  _fallback(error) {
    this._disconnect();
    this.latest = null;
    this.mode = 'analyser';
    log.audio('VU Meter: Using analyser fallback', { error: error.message });
  }

  close() {
    this.closed = true;
    this.context.removeEventListener('statechange', this._onStateChange);
    this._disconnect();
    this.latest = null;
  }
}
