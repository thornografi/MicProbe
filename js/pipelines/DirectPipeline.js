/**
 * DirectPipeline - WebAudio kullanmadan direkt stream
 * OCP: Yeni pipeline eklemek icin BasePipeline'i extend et
 *
 * Graph: (yok) - Stream direkt MediaRecorder'a gider
 * VU Meter icin disaridan gelen AudioContext kullanilir
 */
import BasePipeline from './BasePipeline.js';

export default class DirectPipeline extends BasePipeline {
  constructor(audioContext, sourceNode, destinationNode) {
    super(audioContext, sourceNode, destinationNode);
    // VU icin olusturulan source node (stream'den)
    this._vuSourceNode = null;
  }

  get type() {
    return 'direct';
  }

  /**
   * Direct mode'da WebAudio graph kurulmaz
   * Stream direkt kullanilir, VU Meter icin disaridan gelen AudioContext kullanilir
   * @param {Object} options - { stream } - VU Meter icin stream gerekli
   */
  async setup(options = {}) {
    const { stream } = options;

    // VU Meter icin disaridan gelen AudioContext kullan
    if (stream && this.audioContext) {
      this._vuSourceNode = this.audioContext.createMediaStreamSource(stream);

      // VU Meter icin AnalyserNode olustur
      this.createAnalyser();

      // Source -> Analyser (sadece VU icin, ses isleme yok)
      this._vuSourceNode.connect(this.analyserNode);

      // Frekans analizi icin yuksek cozunurluklu analyser
      this.createAnalysisAnalyser(this._vuSourceNode);

      this.log('Direct pipeline - VU + Analysis Analyser icin shared AudioContext', {
        graph: 'MicStream -> [AnalyserNode (VU) + AnalyserNode (Analysis)] + MediaRecorder (parallel)'
      });
    } else {
      this.log('Direct pipeline - WebAudio bypass (VU yok)', {
        graph: 'MicStream -> MediaRecorder (no WebAudio)'
      });
    }
  }

  /**
   * Temizlik - VU source node'u temizle (AudioContext disaridan geldiği için kapatilmaz)
   */
  async cleanup() {
    // VU icin olusturulan source node'u temizle
    if (this._vuSourceNode) {
      try {
        this._vuSourceNode.disconnect();
      } catch {
        // Zaten disconnect olmus olabilir
      }
      this._vuSourceNode = null;
    }

    await super.cleanup();
    this.log('Direct pipeline cleanup complete');
  }
}
