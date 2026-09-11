/**
 * WorkletPipeline - AudioWorkletNode ile modern audio isleme
 * OCP: Yeni pipeline eklemek icin BasePipeline'i extend et
 * DRY: Opus worker islemleri BasePipeline'dan miras alinir
 *
 * Graph (encoder'a gore degisir):
 *   MediaRecorder: Source -> AudioWorklet -> AnalyserNode (VU) + Worklet -> Destination
 *   WASM Opus/PCM: Source -> AudioWorklet -> AnalyserNode (VU) + muted destination
 *
 * Desteklenen encoder'lar:
 * - mediarecorder: Tarayici MediaRecorder API (standard WebM/Opus)
 * - wasm-opus: Yerel voice-note senaryolari icin WASM Opus encoder
 * - pcm-wav: Raw PCM 16-bit WAV (sifir compression)
 *
 * AudioWorklet avantajlari:
 * - Gelen render bloklari kendi uzunluklariyla islenir
 * - Processor audio thread'de; PCM aktarimi ve biriktirme main thread'de
 * - Modern API (ScriptProcessor deprecated)
 */
import BasePipeline from './BasePipeline.js';
import { createPassthroughWorkletNode, ensurePassthroughWorklet } from '../modules/WorkletHelper.js';
import { ENCODER_TYPES, OPUS, RECORDING } from '../modules/constants.js';
import { createWavBlob, log, usesMediaRecorder } from '../modules/utils.js';

export default class WorkletPipeline extends BasePipeline {
  constructor(audioContext, sourceNode, destinationNode) {
    super(audioContext, sourceNode, destinationNode);
    // Opus icin context hizina gore 20 ms'lik kanal tamponlari.
    this.accumulator = null;
    this.accumulatorIndex = 0;

    // PCM/WAV modu icin
    this._encoderMode = null; // 'wasm-opus' veya 'pcm-wav'
    this._pcmChunks = []; // PCM data biriktirme
    this._pcmBytes = 0;
    this._stopCapturePromise = null;
    this._captureStop = null;
    this._memoryLimitReached = false;
    this.onCaptureLimit = null;
  }

  get type() {
    return 'worklet';
  }

  /**
   * AudioWorklet pipeline kur
   * Desteklenen encoder'lar: wasm-opus, pcm-wav
   * @param {Object} options - { mediaBitrate, channels, encoder }
   */
  async setup(options = {}) {
    const { mediaBitrate = 0, channels = 1, encoder = 'wasm-opus' } = options;
    this._channels = channels;
    this._encoderMode = encoder;

    // Worklet module'unu yukle (ilk seferde)
    await ensurePassthroughWorklet(this.audioContext, options.signal);

    // Passthrough worklet node olustur
    this.nodes.worklet = createPassthroughWorkletNode(this.audioContext);
    this.nodes.worklet.channelCount = channels;
    this.nodes.worklet.channelCountMode = 'explicit';
    this.nodes.worklet.channelInterpretation = 'speakers';

    // Encoder moduna gore kurulum
    if (encoder === ENCODER_TYPES.PCM_WAV) {
      await this._setupPcmWav();
    } else if (usesMediaRecorder(encoder)) {
      // MediaRecorder encoder kurulumu
      this._setupMediaRecorderGraph();
    } else {
      // WASM Opus encoder kurulumu (varsayilan)
      await this._setupWasmOpus(mediaBitrate, options.signal);
    }
  }

  /**
   * DRY: Ortak worklet graph kurulumu (PCM ve Opus icin)
   * enablePcm -> onmessage handler -> analyser -> source connect -> worklet connect
   */
  _setupWorkletGraph(onPcmData) {
    this.nodes.worklet.port.onmessage = (e) => {
      if (e.data.command === 'pcmStopped') {
        this.isCapturing = false;
        this._captureStop?.resolve();
        return;
      }
      if (e.data.error) {
        log.error('AudioWorklet error', { error: e.data.error });
        this.onCaptureError?.(new Error(e.data.error));
        return;
      }
      if (!this.isCapturing || this._memoryLimitReached) return;
      try {
        if (e.data.pcmChannels) {
          onPcmData(e.data.pcmChannels);
        } else if (e.data.pcm) {
          onPcmData([new Float32Array(e.data.pcm)]);
        }
      } catch (error) {
        this.onCaptureError?.(error);
      }
    };
    this.createAnalyser();
    this.createAnalysisAnalyser(this.nodes.worklet);
    this.sourceNode.connect(this.nodes.worklet);
    this.nodes.worklet.connect(this.analyserNode);
  }

  startCapture() {
    super.startCapture();
    if (!usesMediaRecorder(this._encoderMode)) {
      this.nodes.worklet.port.postMessage({ command: 'enablePcm' });
    }
  }

  stopCapture() {
    if (this._stopCapturePromise) return this._stopCapturePromise;
    if (!this.isCapturing || usesMediaRecorder(this._encoderMode)) {
      super.stopCapture();
      return Promise.resolve();
    }
    this._stopCapturePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.isCapturing = false;
        reject(new Error('AudioWorklet did not acknowledge capture completion'));
      }, RECORDING.WORKLET_STOP_TIMEOUT_MS);
      this._captureStop = { resolve: () => { clearTimeout(timeout); resolve(); }, timeout };
      this.nodes.worklet.port.postMessage({ command: 'stopPcm' });
    });
    return this._stopCapturePromise;
  }

  /**
   * AudioWorklet kanal bloklarini WAV'in bekledigi interleaved PCM formuna cevir.
   * Eksik kanal varsa ilk kanali kopyalar; boylece WAV header kanal sayisi ile data uyumlu kalir.
   */
  _interleaveChannels(channelData) {
    if (!Array.isArray(channelData) || channelData.length === 0 || !channelData[0]) {
      return new Float32Array(0);
    }

    const channelCount = Math.max(1, this._channels || 1);
    const frameCount = channelData.reduce((max, channel) => Math.max(max, channel?.length || 0), 0);
    const interleaved = new Float32Array(frameCount * channelCount);

    for (let frame = 0; frame < frameCount; frame++) {
      for (let channel = 0; channel < channelCount; channel++) {
        const sourceChannel = channelData[channel] || channelData[0];
        interleaved[(frame * channelCount) + channel] = sourceChannel?.[frame] || 0;
      }
    }

    return interleaved;
  }

  /**
   * MediaRecorder encoder kurulumu
   * Graph: Source -> Worklet -> AnalyserNode (VU) + Worklet -> Destination
   * destinationNode, Recorder.js tarafindan olusturulup constructor'da aktarilir
   */
  _setupMediaRecorderGraph() {
    this.createAnalyser();
    this.createAnalysisAnalyser(this.nodes.worklet);
    this.sourceNode.connect(this.nodes.worklet);
    this.nodes.worklet.connect(this.analyserNode);

    // Worklet'ten destinationNode'a bagla (MediaRecorder bu stream'i kaydeder)
    if (this.destinationNode) {
      this.nodes.worklet.connect(this.destinationNode);
    } else {
      throw new Error('WorkletPipeline requires a destination for MediaRecorder');
    }

    this.log('AudioWorklet + MediaRecorder graph connected', {
      graph: 'Source -> Worklet -> [AnalyserNode (VU) + Destination]',
      encoder: ENCODER_TYPES.MEDIARECORDER,
      hasDestination: !!this.destinationNode
    });
  }

  /**
   * PCM/WAV encoder kurulumu (raw recording)
   */
  async _setupPcmWav() {
    this._pcmChunks = [];
    this._setupWorkletGraph(channels => {
      const nextBytes = (channels[0]?.length || 0) * this._channels * Float32Array.BYTES_PER_ELEMENT;
      if (this._pcmBytes + nextBytes > RECORDING.MAX_PCM_BYTES) {
        this._memoryLimitReached = true;
        this.onCaptureLimit?.();
        return;
      }
      const interleaved = this._interleaveChannels(channels);
      if (interleaved.length > 0) {
        this._pcmChunks.push(interleaved);
        this._pcmBytes += interleaved.byteLength;
        this.capturedFrames += interleaved.length / this._channels;
      }
    });
    // A muted sink keeps the worklet graph rendering without microphone playback.
    this._createMuteGain(this.nodes.worklet);

    this.log('AudioWorklet + PCM/WAV graph connected', {
      graph: 'Source -> Worklet -> [AnalyserNode (VU) + MuteGain -> Destination]',
      encoder: 'pcm-wav',
      sampleRate: this.audioContext.sampleRate,
      channels: this._channels
    });
  }

  /**
   * WASM Opus encoder kurulumu (accumulator pattern)
   * DRY: Opus worker BasePipeline._initOpusWorker() ile olusturulur
   */
  async _setupWasmOpus(mediaBitrate, signal) {
    const opusBitrate = await this._initOpusWorker(mediaBitrate, this._channels, 2048, signal);
    this._frameSize = Math.round(this.audioContext.sampleRate * OPUS.FRAME_SIZE / 48000);
    this.accumulator = Array.from({ length: this._channels }, () => new Float32Array(this._frameSize));
    this.accumulatorIndex = 0;

    this._setupWorkletGraph(channels => this._accumulateAndEncode(channels));
    this._createMuteGain(this.nodes.worklet);

    this.log('AudioWorklet + WASM Opus graph connected (fan-out)', {
      graph: 'Source -> Worklet -> [AnalyserNode (VU) + MuteGain -> Destination]',
      frameSize: OPUS.FRAME_SIZE,
      bitrate: opusBitrate,
      encoderType: this.opusWorker.encoderType
    });
  }

  /**
   * Gelen PCM bloklarini kanal basina _frameSize ornege tamamlayip Opus'a gonder.
   */
  _accumulateAndEncode(channels) {
    // Guard: cleanup sonrasi gelen worklet mesajlarini yoksay
    if (!this.accumulator || !this.opusWorker) {
      return;
    }

    try {
      const pcmData = channels[0] || new Float32Array(0);
      for (let i = 0; i < pcmData.length; i++) {
        for (let channel = 0; channel < this._channels; channel++) {
          this.accumulator[channel][this.accumulatorIndex] = (channels[channel] || pcmData)[i];
        }
        this.accumulatorIndex++;

        // Frame doldu, encode et
        if (this.accumulatorIndex >= this._frameSize) {
          this.opusWorker.encode(this.accumulator.map(channel => channel.slice()));
          this.accumulatorIndex = 0;
        }
      }
      this.capturedFrames += pcmData.length;
    } catch (err) {
      log.error('WASM Opus encode error', { error: err.message, stack: err.stack });
      this.onCaptureError?.(err);
    }
  }

  /**
   * Temizlik - Opus worker ve PCM buffer dahil
   * DRY: Opus cleanup BasePipeline._cleanupOpusWorker() ile yapilir
   */
  async cleanup() {
    this.isCapturing = false;
    if (this._captureStop) {
      clearTimeout(this._captureStop.timeout);
      this._captureStop.resolve();
      this._captureStop = null;
    }
    // Önce mesajı gönder, sonra handler'ı temizle (sıra önemli!)
    if (this.nodes.worklet) {
      try { this.nodes.worklet.port.postMessage({ command: 'disablePcm' }); } catch (error) {
        log.error('AudioWorklet port cleanup failed', { error: error.message });
      }
      this.nodes.worklet.port.onmessage = null;
    }

    // DRY: Ortak Opus worker temizligi
    this._cleanupOpusWorker();

    // Accumulator temizle (Opus)
    this.accumulator = null;
    this.accumulatorIndex = 0;

    // PCM chunks temizle
    this._pcmChunks = [];
    this._pcmBytes = 0;
    this._encoderMode = null;

    await super.cleanup();
    this.log('AudioWorklet pipeline cleanup complete');
  }

  /**
   * Opus encoding'i bitir ve blob dondur
   * Override: Accumulator'daki kalan veriyi gonder
   */
  async finishOpusEncoding() {
    if (!this.opusWorker) {
      throw new Error('Opus worker not available');
    }

    // Null guard: cleanup sonrası çağrılmış olabilir
    if (!this.accumulator) {
      return await this.opusWorker.finish();
    }

    // The bundled stereo interleaver requires fixed block sizes. Track the valid
    // frames separately so encoder padding never inflates capture duration.
    if (this.accumulatorIndex > 0) {
      for (const channel of this.accumulator) channel.fill(0, this.accumulatorIndex);
      this.opusWorker.encode(this.accumulator.map(channel => channel.slice()), this.accumulatorIndex);
      this.accumulatorIndex = 0;
    }

    return await this.opusWorker.finish();
  }

  /**
   * PCM/WAV encoding'i bitir ve WAV blob dondur
   * @returns {Object} - { blob, sampleCount, encoderType }
   */
  async finishPcmWavEncoding() {
    if (this._encoderMode !== 'pcm-wav') {
      throw new Error('PCM/WAV mode not active');
    }

    const totalSamples = this._pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const blob = await createWavBlob(this._pcmChunks, this.audioContext.sampleRate, this._channels);

    this.log('PCM/WAV encoding complete', {
      sampleCount: totalSamples / this._channels,
      chunkCount: this._pcmChunks.length,
      blobSize: blob.size,
      sampleRate: this.audioContext.sampleRate,
      channels: this._channels
    });

    return {
      blob,
      sampleCount: totalSamples / this._channels,
      sampleRate: this.audioContext.sampleRate,
      channels: this._channels,
      encoderType: 'pcm-wav'
    };
  }

  /**
   * Encoder modunu dondur
   * @returns {string|null}
   */
  getEncoderMode() {
    return this._encoderMode;
  }
}
