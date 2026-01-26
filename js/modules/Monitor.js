/**
 * Monitor - Canli mikrofon dinleme
 * OCP: Farkli monitor modlari eklenebilir (WebAudio, ScriptProcessor)
 * DRY: Template Method Pattern ile ortak islemler tek yerde
 */
import eventBus from './EventBus.js';
import { requestStream } from './StreamHelper.js';
import { createPassthroughWorkletNode, ensurePassthroughWorklet } from './WorkletHelper.js';
import { createAudioContext, stopStreamTracks, disconnectNodes, log } from './utils.js';
import { DELAY, BUFFER, AUDIO } from './constants.js';

class Monitor {
  constructor() {
    this.stream = null;
    this.audioContext = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.workletNode = null;
    this.delayNode = null;
    this.analyserNode = null; // VU Meter icin (fan-out pattern)
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
    // DRY: BasePipeline.createAnalyser() ile ayni constants kullaniliyor
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = AUDIO.FFT_SIZE;
    this.analyserNode.smoothingTimeConstant = AUDIO.SMOOTHING_TIME_CONSTANT;

    // Fan-out: sourceNode -> analyser (VU icin)
    sourceNode.connect(this.analyserNode);

    // VU Meter'a bildir
    eventBus.emit('pipeline:analyserReady', this.analyserNode);

    log.webaudio(`AnalyserNode olusturuldu${mode ? ` (${mode})` : ''}`, {
      fftSize: this.analyserNode.fftSize,
      purpose: 'VU Meter (encode oncesi sinyal)'
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

    log.webaudio(`DelayNode olusturuldu${mode ? ` (${mode})` : ''}`, {
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
    log.webaudio(`AudioContext olusturuluyor (${modeName})`, { api: 'createAudioContext()' });

    this.audioContext = await createAudioContext();

    log.webaudio('AudioContext olusturuldu', {
      state: this.audioContext.state,
      sampleRate: this.audioContext.sampleRate,
      baseLatency: this.audioContext.baseLatency
    });

    // Source node olustur
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);

    log.webaudio('MediaStreamAudioSourceNode olusturuldu', { channelCount: this.sourceNode.channelCount });
  }

  /**
   * Template Method: Ortak monitor basarili baslama event'leri
   * @param {string} mode - Monitor modu
   * @param {string} logMessage - Kullanici log mesaji
   */
  _emitMonitorStarted(mode, logMessage) {
    this.isMonitoring = true;
    this.mode = mode;

    eventBus.emit('stream:started', this.stream);
    log.stream(logMessage);
    eventBus.emit('monitor:started', { mode: this.mode, delaySeconds: this.delayNode?.delayTime?.value ?? DELAY.DEFAULT_SECONDS });
  }

  /**
   * Template Method: Ortak monitor hata yonetimi
   * @param {Error} err - Hata
   * @param {string} modeName - Mod adi
   */
  _handleMonitorError(err, modeName) {
    log.error(`${modeName} Monitor hatasi`, { error: err.message, stack: err.stack });
    eventBus.emit('monitor:error', err);
    throw err;
  }

  // ═══════════════════════════════════════════════════════════════
  // Monitor Modlari
  // ═══════════════════════════════════════════════════════════════

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

      log.webaudio('WebAudio grafigi tamamlandi', {
        graph: `MediaStream -> Source -> [AnalyserNode (VU) + DelayNode(${this.delayNode.delayTime.value}s)] -> Destination`,
        finalState: this.audioContext.state
      });

      this._emitMonitorStarted('standard',
        `MONITOR basladi (WebAudio -> ${this.delayNode.delayTime.value.toFixed(1)}s Delay -> Speaker)`);

    } catch (err) {
      this._handleMonitorError(err, 'WebAudio');
    }
  }

  async startScriptProcessor(constraints, bufferSize = BUFFER.DEFAULT_SIZE) {
    if (this.isMonitoring) return;

    try {
      await this._initMonitorCommon(constraints, 'ScriptProcessor');

      const channelCount = Math.min(2, this.sourceNode.channelCount || 1);

      log.webaudio('ScriptProcessorNode olusturuluyor (DEPRECATED API)', {
        api: `ac.createScriptProcessor(${bufferSize}, ${channelCount}, ${channelCount})`,
        warning: 'Bu API deprecated, AudioWorklet kullanilmali',
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

      log.webaudio('ScriptProcessorNode olusturuldu', {
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

      log.webaudio('WebAudio grafigi tamamlandi (ScriptProcessor)', {
        graph: `MediaStream -> Source -> ScriptProcessor -> [AnalyserNode (VU) + DelayNode(${this.delayNode.delayTime.value}s)] -> Destination`,
        finalState: this.audioContext.state
      });

      this._emitMonitorStarted('scriptprocessor',
        `WEBAUDIO monitor basladi (ScriptProcessor ${bufferSize} -> ${this.delayNode.delayTime.value.toFixed(1)}s Delay -> Speaker)`);
      log.webaudio(`SampleRate: ${this.audioContext.sampleRate}Hz, State: ${this.audioContext.state}`);

    } catch (err) {
      this._handleMonitorError(err, 'ScriptProcessor');
    }
  }

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

      log.webaudio('WebAudio grafigi tamamlandi (AudioWorklet)', {
        graph: `MediaStream -> Source -> AudioWorklet -> [AnalyserNode (VU) + DelayNode(${this.delayNode.delayTime.value}s)] -> Destination`,
        finalState: this.audioContext.state
      });

      this._emitMonitorStarted('worklet',
        `WEBAUDIO monitor basladi (AudioWorklet -> ${this.delayNode.delayTime.value.toFixed(1)}s Delay -> Speaker)`);
      log.webaudio(`SampleRate: ${this.audioContext.sampleRate}Hz, State: ${this.audioContext.state}`);

    } catch (err) {
      this._handleMonitorError(err, 'AudioWorklet');
    }
  }

  /**
   * Direct Mode - Basit WebAudio pipeline ile monitor (DelayNode ile)
   * WebAudio toggle kapaliyken kullanilir, sadece delay uygulanir
   */
  async startDirect(constraints) {
    if (this.isMonitoring) return;

    try {
      log.stream('Direct monitor baslatiliyor (Delay ile)', {
        mode: 'direct',
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

      this._emitMonitorStarted('direct',
        `MONITOR basladi (Direct -> ${this.delayNode.delayTime.value.toFixed(1)}s Delay -> Speaker)`);

    } catch (err) {
      this._handleMonitorError(err, 'Direct');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Stop & Cleanup (DRY refactored)
  // ═══════════════════════════════════════════════════════════════

  async stop() {
    if (!this.isMonitoring) return;

    log.webaudio('Monitor durduruluyor', { mode: this.mode });

    // ScriptProcessor onaudioprocess temizle (disconnect oncesi)
    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
    }

    // DRY: disconnectNodes helper ile tum node'lari temizle (logEach: true)
    disconnectNodes([
      { node: this.processorNode, name: 'ScriptProcessorNode' },
      { node: this.workletNode, name: 'AudioWorkletNode' },
      { node: this.analyserNode, name: 'AnalyserNode' },
      { node: this.delayNode, name: 'DelayNode' },
      { node: this.sourceNode, name: 'MediaStreamAudioSourceNode' }
    ], true);

    // Node referanslarini temizle
    this.processorNode = null;
    this.workletNode = null;
    this.analyserNode = null;
    this.delayNode = null;
    this.sourceNode = null;

    // AudioContext kapat
    if (this.audioContext) {
      const prevState = this.audioContext.state;
      await this.audioContext.close();
      log.webaudio('AudioContext kapatildi', { previousState: prevState, newState: 'closed' });
      this.audioContext = null;
    }

    // Stream durdur
    if (this.stream) {
      stopStreamTracks(this.stream);
      log.stream('MediaStream track\'leri durduruldu', {});
      this.stream = null;
    }

    const stoppedMode = this.mode;
    this.isMonitoring = false;
    this.mode = null;

    eventBus.emit('stream:stopped');
    log.stream(`${stoppedMode === 'scriptprocessor' || stoppedMode === 'worklet' ? 'WEBAUDIO' : 'MONITOR'} durduruldu`);
    eventBus.emit('monitor:stopped', { mode: stoppedMode });
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
