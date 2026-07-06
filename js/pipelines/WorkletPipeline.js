/**
 * WorkletPipeline - AudioWorkletNode ile modern audio isleme
 * OCP: Yeni pipeline eklemek icin BasePipeline'i extend et
 * DRY: Opus worker islemleri BasePipeline'dan miras alinir
 *
 * Graph (encoder'a gore degisir):
 *   MediaRecorder: Source -> AudioWorklet -> AnalyserNode (VU) + Worklet -> Destination
 *   WASM Opus:     Source -> AudioWorklet -> AnalyserNode (VU) + MuteGain -> destination (feedback onleme)
 *   PCM/WAV:       Source -> AudioWorklet -> AnalyserNode (VU) (destination baglantisi yok)
 *
 * Desteklenen encoder'lar:
 * - mediarecorder: Tarayici MediaRecorder API (standard WebM/Opus)
 * - wasm-opus: WASM Opus encoder (WhatsApp/Telegram pattern)
 * - pcm-wav: Raw PCM 16-bit WAV (sifir compression)
 *
 * AudioWorklet avantajlari:
 * - Sabit 128 sample buffer (dusuk latency)
 * - Main thread blocking yok
 * - Modern API (ScriptProcessor deprecated)
 */
import BasePipeline from './BasePipeline.js';
import { createPassthroughWorkletNode, ensurePassthroughWorklet } from '../modules/WorkletHelper.js';
import eventBus from '../modules/EventBus.js';
import { ENCODER_TYPES, OPUS } from '../modules/constants.js';
import { createWavBlob, log, usesMediaRecorder } from '../modules/utils.js';

export default class WorkletPipeline extends BasePipeline {
  constructor(audioContext, sourceNode, destinationNode) {
    super(audioContext, sourceNode, destinationNode);
    // Worklet-specific: 128 sample -> 960 sample biriktirme (Opus icin)
    this.accumulator = null;
    this.accumulatorIndex = 0;

    // PCM/WAV modu icin
    this._encoderMode = null; // 'wasm-opus' veya 'pcm-wav'
    this._pcmChunks = []; // PCM data biriktirme
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
    await ensurePassthroughWorklet(this.audioContext);

    // Passthrough worklet node olustur
    this.nodes.worklet = createPassthroughWorkletNode(this.audioContext);

    // Encoder moduna gore kurulum
    if (encoder === ENCODER_TYPES.PCM_WAV) {
      await this._setupPcmWav();
    } else if (usesMediaRecorder(encoder)) {
      // MediaRecorder encoder kurulumu
      this._setupMediaRecorderGraph();
    } else {
      // WASM Opus encoder kurulumu (varsayilan)
      await this._setupWasmOpus(mediaBitrate);
    }
  }

  /**
   * DRY: Ortak worklet graph kurulumu (PCM ve Opus icin)
   * enablePcm -> onmessage handler -> analyser -> source connect -> worklet connect
   */
  _setupWorkletGraph(onPcmData) {
    this.nodes.worklet.port.postMessage({ command: 'enablePcm' });
    this.nodes.worklet.port.onmessage = (e) => {
      if (e.data.error) {
        log.error('AudioWorklet error', { error: e.data.error });
        return;
      }
      if (e.data.pcmChannels) {
        onPcmData(e.data.pcmChannels);
      } else if (e.data.pcm) {
        onPcmData([new Float32Array(e.data.pcm)]);
      }
    };
    this.createAnalyser();
    this.createAnalysisAnalyser(this.nodes.worklet);
    this.sourceNode.connect(this.nodes.worklet);
    this.nodes.worklet.connect(this.analyserNode);
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
      log.error('WorkletPipeline: destinationNode required for MediaRecorder mode but not available');
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
      const interleaved = this._interleaveChannels(channels);
      if (interleaved.length > 0) {
        this._pcmChunks.push(interleaved);
      }
    });

    this.log('AudioWorklet + PCM/WAV graph connected', {
      graph: 'Source -> Worklet -> AnalyserNode (VU)',
      encoder: 'pcm-wav',
      sampleRate: this.audioContext.sampleRate,
      channels: this._channels
    });
  }

  /**
   * WASM Opus encoder kurulumu (accumulator pattern)
   * DRY: Opus worker BasePipeline._initOpusWorker() ile olusturulur
   */
  async _setupWasmOpus(mediaBitrate) {
    const opusBitrate = await this._initOpusWorker(mediaBitrate, this._channels);
    this.accumulator = new Float32Array(OPUS.FRAME_SIZE);
    this.accumulatorIndex = 0;

    this._setupWorkletGraph(channels => this._accumulateAndEncode(channels[0] || new Float32Array(0)));
    this._createMuteGain(this.nodes.worklet);

    this.log('AudioWorklet + WASM Opus graph connected (fan-out)', {
      graph: 'Source -> Worklet -> [AnalyserNode (VU) + MuteGain -> Destination]',
      frameSize: OPUS.FRAME_SIZE,
      bitrate: opusBitrate,
      encoderType: this.opusWorker.encoderType
    });
  }

  /**
   * 128 sample bloklari biriktirip 960 sample olunca Opus'a gonder
   */
  _accumulateAndEncode(pcmData) {
    // Guard: cleanup sonrasi gelen worklet mesajlarini yoksay
    if (!this.accumulator || !this.opusWorker) {
      return;
    }

    try {
      for (let i = 0; i < pcmData.length; i++) {
        this.accumulator[this.accumulatorIndex++] = pcmData[i];

        // Frame doldu, encode et
        if (this.accumulatorIndex >= OPUS.FRAME_SIZE) {
          this.opusWorker.encode(this.accumulator.slice(), false);
          this.accumulatorIndex = 0;
        }
      }
    } catch (err) {
      log.error('WASM Opus encode error', { error: err.message, stack: err.stack });
    }
  }

  /**
   * Temizlik - Opus worker ve PCM buffer dahil
   * DRY: Opus cleanup BasePipeline._cleanupOpusWorker() ile yapilir
   */
  async cleanup() {
    // Önce mesajı gönder, sonra handler'ı temizle (sıra önemli!)
    if (this.nodes.worklet) {
      this.nodes.worklet.port.postMessage({ command: 'disablePcm' });
      this.nodes.worklet.port.onmessage = null;
    }

    // DRY: Ortak Opus worker temizligi
    this._cleanupOpusWorker();

    // Accumulator temizle (Opus)
    this.accumulator = null;
    this.accumulatorIndex = 0;

    // PCM chunks temizle
    this._pcmChunks = [];
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

    // Kalan accumulator verisini gonder (padding ile)
    if (this.accumulatorIndex > 0) {
      // Kalan kismi sifirla (silence padding)
      for (let i = this.accumulatorIndex; i < OPUS.FRAME_SIZE; i++) {
        this.accumulator[i] = 0;
      }
      this.opusWorker.encode(this.accumulator.slice(), false);
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
      sampleCount: totalSamples,
      chunkCount: this._pcmChunks.length,
      blobSize: blob.size,
      sampleRate: this.audioContext.sampleRate,
      channels: this._channels
    });

    return {
      blob,
      sampleCount: totalSamples,
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
