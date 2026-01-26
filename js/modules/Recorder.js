/**
 * Recorder - Ses kaydi yonetimi
 * OCP: Pipeline Strategy Pattern ile farkli kayit modlari eklenebilir
 * WebAudio mode: Stream -> AudioContext -> MediaStreamDestination -> MediaRecorder
 */
import eventBus from './EventBus.js';
import { requestStream } from './StreamHelper.js';
import { createAudioContext, getAudioContextOptions, stopStreamTracks, createMediaRecorder, usesWebAudio, usesWasmOpus, usesMediaRecorder, usesPcmWav, getStreamErrorMessage, formatTimestampYYMMDDHHMMSS, calculateActualBitrate, disconnectNodes, log } from './utils.js';
import { BUFFER, bytesToKB } from './constants.js';
import { createPipeline, isPipelineSupported } from '../pipelines/PipelineFactory.js';
import { SETTINGS } from './Config.js';

class Recorder {
  constructor(config) {
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
    // Encoder: Kayit formati (mediarecorder | wasm-opus)
    this.pipelineType = 'direct';
    this.encoder = 'mediarecorder';
    this.startTime = null; // Kayit baslangic zamani (bitrate hesaplama icin)

    // Pre-warm state
    this.isWarmedUp = false;
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
      this.audioContext = await createAudioContext();

      this.isWarmedUp = true;

      log.webaudio('Recorder: WebAudio warmup tamamlandi', {
        state: this.audioContext.state,
        sampleRate: this.audioContext.sampleRate
      });
    } catch (err) {
      log.error('Recorder: Warmup hatasi', { error: err.message });
    }
  }

  async start(constraints, pipelineParam = 'direct', encoderParam = 'mediarecorder', timeslice = 0, bufferSize = BUFFER.DEFAULT_SIZE, mediaBitrate = 0) {
    if (this.isRecording) return;

    // Pipeline ve encoder validasyonu (OCP: PipelineFactory destekli kontrol)
    const allowedEncoders = new Set(['mediarecorder', 'wasm-opus', 'pcm-wav']);
    this.pipelineType = isPipelineSupported(pipelineParam) ? pipelineParam : 'direct';
    this.encoder = allowedEncoders.has(encoderParam) ? encoderParam : 'mediarecorder';

    // PCM/WAV encoder sadece worklet pipeline ile calisir
    if (usesPcmWav(this.encoder) && this.pipelineType !== 'worklet') {
      log.warning('PCM/WAV encoder worklet pipeline gerektiriyor, pipeline degistiriliyor', { requestedPipeline: this.pipelineType, newPipeline: 'worklet' });
      this.pipelineType = 'worklet';
    }
    this.timeslice = timeslice;
    this.mediaBitrate = mediaBitrate; // Hedef bitrate (MediaRecorder veya WASM Opus icin)

    try {
      this.stream = await requestStream(constraints);
      this.chunks = [];

      // NOT: stream:started event'i pipeline kurulumundan SONRA emit edilir
      // Bu sayede VuMeter.start() yerine startWithAnalyser() kullanilir (gereksiz AudioEngine baglantisi onlenir)

      let recordStream = this.stream;

      // Pipeline ve encoder bazli kontroller (DRY: utils.js helper'lari)
      const needsWebAudioGraph = usesWebAudio(this.pipelineType);
      const needsMediaRecorder = usesMediaRecorder(this.encoder);

      // WebAudio-based modes: Stream -> (WebAudio graph) -> Destination -> MediaRecorder/WASM
      if (needsWebAudioGraph) {
        log.webaudio('Kayit pipeline modu aktif', { pipeline: this.pipelineType, encoder: this.encoder, preWarmed: this.isWarmedUp });

        // AudioContext olustur/hazirla
        await this._ensureAudioContext();

        // Source node - mikrofondan gelen stream
        this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);

        log.webaudio('MediaStreamAudioSourceNode olusturuldu', {
          channelCount: this.sourceNode.channelCount,
          channelCountMode: this.sourceNode.channelCountMode
        });

        // Destination node - SADECE MediaRecorder modu için gerekli
        // WASM Opus modunda destinationNode kullanılmıyor (PCM doğrudan worker'a gidiyor)
        if (needsMediaRecorder && !this.destinationNode) {
          this.destinationNode = this.audioContext.createMediaStreamDestination();
          log.webaudio('MediaStreamAudioDestinationNode olusturuldu', {
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
          channels: constraints.channelCount || 1,
          encoder: this.encoder
        });

        // VU Meter icin pipeline'dan analyser'i gonder (encode oncesi islenmiş sinyal)
        if (this.pipelineStrategy.analyserNode) {
          eventBus.emit('pipeline:analyserReady', this.pipelineStrategy.analyserNode);
        }

        // MediaRecorder icin WebAudio'dan gelen stream'i kullan
        if (needsMediaRecorder) {
          recordStream = this.destinationNode.stream;
        }
      } else {
        // Direct pipeline - VU Meter icin shared AudioContext kullan
        await this._ensureAudioContext();
        this.pipelineStrategy = createPipeline('direct', this.audioContext, null, null);
        await this.pipelineStrategy.setup({ stream: this.stream });

        // VU Meter icin pipeline'dan analyser'i gonder
        if (this.pipelineStrategy.analyserNode) {
          eventBus.emit('pipeline:analyserReady', this.pipelineStrategy.analyserNode);
        }
      }

      // Stream event'i gonder (DeviceInfo ve LogManager dinler)
      // pipeline:analyserReady SONRA emit edilir - VuMeter guard ile gereksiz baglanti onlenir
      eventBus.emit('stream:started', this.stream);

      // ═══════════════════════════════════════════════════════════════
      // ENCODER KURULUMU (MediaRecorder, WASM Opus veya PCM/WAV)
      // ═══════════════════════════════════════════════════════════════
      if (needsMediaRecorder) {
        await this._setupMediaRecorder(recordStream);
      } else if (usesPcmWav(this.encoder)) {
        // PCM/WAV encoder modu - MediaRecorder yok, raw PCM biriktirme
        this.startTime = Date.now();
        log.recorder('PCM/WAV encoder aktif (raw recording)', {
          pipeline: this.pipelineType,
          encoder: this.encoder,
          sampleRate: this.audioContext?.sampleRate || 'N/A'
        });
      } else {
        // WASM Opus encoder modu - MediaRecorder yok
        this.startTime = Date.now();
        const opusWorker = this.pipelineStrategy?.getOpusWorker?.();
        log.recorder('WASM Opus encoder aktif (MediaRecorder kullanilmiyor)', {
          pipeline: this.pipelineType,
          encoder: this.encoder,
          encoderType: opusWorker?.encoderType || 'unknown'
        });
      }

      this.isRecording = true;

      // Pipeline + Encoder kombinasyonuna gore label (DRY: Config.js labels kullaniliyor)
      const pipelineLabel = SETTINGS.pipeline.labels[this.pipelineType] || this.pipelineType;
      const encoderLabel = SETTINGS.encoder.labels[this.encoder] || this.encoder;
      const modeText = `${pipelineLabel} + ${encoderLabel}`;
      const timesliceText = this.timeslice > 0 ? `, Timeslice: ${this.timeslice}ms` : '';
      log.recorder(`KAYIT basladi (${modeText}${timesliceText})`);
      eventBus.emit('recorder:started', { encoder: this.encoder, pipeline: this.pipelineType });
      eventBus.emit('recording:started');

    } catch (err) {
      // Spesifik hata mesajlari (DRY: utils.js helper kullaniliyor)
      const userMessage = getStreamErrorMessage(err);

      log.error(userMessage, { category: 'recorder', originalError: err.name });

      await this.cleanupWebAudio();
      // NOT: stream:stopped EMIT ETME - stream:started henuz emit edilmedi
      // (stream:started bu try blogunun sonunda, catch oncesinde)
      // Bu balance bozulmasi ve yanlis pozitif uyarilari onler
      eventBus.emit('recorder:error', err);
      throw err;
    }
  }

  /**
   * AudioContext'i hazirla (pre-warm veya yeni olustur)
   * @private
   */
  async _ensureAudioContext() {
    if (!this.audioContext) {
      // DRY: factory + helper kullan - mikrofon sample rate ile olustur
      const acOptions = getAudioContextOptions(this.stream);
      this.audioContext = await createAudioContext(acOptions);

      const micSampleRate = acOptions.sampleRate;
      log.webaudio('AudioContext olusturuldu (Kayit - cold start)', {
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
        log.webaudio('Pre-warmed AudioContext sample rate uyumsuz - yeni context olusturuluyor', {
          preWarmedSampleRate: this.audioContext.sampleRate,
          micSampleRate: micSampleRate
        });

        // Eski context'i kapat
        await this.audioContext.close();
        this.destinationNode = null;

        // DRY: factory kullan - yeni context olustur (mikrofon sample rate ile)
        this.audioContext = await createAudioContext({ sampleRate: micSampleRate });
        this.isWarmedUp = false; // Artik pre-warmed degil
      } else {
        // Sample rate uyumlu - resume et
        if (this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }
      }

      log.webaudio('AudioContext kullaniliyor' + (this.isWarmedUp ? ' (pre-warmed)' : ' (yeniden olusturuldu)'), {
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
      : 'varsayilan';

    log.recorder('MediaRecorder olusturuldu', {
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

    // MediaRecorder hata handler - kayit sirasinda hata olursa log'a yaz
    this.mediaRecorder.onerror = (e) => {
      log.error('MediaRecorder hatasi', {
        error: e.error?.message || e.error?.name || 'Unknown error',
        state: this.mediaRecorder?.state
      });
    };

    this.mediaRecorder.onstop = async () => {
      // Race condition önleme: onstop sonrası ondataavailable fire etmesin
      if (this.mediaRecorder) {
        this.mediaRecorder.ondataavailable = null;
      }

      try {
        const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type: mimeType });
        const suffix = this.pipelineType === 'direct' ? '' : `_${this.pipelineType}`;
        const filename = `kayit${suffix}_${formatTimestampYYMMDDHHMMSS()}.webm`;

        // Gercek bitrate hesapla (DRY: helper kullan)
        const durationMs = Date.now() - this.startTime;
        const { bps: actualBitrate, kbps: actualBitrateKbps } = calculateActualBitrate(blob.size, durationMs);

        // Istenen vs gercek karsilastirmasi
        const requestedBitrate = this.mediaBitrate || 0;
        const bitrateComparison = requestedBitrate > 0
          ? `Istenen: ${(requestedBitrate / 1000).toFixed(0)} kbps, Gercek: ~${actualBitrateKbps} kbps`
          : `Gercek bitrate: ~${actualBitrateKbps} kbps`;

        log.recorder(`Kayit tamamlandi: ${bytesToKB(blob.size).toFixed(1)} KB (${bitrateComparison})`);
        eventBus.emit('recording:completed', {
          blob,
          mimeType,
          filename,
          pipeline: this.pipelineType,
          encoder: this.encoder,
          useWebAudio: usesWebAudio(this.pipelineType),
          durationMs,
          requestedBitrate,
          actualBitrate
        });

        // WebAudio temizlik
        if (usesWebAudio(this.pipelineType)) {
          await this.cleanupWebAudio();
        }

        // Temizlik
        this.mediaRecorder = null;
      } catch (err) {
        log.error('MediaRecorder onstop hatasi', { error: err.message, stack: err.stack });
        eventBus.emit('recording:failed', { error: err.message });
        this.mediaRecorder = null;
      }
    };

    // Timeslice ile veya tek chunk olarak baslat
    this.startTime = Date.now();
    if (this.timeslice > 0) {
      this.mediaRecorder.start(this.timeslice);
    } else {
      this.mediaRecorder.start();
    }
  }

  async cleanupWebAudio(forceClose = false) {
    // Pipeline strategy temizligi (OCP: Strategy kendini temizler)
    if (this.pipelineStrategy) {
      await this.pipelineStrategy.cleanup();
      this.pipelineStrategy = null;
    }

    // DRY: disconnectNodes helper ile sourceNode temizle
    disconnectNodes([this.sourceNode]);
    this.sourceNode = null;

    // Pre-warmed ise context ve destination'i koru (tekrar hizli baslatma icin)
    if (this.isWarmedUp && !forceClose) {
      log.webaudio('WebAudio cleanup (context korunuyor - pre-warmed)', { contextState: this.audioContext?.state });
      return;
    }

    // Full cleanup - DRY: disconnectNodes helper ile destinationNode temizle
    disconnectNodes([this.destinationNode]);
    this.destinationNode = null;

    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        // Context zaten kapali olabilir
      }
      log.webaudio('AudioContext kapatildi (Kayit)', {});
      this.audioContext = null;
    }
    this.isWarmedUp = false;
  }

  async stop() {
    if (!this.isRecording) return;

    // PCM/WAV encoder modu
    if (usesPcmWav(this.encoder) && this.pipelineStrategy?.getEncoderMode?.() === 'pcm-wav') {
      try {
        log.recorder('PCM/WAV encoding tamamlaniyor...');

        // Strategy'den final WAV blob'u al
        const result = this.pipelineStrategy.finishPcmWavEncoding();

        const durationMs = Date.now() - this.startTime;
        const durationSec = durationMs / 1000;
        // WAV icin bitrate = sampleRate * channels * bitsPerSample
        const sampleRate = this.audioContext?.sampleRate || 48000;
        const theoreticalBitrate = sampleRate * 1 * 16; // mono, 16-bit

        log.recorder(`Kayit tamamlandi: ${bytesToKB(result.blob.size).toFixed(1)} KB (${result.sampleCount} sample, ${durationSec.toFixed(1)}s)`);
        eventBus.emit('recording:completed', {
          blob: result.blob,
          mimeType: 'audio/wav',
          filename: `kayit_raw_${formatTimestampYYMMDDHHMMSS()}.wav`,
          pipeline: this.pipelineType,
          encoder: this.encoder,
          useWebAudio: true,
          durationMs,
          requestedBitrate: theoreticalBitrate,
          actualBitrate: theoreticalBitrate,
          sampleCount: result.sampleCount,
          encoderType: result.encoderType
        });

        // WebAudio temizlik (strategy cleanup dahil)
        await this.cleanupWebAudio();

      } catch (error) {
        log.error('PCM/WAV encoding hatasi', { error: error.message });

        await this.cleanupWebAudio();
      }
    }
    // WASM Opus encoder modu icin Opus Worker'i bitir (OCP: Strategy'den al)
    else if (usesWasmOpus(this.encoder) && this.pipelineStrategy?.getOpusWorker?.()) {
      try {
        log.recorder('Opus encoding tamamlaniyor...');

        // Strategy'den final blob'u al
        const result = await this.pipelineStrategy.finishOpusEncoding();

        // Gercek bitrate hesapla (DRY: helper kullan)
        const durationMs = Date.now() - this.startTime;
        const { bps: actualBitrate, kbps: actualBitrateKbps } = calculateActualBitrate(result.blob.size, durationMs);

        log.recorder(`Kayit tamamlandi: ${bytesToKB(result.blob.size).toFixed(1)} KB (Gercek: ~${actualBitrateKbps} kbps, ${result.pageCount} page)`);
        eventBus.emit('recording:completed', {
          blob: result.blob,
          mimeType: 'audio/ogg; codecs=opus',
          filename: `kayit_wasm_opus_${formatTimestampYYMMDDHHMMSS()}.ogg`,
          pipeline: this.pipelineType,
          encoder: this.encoder,
          useWebAudio: true,
          durationMs,
          requestedBitrate: this.mediaBitrate || 16000,
          actualBitrate,
          pageCount: result.pageCount,
          encoderType: result.encoderType
        });

        // WebAudio temizlik (strategy cleanup dahil)
        await this.cleanupWebAudio();

      } catch (error) {
        log.error('Opus encoding hatasi', { error: error.message });

        await this.cleanupWebAudio();
      }
    } else if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      // MediaRecorder modu
      this.mediaRecorder.stop();
    }

    // Stream durdur (DRY: stopStreamTracks kullan)
    stopStreamTracks(this.stream);
    this.stream = null;

    this.isRecording = false;

    eventBus.emit('stream:stopped');
    log.recorder('KAYIT durduruldu');
    eventBus.emit('recorder:stopped', { encoder: this.encoder, pipeline: this.pipelineType });
  }

  getStream() {
    return this.stream;
  }

  getIsRecording() {
    return this.isRecording;
  }

  // Geriye uyumluluk icin pipeline property (string olarak)
  get pipeline() {
    return this.pipelineType;
  }
}

export default Recorder;
