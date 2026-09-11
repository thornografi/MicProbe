/**
 * ScriptProcessorPipeline - ScriptProcessorNode ile audio isleme
 * OCP: Yeni pipeline eklemek icin BasePipeline'i extend et
 * DRY: Opus worker islemleri BasePipeline'dan miras alinir
 *
 * NOT: Bu pipeline SADECE WASM Opus encoder ile kullanılır
 * MediaRecorder passthrough desteği kaldırıldı (ölü kod idi)
 *
 * Graph:
 *   Source -> ScriptProcessor -> MuteGain -> AudioContext.destination
 *   (PCM data onaudioprocess ile worker'a gonderilir)
 */
import BasePipeline from './BasePipeline.js';
import { BUFFER } from '../modules/constants.js';

export default class ScriptProcessorPipeline extends BasePipeline {
  get type() {
    return 'scriptprocessor';
  }

  /**
   * ScriptProcessor pipeline kur
   * NOT: Bu pipeline SADECE WASM Opus encoder ile kullanılır
   * MediaRecorder passthrough desteği kaldırıldı (ölü kod idi)
   * @param {Object} options - { bufferSize, mediaBitrate, channels }
   */
  async setup(options = {}) {
    const {
      bufferSize = BUFFER.DEFAULT_SIZE,
      mediaBitrate = 0,
      channels = 1
    } = options;
    this._channels = channels;

    // ScriptProcessor olustur
    this.nodes.processor = this.audioContext.createScriptProcessor(bufferSize, this._channels, this._channels);

    // WASM Opus encoder kurulumu (tek mod)
    await this._setupWasmOpus(bufferSize, mediaBitrate, options.signal);
  }

  /**
   * WASM Opus encoder kurulumu
   * DRY: Opus worker BasePipeline._initOpusWorker() ile olusturulur
   */
  async _setupWasmOpus(bufferSize, mediaBitrate, signal) {
    // DRY: Ortak Opus worker kurulumu (channels parametresi eklendi)
    const opusBitrate = await this._initOpusWorker(mediaBitrate, this._channels, 2048, signal);

    // ScriptProcessor -> Opus Worker (PCM gonder)
    this.nodes.processor.onaudioprocess = (e) => {
      // Guard: cleanup sonrasi veya worker yok ise event'leri yoksay
      if (!this.isCapturing || !this.opusWorker || !this.nodes.processor) {
        return;
      }
      try {
        const channels = Array.from({ length: this._channels }, (_, channel) =>
          e.inputBuffer.getChannelData(channel).slice());
        this.opusWorker.encode(channels);
        this.capturedFrames += channels[0].length;
        channels.forEach((pcm, channel) => e.outputBuffer.getChannelData(channel).set(pcm));
      } catch (error) {
        this.onCaptureError?.(error);
      }
    };

    // VU Meter icin AnalyserNode olustur
    this.createAnalyser();

    // Frekans analizi icin yuksek cozunurluklu analyser
    this.createAnalysisAnalyser(this.nodes.processor);

    this.sourceNode.connect(this.nodes.processor);

    // Fan-out: Processor cikisindan VU Meter'a
    this.nodes.processor.connect(this.analyserNode);

    // DRY: Ortak MuteGain pattern
    this._createMuteGain(this.nodes.processor);

    this.log('ScriptProcessor + WASM Opus graph connected (fan-out)', {
      graph: 'Source -> Processor -> [AnalyserNode (VU) + AnalyserNode (Analysis) + MuteGain -> Destination]',
      bufferSize,
      bitrate: opusBitrate,
      encoderType: this.opusWorker.encoderType
    });
  }

  /**
   * Temizlik - Opus worker dahil
   * DRY: Opus cleanup BasePipeline._cleanupOpusWorker() ile yapilir
   */
  async cleanup() {
    // Audio event handler'i temizle (race condition onlemi)
    if (this.nodes.processor) {
      this.nodes.processor.onaudioprocess = null;
    }

    // DRY: Ortak Opus worker temizligi
    this._cleanupOpusWorker();

    await super.cleanup();
    this.log('ScriptProcessor pipeline cleanup complete');
  }
}
