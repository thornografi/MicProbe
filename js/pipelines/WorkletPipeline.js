/**
 * WorkletPipeline - AudioWorkletNode ile modern audio isleme
 * OCP: Yeni pipeline eklemek icin BasePipeline'i extend et
 * DRY: Opus worker islemleri BasePipeline'dan miras alinir
 *
 * Graph:
 *   Source -> AudioWorklet -> MuteGain -> AudioContext.destination
 *   (PCM data port uzerinden main thread'e, accumulator ile Opus worker'a)
 *
 * Desteklenen encoder'lar:
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
import { OPUS } from '../modules/constants.js';
import { createWavBlob, log } from '../modules/utils.js';

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
    if (encoder === 'pcm-wav') {
      await this._setupPcmWav();
    } else {
      // WASM Opus encoder kurulumu (varsayilan)
      await this._setupWasmOpus(mediaBitrate);
    }
  }

  /**
   * PCM/WAV encoder kurulumu (raw recording)
   * Float32 PCM data biriktirip WAV blob olusturur
   */
  async _setupPcmWav() {
    this._pcmChunks = [];

    // Worklet'e PCM gonderimini ac
    this.nodes.worklet.port.postMessage({ command: 'enablePcm' });

    // Worklet'ten gelen PCM data'yi biriktir
    this.nodes.worklet.port.onmessage = (e) => {
      if (e.data.error) {
        log.error('AudioWorklet hatasi (PCM/WAV)', { error: e.data.error });
        return;
      }
      if (e.data.pcm) {
        // Float32Array kopyasini sakla
        this._pcmChunks.push(new Float32Array(e.data.pcm));
      }
    };

    // VU Meter icin AnalyserNode olustur
    this.createAnalyser();

    // Graph kur: Source -> Worklet -> MuteGain -> destination
    this.sourceNode.connect(this.nodes.worklet);

    // Fan-out: Worklet cikisindan VU Meter'a
    this.nodes.worklet.connect(this.analyserNode);

    // DRY: Ortak MuteGain pattern
    this._createMuteGain(this.nodes.worklet);

    this.log('AudioWorklet + PCM/WAV grafigi baglandi', {
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
  async _setupWasmOpus(mediaBitrate) {
    // DRY: Ortak Opus worker kurulumu (channels parametresi eklendi)
    const opusBitrate = await this._initOpusWorker(mediaBitrate, this._channels);

    // Accumulator buffer olustur (128 sample -> 960 sample biriktir)
    this.accumulator = new Float32Array(OPUS.FRAME_SIZE);
    this.accumulatorIndex = 0;

    // Worklet'e PCM gonderimini ac
    this.nodes.worklet.port.postMessage({ command: 'enablePcm' });

    // Worklet'ten gelen PCM data'yi dinle + error handler
    this.nodes.worklet.port.onmessage = (e) => {
      // Worklet'ten gelen hata mesajlarini yakala
      if (e.data.error) {
        log.error('AudioWorklet hatasi', { error: e.data.error });
        return;
      }
      if (e.data.pcm) {
        this._accumulateAndEncode(e.data.pcm);
      }
    };

    // VU Meter icin AnalyserNode olustur
    this.createAnalyser();

    // Graph kur: Source -> Worklet -> MuteGain -> destination
    this.sourceNode.connect(this.nodes.worklet);

    // Fan-out: Worklet cikisindan VU Meter'a
    this.nodes.worklet.connect(this.analyserNode);

    // DRY: Ortak MuteGain pattern
    this._createMuteGain(this.nodes.worklet);

    this.log('AudioWorklet + WASM Opus grafigi baglandi (fan-out)', {
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
      log.error('WASM Opus encode hatasi', { error: err.message, stack: err.stack });
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
    this.log('AudioWorklet pipeline cleanup tamamlandi');
  }

  /**
   * Opus encoding'i bitir ve blob dondur
   * Override: Accumulator'daki kalan veriyi gonder
   */
  async finishOpusEncoding() {
    if (!this.opusWorker) {
      throw new Error('Opus worker mevcut degil');
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
  finishPcmWavEncoding() {
    if (this._encoderMode !== 'pcm-wav') {
      throw new Error('PCM/WAV modu aktif degil');
    }

    const totalSamples = this._pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const blob = createWavBlob(this._pcmChunks, this.audioContext.sampleRate, this._channels);

    this.log('PCM/WAV encoding tamamlandi', {
      sampleCount: totalSamples,
      chunkCount: this._pcmChunks.length,
      blobSize: blob.size,
      sampleRate: this.audioContext.sampleRate
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
