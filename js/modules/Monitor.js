/**
 * Monitor - Canli mikrofon dinleme
 * OCP: Farkli monitor modlari eklenebilir (WebAudio, ScriptProcessor)
 * DRY: Template Method Pattern ile ortak islemler tek yerde
 */
import eventBus from './EventBus.js';
import { requestStream } from './StreamHelper.js';
import { createPassthroughWorkletNode, ensurePassthroughWorklet } from './WorkletHelper.js';
import { createAudioContext, getAudioContextOptions, stopStreamTracks, disconnectNodes, log, createAnalyserNode, createAnalysisAnalyserNode } from './utils.js';
import { DELAY, BUFFER, PIPELINE_TYPES, EVENTS } from './constants.js';

// OCP: Yeni monitor modu eklemek icin sadece buraya satir ekle
const MONITOR_DISPATCH = {
  [PIPELINE_TYPES.DIRECT]: 'startDirect',
  [PIPELINE_TYPES.STANDARD]: 'startWebAudio',
  [PIPELINE_TYPES.SCRIPTPROCESSOR]: 'startScriptProcessor',
  [PIPELINE_TYPES.WORKLET]: 'startAudioWorklet',
};

class Monitor {
  constructor() {
    this.stream = null;
    this.audioContext = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.workletNode = null;
    this.delayNode = null;
    this.analyserNode = null; // VU Meter icin (fan-out pattern)
    this.analysisAnalyserNode = null; // Frekans analizi icin (yuksek FFT)
    this.isMonitoring = false;
    this.mode = null; // 'standard', 'scriptprocessor', 'worklet', 'direct'
  }

  // ═══════════════════════════════════════════════════════════════
  // DRY Helper Metodlar
  // ═══════════════════════════════════════════════════════════════

  /**
   * AnalyserNode olusturur ve VU Meter event'i emit eder (DRY helper)
   * @param {AudioNode} sourceNode - Analyser'a baglanacak node
   * @param {string} mode - Log icin mod adi
   * @returns {AnalyserNode}
   */
  _createAnalyser(sourceNode, mode = '') {
    // DRY: createAnalyserNode factory kullan
    this.analyserNode = createAnalyserNode(this.audioContext);

    // Fan-out: sourceNode -> analyser (VU icin)
    sourceNode.connect(this.analyserNode);

    // VU Meter'a bildir
    eventBus.emit(EVENTS.PIPELINE_ANALYSER_READY, this.analyserNode);

    // Frekans analizi icin yuksek cozunurluklu analyser (ayni source, fan-out)
    this.analysisAnalyserNode = createAnalysisAnalyserNode(this.audioContext);
    sourceNode.connect(this.analysisAnalyserNode);
    eventBus.emit(EVENTS.PIPELINE_ANALYSIS_ANALYSER_READY, this.analysisAnalyserNode);

    log.webaudio(`AnalyserNodes created${mode ? ` (${mode})` : ''}`, {
      vuFftSize: this.analyserNode.fftSize,
      analysisFftSize: this.analysisAnalyserNode.fftSize,
      purpose: 'VU Meter + Frekans Analizi'
    });

    return this.analyserNode;
  }

  /**
   * DelayNode olusturur (DRY helper - feedback/echo onleme)
   * @param {string} mode - Log icin mod adi
   * @returns {DelayNode}
   */
  _createDelayNode(mode = '') {
    this.delayNode = this.audioContext.createDelay(DELAY.MAX_SECONDS);
    this.delayNode.delayTime.value = DELAY.DEFAULT_SECONDS;

    log.webaudio(`DelayNode created${mode ? ` (${mode})` : ''}`, {
      delayTime: this.delayNode.delayTime.value + ' saniye',
      maxDelayTime: DELAY.MAX_SECONDS + ' saniye',
      purpose: 'Echo/feedback onleme'
    });

    return this.delayNode;
  }


  // ═══════════════════════════════════════════════════════════════
  // Template Method: Ortak monitor baslama adimlari
  // ═══════════════════════════════════════════════════════════════

  /**
   * Template Method: Ortak monitor baslama adimlari
   * DRY: Tum start* metodlari bu ortak adimlari kullanir
   * @param {Object} constraints - getUserMedia constraints
   * @param {string} modeName - Log icin mod adi
   * @returns {Promise<void>}
   */
  async _initMonitorCommon(constraints, modeName) {
    // Stream al
    this.stream = await requestStream(constraints);

    // AudioContext olustur
    log.webaudio(`Creating AudioContext (${modeName})`, { api: 'createAudioContext()' });

    const acOptions = getAudioContextOptions(this.stream);
    this.audioContext = await createAudioContext(acOptions);

    log.webaudio('AudioContext created', {
      state: this.audioContext.state,
      sampleRate: this.audioContext.sampleRate,
      baseLatency: this.audioContext.baseLatency
    });

    // Source node olustur
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);

    log.webaudio('MediaStreamAudioSourceNode created', { channelCount: this.sourceNode.channelCount });
  }

  /**
   * Template Method: Ortak monitor basarili baslama event'leri
   * @param {string} mode - Monitor modu
   * @param {string} logMessage - Kullanici log mesaji
   */
  _emitMonitorStarted(mode, logMessage) {
    this.isMonitoring = true;
    this.mode = mode;

    eventBus.emit(EVENTS.STREAM_STARTED, this.stream);
    log.stream(logMessage);
    eventBus.emit(EVENTS.MONITOR_STARTED, { mode: this.mode, delaySeconds: this.delayNode?.delayTime?.value ?? DELAY.DEFAULT_SECONDS });
  }

  /**
   * Template Method: Ortak monitor hata yonetimi
   * @param {Error} err - Hata
   * @param {string} modeName - Mod adi
   */
  _handleMonitorError(err, modeName) {
    log.error(`${modeName} Monitor error`, { error: err.message, stack: err.stack });
    eventBus.emit(EVENTS.MONITOR_ERROR, err);
    throw err;
  }

  // ═══════════════════════════════════════════════════════════════
  // Monitor Modlari
  // ═══════════════════════════════════════════════════════════════

  /**
   * @throws {Error} Stream alinamazsa veya AudioContext olusturulamazsa
   */
  async startWebAudio(constraints) {
    if (this.isMonitoring) return;

    try {
      await this._initMonitorCommon(constraints, 'Standard');

      // DelayNode olustur
      this._createDelayNode('Standard');

      // Baglanti: Source -> Delay -> Destination
      this.sourceNode.connect(this.delayNode);
      this.delayNode.connect(this.audioContext.destination);

      // VU Meter icin AnalyserNode (fan-out: Source -> Analyser)
      this._createAnalyser(this.sourceNode, 'Standard');

      log.webaudio('WebAudio graph complete', {
        graph: `MediaStream -> Source -> [AnalyserNode (VU) + DelayNode(${this.delayNode.delayTime.value}s)] -> Destination`,
        finalState: this.audioContext.state
      });

      this._emitMonitorStarted(PIPELINE_TYPES.STANDARD,
        `MONITOR started (WebAudio -> ${this.delayNode.delayTime.value.toFixed(1)}s Delay -> Speaker)`);

    } catch (err) {
      this._handleMonitorError(err, 'WebAudio');
    }
  }

  /**
   * @throws {Error} Stream alinamazsa veya ScriptProcessorNode olusturulamazsa
   */
  async startScriptProcessor(constraints, bufferSize = BUFFER.DEFAULT_SIZE) {
    if (this.isMonitoring) return;

    try {
      await this._initMonitorCommon(constraints, 'ScriptProcessor');

      const channelCount = Math.min(2, this.sourceNode.channelCount || 1);

      log.webaudio('Creating ScriptProcessorNode (DEPRECATED API - kept for legacy profile simulation)', {
        api: `ac.createScriptProcessor(${bufferSize}, ${channelCount}, ${channelCount})`,
        warning: 'Bu API deprecated. Eski web kayit sitelerini simule etmek icin korunuyor.',
        bufferSize,
        inputChannels: channelCount,
        outputChannels: channelCount
      });

      this.processorNode = this.audioContext.createScriptProcessor(bufferSize, channelCount, channelCount);
      this.processorNode.onaudioprocess = (e) => {
        const inputBuffer = e.inputBuffer;
        const outputBuffer = e.outputBuffer;
        const channels = Math.min(inputBuffer.numberOfChannels, outputBuffer.numberOfChannels);

        for (let ch = 0; ch < channels; ch++) {
          const input = inputBuffer.getChannelData(ch);
          const output = outputBuffer.getChannelData(ch);
          output.set(input);
        }
      };

      log.webaudio('ScriptProcessorNode created', {
        bufferSize: this.processorNode.bufferSize,
        numberOfInputs: this.processorNode.numberOfInputs,
        numberOfOutputs: this.processorNode.numberOfOutputs
      });

      // Baglantilari yap
      this.sourceNode.connect(this.processorNode);

      // DelayNode olustur
      this._createDelayNode('ScriptProcessor');

      this.processorNode.connect(this.delayNode);
      this.delayNode.connect(this.audioContext.destination);

      // VU Meter icin AnalyserNode (fan-out: Processor -> Analyser)
      this._createAnalyser(this.processorNode, 'ScriptProcessor');

      log.webaudio('WebAudio graph complete (ScriptProcessor)', {
        graph: `MediaStream -> Source -> ScriptProcessor -> [AnalyserNode (VU) + DelayNode(${this.delayNode.delayTime.value}s)] -> Destination`,
        finalState: this.audioContext.state
      });

      this._emitMonitorStarted(PIPELINE_TYPES.SCRIPTPROCESSOR,
        `WEBAUDIO monitor started (ScriptProcessor ${bufferSize} -> ${this.delayNode.delayTime.value.toFixed(1)}s Delay -> Speaker)`);
      log.webaudio(`SampleRate: ${this.audioContext.sampleRate}Hz, State: ${this.audioContext.state}`);

    } catch (err) {
      this._handleMonitorError(err, 'ScriptProcessor');
    }
  }

  /**
   * @throws {Error} Stream alinamazsa veya AudioWorklet yuklenemezse
   */
  async startAudioWorklet(constraints) {
    if (this.isMonitoring) return;

    try {
      await this._initMonitorCommon(constraints, 'AudioWorklet');

      await ensurePassthroughWorklet(this.audioContext);
      this.workletNode = createPassthroughWorkletNode(this.audioContext);

      // DelayNode olustur
      this._createDelayNode('AudioWorklet');

      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.delayNode);
      this.delayNode.connect(this.audioContext.destination);

      // VU Meter icin AnalyserNode (fan-out: Worklet -> Analyser)
      this._createAnalyser(this.workletNode, 'AudioWorklet');

      log.webaudio('WebAudio graph complete (AudioWorklet)', {
        graph: `MediaStream -> Source -> AudioWorklet -> [AnalyserNode (VU) + DelayNode(${this.delayNode.delayTime.value}s)] -> Destination`,
        finalState: this.audioContext.state
      });

      this._emitMonitorStarted(PIPELINE_TYPES.WORKLET,
        `WEBAUDIO monitor started (AudioWorklet -> ${this.delayNode.delayTime.value.toFixed(1)}s Delay -> Speaker)`);
      log.webaudio(`SampleRate: ${this.audioContext.sampleRate}Hz, State: ${this.audioContext.state}`);

    } catch (err) {
      this._handleMonitorError(err, 'AudioWorklet');
    }
  }

  /**
   * Direct Mode - Basit WebAudio pipeline ile monitor (DelayNode ile)
   * WebAudio toggle kapaliyken kullanilir, sadece delay uygulanir
   * @throws {Error} Stream alinamazsa veya AudioContext olusturulamazsa
   */
  async startDirect(constraints) {
    if (this.isMonitoring) return;

    try {
      log.stream('Direct monitor starting (with Delay)', {
        mode: PIPELINE_TYPES.DIRECT,
        pipeline: 'MediaStream -> DelayNode -> Speaker'
      });

      await this._initMonitorCommon(constraints, 'Direct');

      // DelayNode olustur
      this._createDelayNode('Direct');

      // Baglanti: Source -> Delay -> Destination
      this.sourceNode.connect(this.delayNode);
      this.delayNode.connect(this.audioContext.destination);

      // VU Meter icin AnalyserNode (fan-out: Source -> Analyser)
      this._createAnalyser(this.sourceNode, 'Direct');

      this._emitMonitorStarted(PIPELINE_TYPES.DIRECT,
        `MONITOR started (Direct -> ${this.delayNode.delayTime.value.toFixed(1)}s Delay -> Speaker)`);

    } catch (err) {
      this._handleMonitorError(err, 'Direct');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Stop & Cleanup (DRY refactored)
  // ═══════════════════════════════════════════════════════════════

  async stop() {
    if (!this.isMonitoring) return;

    log.webaudio('Monitor stopping', { mode: this.mode });

    // ScriptProcessor onaudioprocess temizle (disconnect oncesi)
    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
    }

    // DRY: disconnectNodes helper ile tum node'lari temizle (logEach: true)
    disconnectNodes([
      { node: this.processorNode, name: 'ScriptProcessorNode' },
      { node: this.workletNode, name: 'AudioWorkletNode' },
      { node: this.analyserNode, name: 'AnalyserNode (VU)' },
      { node: this.analysisAnalyserNode, name: 'AnalyserNode (Analysis)' },
      { node: this.delayNode, name: 'DelayNode' },
      { node: this.sourceNode, name: 'MediaStreamAudioSourceNode' }
    ], true);

    // Node referanslarini temizle
    this.processorNode = null;
    this.workletNode = null;
    this.analyserNode = null;
    this.analysisAnalyserNode = null;
    this.delayNode = null;
    this.sourceNode = null;

    // AudioContext kapat
    if (this.audioContext) {
      const prevState = this.audioContext.state;
      await this.audioContext.close();
      log.webaudio('AudioContext closed', { previousState: prevState, newState: 'closed' });
      this.audioContext = null;
    }

    // Stream durdur
    if (this.stream) {
      stopStreamTracks(this.stream);
      log.stream('MediaStream tracks stopped', {});
      this.stream = null;
    }

    const stoppedMode = this.mode;
    this.isMonitoring = false;
    this.mode = null;

    eventBus.emit(EVENTS.STREAM_STOPPED);
    log.stream(`${stoppedMode === PIPELINE_TYPES.SCRIPTPROCESSOR || stoppedMode === PIPELINE_TYPES.WORKLET ? 'WEBAUDIO' : 'MONITOR'} stopped`);
    eventBus.emit(EVENTS.MONITOR_STOPPED, { mode: stoppedMode });
  }

  // ═══════════════════════════════════════════════════════════════
  // Unified Start (OCP dispatch)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Pipeline tipine gore dogru monitor metodunu calistirir.
   * MonitoringController bu metodu kullanir — if/else zinciri yerine.
   * @param {string} type - PIPELINE_TYPES sabiti
   * @param {Object} constraints - getUserMedia constraints
   * @param {Object} [options] - Ek secenekler (bufferSize vb.)
   * @throws {Error} Stream alinamazsa veya AudioContext/pipeline olusturulamazsa
   */
  async start(type, constraints, options = {}) {
    const method = MONITOR_DISPATCH[type];
    if (!method) {
      log.warning(`Bilinmeyen monitor tipi: ${type}, WebAudio kullanilacak`);
      return this.startWebAudio(constraints);
    }
    return this[method](constraints, options.bufferSize);
  }

  // ═══════════════════════════════════════════════════════════════
  // Getter Metodlari
  // ═══════════════════════════════════════════════════════════════

  getIsMonitoring() {
    return this.isMonitoring;
  }

  getMode() {
    return this.mode;
  }

  // Debug: Mevcut WebAudio durumunu al
  getWebAudioState() {
    return {
      hasAudioContext: !!this.audioContext,
      state: this.audioContext?.state,
      sampleRate: this.audioContext?.sampleRate,
      currentTime: this.audioContext?.currentTime,
      delayTime: this.delayNode?.delayTime?.value || 0,
      isMonitoring: this.isMonitoring,
      mode: this.mode
    };
  }
}

export default Monitor;
