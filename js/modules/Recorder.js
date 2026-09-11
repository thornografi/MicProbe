/**
 * Recorder - Ses kaydi yonetimi
 * OCP: Pipeline Strategy Pattern ile farkli kayit modlari eklenebilir
 * MediaRecorder icin stream; WASM Opus ve PCM/WAV icin pipeline'dan PCM kullanir
 */
import eventBus from './EventBus.js';
import { requestStream } from './StreamHelper.js';
import { createAudioContext, getAudioContextOptions, stopStreamTracks, createMediaRecorder, getExtensionForMimeType, usesWebAudio, usesWasmOpus, usesMediaRecorder, usesPcmWav, getStreamErrorMessage, formatTimestampYYMMDDHHMMSS, calculateActualBitrate, disconnectNodes, log, bytesToKB, emitStreamWithAnalyser } from './utils.js';
import { BUFFER, ENCODER_TYPES, PIPELINE_TYPES, EVENTS } from './constants.js';
import { createPipeline, isPipelineSupported } from '../pipelines/PipelineFactory.js';
import { SETTINGS } from './Config.js';
import { createRunSnapshot, completeRunSnapshot } from './RunSnapshot.js';
import CaptureGuide from './CaptureGuide.js';
import { abortable } from './utils/async.js';

class Recorder {
  constructor(config = {}) {
    this.constraints = config.constraints || {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };

    this.stream = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.isRecording = false;

    // WebAudio components
    this.audioContext = null;
    this.sourceNode = null;
    this.destinationNode = null;

    // Pipeline Strategy (OCP: Strategy Pattern)
    this.pipelineStrategy = null;

    // Pipeline: WebAudio graph tipi (direct | standard | scriptprocessor | worklet)
    // Encoder: Kayit formati (mediarecorder | wasm-opus | pcm-wav)
    this.pipelineType = PIPELINE_TYPES.DIRECT;
    this.encoder = 'mediarecorder';
    this.startTime = null; // Kayit baslangic zamani (bitrate hesaplama icin)

    // Pre-warm state
    this.isWarmedUp = false;
    this._startPromise = null;
    this._stopPromise = null;
    this._streamStarted = false;
    this._trackEndedListeners = [];
  }

  /**
   * WebAudio modu icin AudioContext'i onceden olustur
   * Sayfa yuklenince cagrilabilir - Start aninda hiz kazandirir
   * NOT: destinationNode artık warmup'ta oluşturulmuyor
   * (WASM Opus modunda kullanılmıyor, MediaRecorder modunda start()'ta oluşturuluyor)
   */
  async warmup() {
    if (this.isWarmedUp || this.audioContext) {
      return;
    }

    try {
      // DRY: factory kullan
      const context = await createAudioContext();
      // A capture may have acquired its own context while warmup was pending.
      if (this.audioContext || this._startPromise || this._stopPromise) {
        await context.close();
        return;
      }
      this.audioContext = context;

      this.isWarmedUp = true;

      log.webaudio('Recorder: WebAudio warmup complete', {
        state: this.audioContext.state,
        sampleRate: this.audioContext.sampleRate
      });
    } catch (err) {
      log.error('Recorder: Warmup error', { error: err.message });
    }
  }

  /**
   * Kayit baslatir
   * @throws {Error} Stream alinamazsa veya pipeline olusturulamazsa
   */
  start(...args) {
    if (this._startPromise) return this._startPromise;
    if (this.isRecording) return Promise.resolve();
    const previousStop = this._stopPromise;
    this._stopPromise = null;
    this._cancelStart = false;
    this._startAbort = new AbortController();
    this._startPromise = (async () => {
      if (previousStop) await previousStop.catch(() => {});
      if (this._cancelStart) throw new Error('Recording start cancelled');
      return this._start(...args);
    })().finally(() => { this._startPromise = null; });
    return this._startPromise;
  }

  async _start(constraints = this.constraints, pipelineParam = PIPELINE_TYPES.DIRECT, encoderParam = 'mediarecorder', timeslice = 0, bufferSize = BUFFER.DEFAULT_SIZE, mediaBitrate = 0, runSnapshot = null) {
    const signal = this._startAbort.signal;
    this._recordingError = null;
    this.captureDurationMs = null;
    this.stopReason = null;
    this.runSnapshot = runSnapshot || createRunSnapshot({ requestedSettings: { ...constraints, pipeline: pipelineParam, encoder: encoderParam, mediaBitrate, timeslice, bufferSize } });
    this.captureGuide = new CaptureGuide(this.runSnapshot);
    this.guidedSegments = null;

    // Pipeline ve encoder validasyonu (OCP: PipelineFactory destekli kontrol)
    const allowedEncoders = new Set(['mediarecorder', 'wasm-opus', 'pcm-wav']);
    this.pipelineType = isPipelineSupported(pipelineParam) ? pipelineParam : PIPELINE_TYPES.DIRECT;
    this.encoder = allowedEncoders.has(encoderParam) ? encoderParam : 'mediarecorder';

    // PCM/WAV encoder sadece worklet pipeline ile calisir
    if (usesPcmWav(this.encoder) && this.pipelineType !== PIPELINE_TYPES.WORKLET) {
      log.warning('PCM/WAV encoder requires worklet pipeline, switching pipeline', { requestedPipeline: this.pipelineType, newPipeline: PIPELINE_TYPES.WORKLET });
      this.pipelineType = PIPELINE_TYPES.WORKLET;
    }
    if (usesWasmOpus(this.encoder) && ![PIPELINE_TYPES.SCRIPTPROCESSOR, PIPELINE_TYPES.WORKLET].includes(this.pipelineType)) {
      this.pipelineType = PIPELINE_TYPES.WORKLET;
    }
    if (this.pipelineType === PIPELINE_TYPES.SCRIPTPROCESSOR) this.encoder = ENCODER_TYPES.WASM_OPUS;
    this.timeslice = timeslice;
    this.mediaBitrate = mediaBitrate; // Hedef bitrate (MediaRecorder veya WASM Opus icin)

    try {
      this.stream = await requestStream(constraints, { signal });
      if (this._cancelStart) throw new Error('Recording start cancelled');
      this.chunks = [];

      // NOT: stream:started event'i pipeline kurulumundan SONRA emit edilir
      // Bu sayede VuMeter.start() yerine startWithAnalyser() kullanilir (gereksiz AudioEngine baglantisi onlenir)

      let recordStream = this.stream;

      // Pipeline ve encoder bazli kontroller (DRY: utils.js helper'lari)
      const needsWebAudioGraph = usesWebAudio(this.pipelineType);
      const needsMediaRecorder = usesMediaRecorder(this.encoder);

      // WebAudio graph'i MediaRecorder'a stream, WASM Opus/PCM-WAV encoder'larina PCM saglar
      if (needsWebAudioGraph) {
        log.webaudio('Kayit pipeline modu aktif', { pipeline: this.pipelineType, encoder: this.encoder, preWarmed: this.isWarmedUp });

        // AudioContext olustur/hazirla
        await this._ensureAudioContext(signal);

        // Source node - mikrofondan gelen stream
        this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);

        log.webaudio('MediaStreamAudioSourceNode created', {
          channelCount: this.sourceNode.channelCount,
          channelCountMode: this.sourceNode.channelCountMode
        });

        // Destination node - SADECE MediaRecorder modu için gerekli
        // WASM Opus modunda destinationNode kullanılmıyor (PCM doğrudan worker'a gidiyor)
        if (needsMediaRecorder && !this.destinationNode) {
          this.destinationNode = this.audioContext.createMediaStreamDestination();
          this.destinationNode.channelCount = this.stream.getAudioTracks()[0]?.getSettings?.().channelCount || 1;
          this.destinationNode.channelCountMode = 'explicit';
          log.webaudio('MediaStreamAudioDestinationNode created', {
            channelCount: this.destinationNode.channelCount,
            streamId: this.destinationNode.stream.id
          });
        }

        // ═══════════════════════════════════════════════════════════════
        // PIPELINE KURULUMU (OCP: Strategy Pattern)
        // ═══════════════════════════════════════════════════════════════
        // NOT: WASM Opus pipeline'ları (scriptprocessor, worklet) destinationNode kullanmaz
        const destinationForPipeline = needsMediaRecorder ? this.destinationNode : null;

        this.pipelineStrategy = createPipeline(
          this.pipelineType,
          this.audioContext,
          this.sourceNode,
          destinationForPipeline
        );

        await this.pipelineStrategy.setup({
          bufferSize,
          mediaBitrate,
          channels: this.stream.getAudioTracks()[0]?.getSettings?.().channelCount || 1,
          encoder: this.encoder,
          signal
        });

        // MediaRecorder icin WebAudio'dan gelen stream'i kullan
        if (needsMediaRecorder) {
          recordStream = this.destinationNode.stream;
        }
      } else {
        // Direct pipeline - VU Meter icin shared AudioContext kullan
        await this._ensureAudioContext(signal);
        this.pipelineStrategy = createPipeline(PIPELINE_TYPES.DIRECT, this.audioContext, null, null);
        await this.pipelineStrategy.setup({ stream: this.stream });
      }
      signal.throwIfAborted();

      // ═══════════════════════════════════════════════════════════════
      // ENCODER KURULUMU (MediaRecorder, WASM Opus veya PCM/WAV)
      // ═══════════════════════════════════════════════════════════════
      // Reuse the pipeline analyser before encoding; preparation is never part of the saved file.
      if (this.captureGuide.enabled) {
        const preparation = this.captureGuide.prepare(this.stream);
        this._streamStarted = true;
        emitStreamWithAnalyser(this.pipelineStrategy?.analyserNode, this.stream, this.pipelineStrategy?.analysisAnalyserNode);
        if (!await preparation || this._cancelStart || this.stream.getAudioTracks().some(track => track.readyState === 'ended')) {
          throw new Error('Microphone stopped before recording could start');
        }
      }
      if (needsMediaRecorder) {
        await this._setupMediaRecorder(recordStream);
      } else if (usesPcmWav(this.encoder)) {
        // PCM/WAV encoder modu - MediaRecorder yok, raw PCM biriktirme
        this.startTime = performance.now();
        log.recorder('PCM/WAV encoder aktif (raw recording)', {
          pipeline: this.pipelineType,
          encoder: this.encoder,
          sampleRate: this.audioContext?.sampleRate || 'N/A'
        });
      } else {
        // WASM Opus encoder modu - MediaRecorder yok
        this.startTime = performance.now();
        const opusWorker = this.pipelineStrategy?.getOpusWorker?.();
        log.recorder('WASM Opus encoder active (MediaRecorder not used)', {
          pipeline: this.pipelineType,
          encoder: this.encoder,
          encoderType: opusWorker?.encoderType || 'unknown'
        });
      }

      if (this._cancelStart || this.stream.getAudioTracks().some(track => track.readyState === 'ended')) {
        throw new Error('Microphone stopped before recording could start');
      }
      this.runSnapshot = completeRunSnapshot(this.runSnapshot, this.stream, {
        pipeline: this.pipelineType,
        encoder: this.encoder,
        sampleRate: this.audioContext?.sampleRate ?? null,
        channels: this.pipelineStrategy?._channels ?? this.stream.getAudioTracks()[0]?.getSettings?.().channelCount ?? null,
        audioContext: usesWebAudio(this.pipelineType) && this.audioContext ? {
          supported: true,
          sampleRate: this.audioContext.sampleRate,
          baseLatencyMs: Number.isFinite(this.audioContext.baseLatency) ? this.audioContext.baseLatency * 1000 : null,
          outputLatencyMs: Number.isFinite(this.audioContext.outputLatency) ? this.audioContext.outputLatency * 1000 : null
        } : null
      });
      this.pipelineStrategy.onCaptureError = error => this._requestStop('capture-error', error);
      this.pipelineStrategy.onCaptureLimit = () => this._requestStop('memory-limit');
      this.isRecording = true;
      this.pipelineStrategy.startCapture();
      this._trackEndedListeners = this.stream.getAudioTracks().map(track => {
        const listener = () => this._requestStop('device-ended');
        track.addEventListener('ended', listener);
        return { track, listener };
      });
      if (!this._streamStarted) {
        this._streamStarted = true;
        emitStreamWithAnalyser(this.pipelineStrategy?.analyserNode, this.stream, this.pipelineStrategy?.analysisAnalyserNode);
      }

      // Pipeline + Encoder kombinasyonuna gore label (DRY: Config.js labels kullaniliyor)
      const pipelineLabel = SETTINGS.pipeline.labels[this.pipelineType] || this.pipelineType;
      const encoderLabel = SETTINGS.encoder.labels[this.encoder] || this.encoder;
      const modeText = `${pipelineLabel} + ${encoderLabel}`;
      const timesliceText = this.timeslice > 0 ? `, Timeslice: ${this.timeslice}ms` : '';
      log.recorder(`Recording started (${modeText}${timesliceText})`);
      eventBus.emit(EVENTS.RECORDER_STARTED, { encoder: this.encoder, pipeline: this.pipelineType });
      eventBus.emit(EVENTS.RECORDING_STARTED, { runSnapshot: this.runSnapshot });
      this.captureGuide.start(this.startTime, () => this._requestStop('guided-complete'));

    } catch (err) {
      // Spesifik hata mesajlari (DRY: utils.js helper kullaniliyor)
      const userMessage = getStreamErrorMessage(err);

      if (!signal.aborted) log.error(userMessage, { category: 'recorder', originalError: err.name });

      this.isRecording = false;
      this.captureGuide?.cancel();
      this._releaseStream();
      this._clearMediaRecorder();
      await this.cleanupWebAudio(true);
      throw err;
    }
  }

  /**
   * AudioContext'i hazirla (pre-warm veya yeni olustur)
   * @private
   */
  async _ensureAudioContext(signal) {
    if (!this.audioContext) {
      // DRY: factory + helper kullan - mikrofon sample rate ile olustur
      const acOptions = getAudioContextOptions(this.stream);
      this.audioContext = await createAudioContext(acOptions, { signal });

      const micSampleRate = acOptions.sampleRate;
      log.webaudio('AudioContext created (Recording - cold start)', {
        state: this.audioContext.state,
        sampleRate: this.audioContext.sampleRate,
        micSampleRate: micSampleRate || 'N/A',
        sampleRateMatch: !micSampleRate || micSampleRate === this.audioContext.sampleRate,
        baseLatency: this.audioContext.baseLatency
      });
    } else {
      // Pre-warmed context var - sample rate kontrolu yap
      const track = this.stream.getAudioTracks()[0];
      const trackSettings = track.getSettings();
      const micSampleRate = trackSettings.sampleRate;

      // Sample rate uyusmuyorsa pre-warmed context'i kapat, yeni olustur
      if (micSampleRate && micSampleRate !== this.audioContext.sampleRate) {
        log.webaudio('Pre-warmed AudioContext sample rate mismatch - creating new context', {
          preWarmedSampleRate: this.audioContext.sampleRate,
          micSampleRate: micSampleRate
        });

        // Eski context'i kapat
        await this.audioContext.close();
        this.destinationNode = null;

        // DRY: factory kullan - yeni context olustur (mikrofon sample rate ile)
        this.audioContext = await createAudioContext({ sampleRate: micSampleRate }, { signal });
        this.isWarmedUp = false; // Artik pre-warmed degil
      } else {
        // Sample rate uyumlu - resume et
        if (this.audioContext.state === 'suspended') {
          await abortable(this.audioContext.resume(), signal);
        }
      }

      log.webaudio('AudioContext in use' + (this.isWarmedUp ? ' (pre-warmed)' : ' (newly created)'), {
        state: this.audioContext.state,
        sampleRate: this.audioContext.sampleRate,
        micSampleRate: micSampleRate || 'N/A',
        sampleRateMatch: !micSampleRate || micSampleRate === this.audioContext.sampleRate
      });
    }
  }

  /**
   * MediaRecorder kurulumu
   * @private
   */
  async _setupMediaRecorder(recordStream) {
    // MediaRecorder olustur - DRY: createMediaRecorder helper kullaniliyor
    const recorderOptions = this.mediaBitrate > 0
      ? { audioBitsPerSecond: this.mediaBitrate }
      : {};
    this.mediaRecorder = createMediaRecorder(recordStream, recorderOptions);

    const bitrateInfo = this.mediaBitrate > 0
      ? `${(this.mediaBitrate / 1000).toFixed(0)} kbps`
      : 'default';

    log.recorder('MediaRecorder created', {
      mimeType: this.mediaRecorder.mimeType,
      state: this.mediaRecorder.state,
      pipeline: this.pipelineType,
      encoder: this.encoder,
      useWebAudio: usesWebAudio(this.pipelineType),
      mediaBitrate: bitrateInfo,
      streamId: recordStream.id
    });

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this._mediaStopped = new Promise(resolve => { this._resolveMediaStopped = resolve; });
    this.mediaRecorder.onerror = (e) => {
      this._requestStop('encoder-error', e.error || new Error('MediaRecorder failed'));
    };
    this.mediaRecorder.onstop = () => {
      this._resolveMediaStopped?.();
      if (!this._stopPromise) this._requestStop('recorder-ended');
    };

    // Timeslice ile veya tek chunk olarak baslat
    this.startTime = performance.now();
    if (this.timeslice > 0) {
      this.mediaRecorder.start(this.timeslice);
    } else {
      this.mediaRecorder.start();
    }
  }

  /**
   * Encoding tamamlandiginda ortak finalize islemi (DRY: PCM/WAV ve WASM Opus icin)
   * @param {Object} params - { blob, mimeType, filename, extras }
   * @private
   */
  async _finishEncoding({ blob, mimeType, filename, extras = {} }) {
    if (!blob.size || extras.sampleCount === 0) throw new Error('The recording contains no audio samples');
    const durationMs = Number.isFinite(extras.sampleCount) && extras.sampleRate > 0
      ? extras.sampleCount / extras.sampleRate * 1000
      : this.captureDurationMs;
    const { bps: actualBitrate, kbps: actualBitrateKbps } = calculateActualBitrate(blob.size, durationMs);

    log.recorder('Recording complete: ' + bytesToKB(blob.size).toFixed(1) + ' KB (~' + actualBitrateKbps + ' kbps)');
    eventBus.emit(EVENTS.RECORDING_COMPLETED, {
      blob,
      mimeType,
      filename,
      pipeline: this.pipelineType,
      encoder: this.encoder,
      useWebAudio: usesWebAudio(this.pipelineType),
      durationMs,
      actualBitrate,
      runSnapshot: this.runSnapshot,
      guidedSegments: this.guidedSegments,
      stopReason: this.stopReason,
      durationSource: Number.isFinite(extras.sampleCount) ? 'captured-pcm-frames' : 'capture-clock',
      bitrateSource: 'container-bytes',
      ...extras
    });
  }

  async cleanupWebAudio(forceClose = false) {
    // Pipeline strategy temizligi (OCP: Strategy kendini temizler)
    if (this.pipelineStrategy) {
      const pipeline = this.pipelineStrategy;
      this.pipelineStrategy = null;
      try { await pipeline.cleanup(); } catch (error) {
        log.error('Pipeline cleanup failed', { error: error.message });
      }
    }

    // DRY: disconnectNodes helper ile sourceNode temizle
    disconnectNodes([this.sourceNode]);
    this.sourceNode = null;

    stopStreamTracks(this.destinationNode?.stream);
    disconnectNodes([this.destinationNode]);
    this.destinationNode = null;
    // A warmed context can be reused; per-recording destination tracks cannot.
    if (this.isWarmedUp && !forceClose) {
      log.webaudio('WebAudio cleanup (context korunuyor - pre-warmed)', { contextState: this.audioContext?.state });
      return;
    }

    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        // Context zaten kapali olabilir
      }
      log.webaudio('AudioContext closed (Recording)', {});
      this.audioContext = null;
    }
    this.isWarmedUp = false;
  }

  _requestStop(reason, error = null) {
    if (error) this._recordingError = error;
    if (reason === 'device-ended') {
      eventBus.emit(EVENTS.UI_MESSAGE, { message: 'Microphone disconnected. Finishing the captured recording.', tone: 'warning' });
    } else if (reason === 'memory-limit') {
      eventBus.emit(EVENTS.UI_MESSAGE, { message: 'Raw recording reached the memory limit. The captured audio is being saved; start a new recording to continue.', tone: 'warning' });
    }
    void this.stop(reason).catch(() => {}); // stop publishes the failure and releases all resources.
  }

  _releaseStream() {
    for (const { track, listener } of this._trackEndedListeners) track.removeEventListener('ended', listener);
    this._trackEndedListeners = [];
    stopStreamTracks(this.stream);
    this.stream = null;
    if (this._streamStarted) {
      this._streamStarted = false;
      eventBus.emit(EVENTS.STREAM_STOPPED);
    }
  }

  _clearMediaRecorder() {
    const recorder = this.mediaRecorder;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* failed/inactive encoder already released */ }
      }
    }
    this.mediaRecorder = null;
    this.chunks = [];
    this._resolveMediaStopped = null;
    this._mediaStopped = null;
  }

  stop(reason = 'user') {
    if (this._stopPromise) return this._stopPromise;
    this._cancelStart = true;
    if (this._startPromise) {
      this._startAbort?.abort(new DOMException('Recording start cancelled', 'AbortError'));
      this.captureGuide?.cancel();
    }
    const stopping = Promise.resolve().then(async () => {
      if (this._startPromise) await this._startPromise.catch(() => {});
      if (!this.isRecording && !this.stream && !this.pipelineStrategy) return;
      this.isRecording = false;
      this.stopReason = reason;
      this.captureDurationMs = Math.max(0, performance.now() - this.startTime);
      this.guidedSegments = this.captureGuide?.finish(this.captureDurationMs) || null;
      eventBus.emit(EVENTS.RECORDING_CAPTURE_STOPPED, {
        durationMs: this.captureDurationMs, stopReason: reason, runSnapshot: this.runSnapshot
      });
      try {
        // Stop accepting input before waiting for workers or MediaRecorder finalization.
        const captureStopped = Promise.resolve(this.pipelineStrategy?.stopCapture());
        captureStopped.catch(() => {});
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
        this._releaseStream();
        disconnectNodes([this.sourceNode]);
        await captureStopped;
        if (this._recordingError) throw this._recordingError;

        if (usesPcmWav(this.encoder)) {
          const result = await this.pipelineStrategy.finishPcmWavEncoding();
          await this._finishEncoding({
            blob: result.blob, mimeType: 'audio/wav',
            filename: 'kayit_raw_' + formatTimestampYYMMDDHHMMSS() + '.wav',
            extras: { ...result, requestedBitrate: result.sampleRate * result.channels * 16 }
          });
        } else if (usesWasmOpus(this.encoder)) {
          const result = await this.pipelineStrategy.finishOpusEncoding();
          await this._finishEncoding({
            blob: result.blob, mimeType: 'audio/ogg; codecs=opus',
            filename: 'kayit_wasm_opus_' + formatTimestampYYMMDDHHMMSS() + '.ogg',
            extras: { ...result, requestedBitrate: this.mediaBitrate > 0 ? this.mediaBitrate : null }
          });
        } else if (this.mediaRecorder) {
          let timeout;
          try {
            await Promise.race([
              this._mediaStopped,
              new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('MediaRecorder completion timed out')), 10000); })
            ]);
          } finally { clearTimeout(timeout); }
          if (this._recordingError) throw this._recordingError;
          const mimeType = this.mediaRecorder.mimeType || 'audio/webm';
          const blob = new Blob(this.chunks, { type: mimeType });
          if (!blob.size) throw new Error('The recording contains no audio data');
          await this._finishEncoding({
            blob, mimeType,
            filename: `kayit_${formatTimestampYYMMDDHHMMSS()}.${getExtensionForMimeType(mimeType)}`,
            extras: { requestedBitrate: this.mediaBitrate > 0 ? this.mediaBitrate : null }
          });
        }
      } catch (error) {
        log.error('Recording finalization failed', { error: error.message });
        eventBus.emit(EVENTS.RECORDING_FAILED, { error: error.message, runSnapshot: this.runSnapshot });
        eventBus.emit(EVENTS.UI_MESSAGE, { message: `Recording could not be saved: ${error.message}`, tone: 'error' });
        throw error;
      } finally {
        this._releaseStream();
        this._clearMediaRecorder();
        try {
          await this.cleanupWebAudio();
        } finally {
          eventBus.emit(EVENTS.RECORDER_STOPPED, { encoder: this.encoder, pipeline: this.pipelineType, runSnapshot: this.runSnapshot });
        }
      }
    }).finally(() => {
      if (this._stopPromise === stopping) this._stopPromise = null;
    });
    this._stopPromise = stopping;
    return stopping;
  }

  getStream() {
    return this.stream;
  }

  getIsRecording() {
    return this.isRecording;
  }

  getIsStopping() {
    return !!this._stopPromise;
  }

  // Geriye uyumluluk icin pipeline property (string olarak)
  get pipeline() {
    return this.pipelineType;
  }
}

export default Recorder;
