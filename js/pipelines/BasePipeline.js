/**
 * BasePipeline - Pipeline Strategy Interface
 * OCP: Yeni pipeline eklemek icin bu class'i extend et
 * DRY: Ortak Opus worker ve MuteGain islemleri burada
 *
 * Her pipeline:
 * - setup(): WebAudio graph'i kur
 * - cleanup(): Kaynaklari temizle
 * - getNodes(): Olusturulan node'lari dondur
 */
import eventBus from '../modules/EventBus.js';
import { createOpusWorker, isWasmOpusSupported } from '../modules/OpusWorkerHelper.js';
import { disconnectNodes, log, createAnalyserNode } from '../modules/utils.js';
import { EVENTS } from '../modules/constants.js';

export default class BasePipeline {
  constructor(audioContext, sourceNode, destinationNode) {
    this.audioContext = audioContext;
    this.sourceNode = sourceNode;
    this.destinationNode = destinationNode;

    // Alt class'lar bu node'lari dolduracak
    this.nodes = {
      processor: null,  // ScriptProcessor veya Worklet
      mute: null,       // WASM Opus icin mute GainNode
      worklet: null     // AudioWorkletNode
    };

    // VU Meter icin AnalyserNode (fan-out pattern)
    this.analyserNode = null;

    // WASM Opus encoder (ScriptProcessor ve Worklet icin)
    this.opusWorker = null;
  }

  /**
   * VU Meter icin AnalyserNode olustur
   * @returns {AnalyserNode}
   */
  createAnalyser() {
    this.analyserNode = createAnalyserNode(this.audioContext);
    return this.analyserNode;
  }

  /**
   * Pipeline'i kur
   * @param {Object} options - Pipeline options (bufferSize, encoder, etc.)
   * @returns {Promise<void>}
   */
  async setup(options = {}) {
    throw new Error('BasePipeline.setup() must be implemented by subclass');
  }

  /**
   * Pipeline'i temizle
   * @returns {Promise<void>}
   */
  async cleanup() {
    // ScriptProcessor onaudioprocess temizligi (disconnect oncesi)
    if (this.nodes.processor?.onaudioprocess) {
      this.nodes.processor.onaudioprocess = null;
    }

    // DRY: disconnectNodes helper ile tum node'lari temizle
    disconnectNodes([
      ...Object.values(this.nodes),
      this.analyserNode
    ]);

    this.analyserNode = null;
    this.nodes = { processor: null, mute: null, worklet: null };
  }

  /**
   * Olusturulan node'lari dondur
   * @returns {Object} - { processor, mute, worklet }
   */
  getNodes() {
    return { ...this.nodes };
  }

  /**
   * Pipeline tipi (subclass override etmeli)
   * @returns {string}
   */
  get type() {
    return 'base';
  }

  /**
   * Log helper (pipeline subclass'lari icin)
   */
  log(message, details = {}) {
    log.webaudio(message, details);
  }

  // ═══════════════════════════════════════════════════════════════
  // DRY: Ortak Opus Worker Metodlari (ScriptProcessor & Worklet icin)
  // ═══════════════════════════════════════════════════════════════

  /**
   * WASM Opus worker'i olustur ve event handler'lari bagla
   * DRY: ScriptProcessor ve Worklet ayni kodu kullanir
   * @param {number} mediaBitrate - Hedef bitrate (0 ise VBR/default 16000)
   * @param {number} channels - Kanal sayisi (1=Mono, 2=Stereo, default: 1)
   * @returns {Promise<number>} - Kullanilan bitrate
   */
  async _initOpusWorker(mediaBitrate = 0, channels = 1) {
    if (!isWasmOpusSupported()) {
      throw new Error('WASM Opus desteklenmiyor');
    }

    // VBR destegi: mediaBitrate === 0 ise VBR (opus-recorder varsayilani kullanir)
    // mediaBitrate > 0 ise CBR (sabit bitrate)
    const opusBitrate = mediaBitrate === 0 ? undefined : (mediaBitrate || 16000);
    this.opusWorker = await createOpusWorker({
      sampleRate: this.audioContext.sampleRate,
      channels: channels,
      bitrate: opusBitrate
    });

    this.opusWorker.onProgress = (progress) => {
      eventBus.emit(EVENTS.OPUS_PROGRESS, progress);
    };

    this.opusWorker.onError = (error) => {
      log.error(`Opus encoder hatasi (${this.type})`, { error: error.message });
    };

    return opusBitrate;
  }

  /**
   * Opus worker'i dondur (Recorder.js stop() icin)
   * @returns {Object|null}
   */
  getOpusWorker() {
    return this.opusWorker;
  }

  /**
   * Opus encoding'i bitir ve blob dondur
   * Alt class'lar override edebilir (WorkletPipeline accumulator icin)
   * @returns {Promise<Object>} - { blob, pageCount, encoderType }
   */
  async finishOpusEncoding() {
    if (!this.opusWorker) {
      throw new Error('Opus worker mevcut degil');
    }
    return await this.opusWorker.finish();
  }

  /**
   * Opus worker'i temizle
   * @protected
   */
  _cleanupOpusWorker() {
    if (this.opusWorker) {
      this.opusWorker.terminate();
      this.opusWorker = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // DRY: Ortak MuteGain Pattern (WASM Opus modunda ses cikisini engelle)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Mute GainNode olustur ve bagla
   * WASM Opus modunda ses cikisini engellemek icin kullanilir
   * @param {AudioNode} sourceNode - Baglanti kaynagi (processor veya worklet)
   */
  _createMuteGain(sourceNode) {
    this.nodes.mute = this.audioContext.createGain();
    this.nodes.mute.gain.value = 0;
    sourceNode.connect(this.nodes.mute);
    this.nodes.mute.connect(this.audioContext.destination);
  }
}
