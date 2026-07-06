/**
 * AudioMetricsCollector - Sessiz arka plan ses kalitesi veri toplayici
 *
 * VuMeter'in zaten her frame emit ettigi VUMETER_LEVEL event'ine pasif tutunur.
 * Mevcut modullere DOKUNMAZ. Test/kayit sirasinda metrik biriktirir,
 * bitiste yapilandirilmis istatistik dondurur.
 *
 * Toplanan metrikler: noise floor, SNR, dynamic range, clipping rate,
 * dropout count, signal stability, frekans dagitimi
 */
import eventBus from './EventBus.js';
import { EVENTS, QUALITY, AUDIO } from './constants.js';
import { log } from './utils.js';
import { LUFSCalculator } from './utils/lufs.js';

class AudioMetricsCollector {
  constructor() {
    this._isCollecting = false;
    this._analyserNode = null;
    this._sampleRate = AUDIO.DEFAULT_SAMPLE_RATE;

    // --- Running statistics (online hesaplama, sabit memory) ---
    this._totalFrames = 0;
    this._clippedFrames = 0;
    this._clippingEvents = 0;       // Ardisik clipping grubu sayisi
    this._lastWasClipping = false;
    this._dropoutEvents = 0;
    this._dropoutConsecutive = 0;
    this._dropoutTotalMs = 0;
    this._weakSignalFrames = 0;
    this._lastResults = null;       // stop() sonrasi rapor icin sakla

    // Level stats (online mean/variance - Welford's algorithm)
    this._levelSum = 0;
    this._levelMin = 100;
    this._levelMax = 0;

    // dB stats (online mean/variance)
    this._dbSum = 0;
    this._dbM2 = 0;             // Welford M2 for variance
    this._dbMin = 0;
    this._dbMax = -96;

    // dB samples circular buffer (noise floor hesabi icin)
    this._dbBufferSize = 2000;
    this._dbBuffer = new Float32Array(this._dbBufferSize);
    this._dbBufferIndex = 0;
    this._dbBufferFilled = 0;   // Kac slot dolu (min(totalFrames, bufferSize))

    // SNR power-ratio akumulatorleri (C3 fix)
    this._signalPowerSum = 0;
    this._signalFrameCount = 0;
    this._noisePowerSum = 0;
    this._noiseFrameCount = 0;

    // Dropout zamanlama (S3 fix — frame-rate bagimsiz)
    this._lastFrameTimestamp = 0;

    // LUFS olcumu
    this._lufsCalculator = null;
    this._lufsTimeDomainData = null;  // getFloatTimeDomainData buffer
    this._lufsIntervalId = null;

    // Frekans analizi
    this._freqData = null;          // Pre-allocated Float32Array (lazy init)
    this._freqIntervalId = null;
    this._freqBandSums = { subBass: 0, lowMid: 0, highMid: 0, presence: 0 };
    this._freqSnapshotCount = 0;
    this._freqBinSums = null;       // Lazy init: bin-bazli frekans yanit biriktirme
    this._aWeightTable = null;

    // Event listener referanslari (memory leak onleme)
    this._onVuLevel = (data) => this._collectLevel(data);
    this._onAnalyserReady = (node) => this._setAnalyser(node);
    this._onRecordingStarted = () => this.start();
    this._onTestStarted = () => this.start();
    this._onRecordingCompleted = () => this.stop();
    this._onTestCompleted = () => this.stop();
    this._onStreamStopped = () => {
      if (this._isCollecting) this.stop();
      this._clearAnalyser();
    };

    // Pasif dinleyiciler kaydet (her zaman aktif, start/stop sadece toplama kontrolu)
    eventBus.on(EVENTS.PIPELINE_ANALYSIS_ANALYSER_READY, this._onAnalyserReady);
    eventBus.on(EVENTS.RECORDING_STARTED, this._onRecordingStarted);
    eventBus.on(EVENTS.TEST_RECORDING_STARTED, this._onTestStarted);
    eventBus.on(EVENTS.RECORDING_COMPLETED, this._onRecordingCompleted);
    eventBus.on(EVENTS.TEST_COMPLETED, this._onTestCompleted);
    eventBus.on(EVENTS.STREAM_STOPPED, this._onStreamStopped);
  }

  // === PUBLIC API ===

  start() {
    if (this._isCollecting) return;
    this._reset();
    this._isCollecting = true;
    this._startTime = Date.now();

    // VU level dinlemeye basla
    eventBus.on(EVENTS.VUMETER_LEVEL, this._onVuLevel);

    // Frekans snapshot + LUFS baslat
    if (this._analyserNode) {
      this._startFrequencyCapture();
      this._startLUFSCapture();
    }

    eventBus.emit(EVENTS.METRICS_STARTED);
    log.audio('AudioMetricsCollector started');
  }

  stop() {
    if (!this._isCollecting) return null;
    this._isCollecting = false;
    const durationMs = Date.now() - this._startTime;

    // Dinleyicileri kaldir
    eventBus.off(EVENTS.VUMETER_LEVEL, this._onVuLevel);
    this._stopFrequencyCapture();
    this._stopLUFSCapture();

    const results = this._calculateResults(durationMs);
    this._lastResults = results;

    eventBus.emit(EVENTS.METRICS_STOPPED);
    log.audio('AudioMetricsCollector stopped', {
      frames: this._totalFrames,
      durationMs,
      snrDb: results.snr.estimatedDb
    });

    return results;
  }

  getResults() {
    if (this._isCollecting) {
      return this._calculateResults(Date.now() - this._startTime);
    }
    // stop() sonrasi son sonuclari dondur
    return this._lastResults;
  }

  destroy() {
    this.stop();
    this._clearAnalyser();
    eventBus.off(EVENTS.PIPELINE_ANALYSIS_ANALYSER_READY, this._onAnalyserReady);
    eventBus.off(EVENTS.RECORDING_STARTED, this._onRecordingStarted);
    eventBus.off(EVENTS.TEST_RECORDING_STARTED, this._onTestStarted);
    eventBus.off(EVENTS.RECORDING_COMPLETED, this._onRecordingCompleted);
    eventBus.off(EVENTS.TEST_COMPLETED, this._onTestCompleted);
    eventBus.off(EVENTS.STREAM_STOPPED, this._onStreamStopped);
  }

  // === PRIVATE: Data Collection ===

  _setAnalyser(analyserNode) {
    if (!analyserNode) {
      this._clearAnalyser();
      return;
    }

    const sampleRate = analyserNode.context?.sampleRate || AUDIO.DEFAULT_SAMPLE_RATE;
    const needsReset = this._analyserNode !== analyserNode
      || this._sampleRate !== sampleRate
      || this._freqData?.length !== analyserNode.frequencyBinCount
      || this._lufsTimeDomainData?.length !== analyserNode.fftSize;

    this._analyserNode = analyserNode;
    this._sampleRate = sampleRate;

    if (needsReset) {
      this._initializeAnalysisBuffers(analyserNode);
    }

    // Eger toplama aktifse analyzer geldigi anda capture baslat/devam ettir
    if (this._isCollecting) {
      this._startFrequencyCapture();
      this._startLUFSCapture();
    }
  }

  _initializeAnalysisBuffers(analyserNode) {
    const binCount = analyserNode.frequencyBinCount;
    const fftSize = analyserNode.fftSize;
    const binWidth = this._sampleRate / fftSize;

    this._freqData = new Float32Array(binCount);
    this._freqBinSums = new Float32Array(binCount);
    this._aWeightTable = new Float32Array(binCount);
    for (let i = 0; i < binCount; i++) {
      this._aWeightTable[i] = this._aWeightDb(i * binWidth);
    }

    this._lufsCalculator = new LUFSCalculator(this._sampleRate);
    this._lufsTimeDomainData = new Float32Array(fftSize);
    this._freqBandSums = { subBass: 0, lowMid: 0, highMid: 0, presence: 0 };
    this._freqSnapshotCount = 0;
  }

  _clearAnalyser() {
    this._stopFrequencyCapture();
    this._stopLUFSCapture();
    this._analyserNode = null;
    this._sampleRate = AUDIO.DEFAULT_SAMPLE_RATE;
    this._freqData = null;
    this._freqBinSums = null;
    this._aWeightTable = null;
    this._lufsCalculator = null;
    this._lufsTimeDomainData = null;
    this._freqBandSums = { subBass: 0, lowMid: 0, highMid: 0, presence: 0 };
    this._freqSnapshotCount = 0;
  }

  /**
   * VUMETER_LEVEL event handler - her animation frame'de cagirilir
   * Performans kritik: sadece sayac artirma ve karsilastirma
   */
  _collectLevel({ level, rawDb, dB, isClipping }) {
    const dbVal = parseFloat(rawDb ?? dB);
    this._totalFrames++;

    // Frame-rate bagimsiz zamanlama (S3 fix)
    const now = performance.now();
    const frameDeltaMs = this._lastFrameTimestamp > 0 ? (now - this._lastFrameTimestamp) : 16.7;
    this._lastFrameTimestamp = now;

    // Level istatistikleri
    this._levelSum += level;
    if (level < this._levelMin) this._levelMin = level;
    if (level > this._levelMax) this._levelMax = level;

    // dB istatistikleri (Welford's online variance)
    const n = this._totalFrames;
    const oldMean = n > 1 ? this._dbSum / (n - 1) : dbVal;
    this._dbSum += dbVal;
    const newMean = this._dbSum / n;
    this._dbM2 += (dbVal - oldMean) * (dbVal - newMean);

    if (dbVal < this._dbMin) this._dbMin = dbVal;
    if (dbVal > this._dbMax) this._dbMax = dbVal;

    // dB circular buffer (noise floor icin)
    this._dbBuffer[this._dbBufferIndex] = dbVal;
    this._dbBufferIndex = (this._dbBufferIndex + 1) % this._dbBufferSize;
    if (this._dbBufferFilled < this._dbBufferSize) this._dbBufferFilled++;

    // SNR power-ratio akumulatorleri (C3 fix)
    // dB -> lineer guc: P = 10^(dB/10)
    const linPower = Math.pow(10, dbVal / 10);
    if (dbVal < QUALITY.SILENCE_DB) {
      this._noisePowerSum += linPower;
      this._noiseFrameCount++;
    } else {
      this._signalPowerSum += linPower;
      this._signalFrameCount++;
    }

    // Clipping tespiti (event gruplama)
    if (isClipping) {
      this._clippedFrames++;
      if (!this._lastWasClipping) {
        this._clippingEvents++;
      }
    }
    this._lastWasClipping = isClipping;

    // Dropout tespiti — frame-rate bagimsiz zamanlama
    if (level < QUALITY.DROPOUT_LEVEL_THRESHOLD) {
      this._dropoutConsecutive++;
      if (this._dropoutConsecutive === QUALITY.DROPOUT_CONSECUTIVE_FRAMES) {
        this._dropoutEvents++;
      }
      if (this._dropoutConsecutive >= QUALITY.DROPOUT_CONSECUTIVE_FRAMES) {
        this._dropoutTotalMs += frameDeltaMs;
      }
    } else {
      this._dropoutConsecutive = 0;
    }

    // Zayif sinyal
    if (dbVal < QUALITY.WEAK_SIGNAL_DB) {
      this._weakSignalFrames++;
    }
  }

  // === PRIVATE: LUFS Measurement ===

  _startLUFSCapture() {
    if (this._lufsIntervalId || !this._analyserNode || !this._lufsCalculator) return;
    this._lufsCalculator.reset();
    // 100ms aralikla time domain verisini LUFS calculator'a besle
    this._lufsIntervalId = setInterval(() => this._captureLUFS(), 100);
  }

  _stopLUFSCapture() {
    if (this._lufsIntervalId) {
      clearInterval(this._lufsIntervalId);
      this._lufsIntervalId = null;
    }
  }

  _captureLUFS() {
    if (!this._analyserNode || !this._lufsTimeDomainData || !this._lufsCalculator) return;
    this._analyserNode.getFloatTimeDomainData(this._lufsTimeDomainData);
    this._lufsCalculator.process(this._lufsTimeDomainData);
  }

  // === PRIVATE: Frequency Analysis ===

  _startFrequencyCapture() {
    if (this._freqIntervalId || !this._analyserNode) return;
    this._freqIntervalId = setInterval(() => this._captureFrequency(), QUALITY.UPDATE_INTERVAL_MS);
  }

  _stopFrequencyCapture() {
    if (this._freqIntervalId) {
      clearInterval(this._freqIntervalId);
      this._freqIntervalId = null;
    }
  }

  _captureFrequency() {
    if (!this._analyserNode || !this._freqData) return;

    this._analyserNode.getFloatFrequencyData(this._freqData);
    const binCount = this._analyserNode.frequencyBinCount;
    const binWidth = this._sampleRate / (this._analyserNode.fftSize);

    // Bin-bazli frekans yanit biriktirme (lazy init)
    if (!this._freqBinSums) {
      this._freqBinSums = new Float32Array(binCount);
    }
    for (let i = 0; i < binCount; i++) {
      this._freqBinSums[i] += this._freqData[i]; // dBFS birikimi
    }

    const bands = QUALITY.FREQUENCY_BANDS;

    for (const [bandKey, [minHz, maxHz]] of Object.entries(bands)) {
      const startBin = Math.floor(minHz / binWidth);
      const endBin = Math.min(Math.floor(maxHz / binWidth), binCount - 1);
      let sum = 0;
      const count = endBin - startBin + 1;
      for (let i = startBin; i <= endBin; i++) {
        // A-agirlik duzeltmesi + dBFS → lineer magnitude
        const weightedDb = this._freqData[i] + (this._aWeightTable?.[i] ?? 0);
        const linMag = Math.pow(10, weightedDb / 20);
        sum += linMag;
      }
      // camelCase key mapping
      const key = bandKey === 'SUB_BASS' ? 'subBass'
        : bandKey === 'LOW_MID' ? 'lowMid'
        : bandKey === 'HIGH_MID' ? 'highMid'
        : 'presence';
      this._freqBandSums[key] += count > 0 ? sum / count : 0;
    }
    this._freqSnapshotCount++;
  }

  // === PRIVATE: Results Calculation ===

  _calculateResults(durationMs) {
    const n = this._totalFrames;
    if (n === 0) {
      return this._emptyResults(durationMs);
    }

    // Noise floor: en dusuk %10 dB degerlerinin ortalamasi
    const noiseFloorDb = this._calculateNoiseFloor();

    // Signal: ortalama dB
    const avgDb = this._dbSum / n;

    // SNR — guc orani tabanli (C3 fix)
    const avgSignalPower = this._signalFrameCount > 0 ? this._signalPowerSum / this._signalFrameCount : 0;
    const avgNoisePower = this._noiseFrameCount > 0 ? this._noisePowerSum / this._noiseFrameCount : 0;
    const snrDb = (avgNoisePower > 0 && avgSignalPower > 0)
      ? 10 * Math.log10(avgSignalPower / avgNoisePower)
      : null;

    // Dynamic range
    const dynamicRangeDb = this._dbMax - noiseFloorDb;

    // dB standart sapma (stabilite)
    const dbVariance = n > 1 ? this._dbM2 / (n - 1) : 0;
    const dbStdDev = Math.sqrt(Math.max(0, dbVariance));

    // Frekans dagitimi ortalamasi
    const freqProfile = this._freqSnapshotCount > 0
      ? {
          subBass: +(this._freqBandSums.subBass / this._freqSnapshotCount).toFixed(1),
          lowMid: +(this._freqBandSums.lowMid / this._freqSnapshotCount).toFixed(1),
          highMid: +(this._freqBandSums.highMid / this._freqSnapshotCount).toFixed(1),
          presence: +(this._freqBandSums.presence / this._freqSnapshotCount).toFixed(1),
          snapshotCount: this._freqSnapshotCount
        }
      : null;

    return {
      sampleCount: n,
      durationMs,
      level: {
        average: +(this._levelSum / n).toFixed(1),
        peak: +this._levelMax.toFixed(1),
        min: +this._levelMin.toFixed(1)
      },
      noiseFloor: {
        estimatedDb: +noiseFloorDb.toFixed(1),
        method: 'lowest-percentile-10-Aweighted'
      },
      snr: {
        estimatedDb: snrDb !== null ? +snrDb.toFixed(1) : null,
        signalDb: +avgDb.toFixed(1),
        noiseDb: +noiseFloorDb.toFixed(1),
        method: 'power-ratio'
      },
      dynamicRange: {
        db: +dynamicRangeDb.toFixed(1)
      },
      clipping: {
        rate: +(this._clippedFrames / n).toFixed(4),
        eventCount: this._clippingEvents,
        totalFrames: n,
        clippedFrames: this._clippedFrames
      },
      dropouts: {
        count: this._dropoutEvents,
        totalDurationMs: Math.round(this._dropoutTotalMs)
      },
      stability: {
        dbStdDev: +dbStdDev.toFixed(2)
      },
      lufs: this._lufsCalculator ? this._lufsCalculator.getResults() : null,
      frequencyResponse: this._freqBinSums && this._freqSnapshotCount > 0
        ? {
            bins: Array.from(this._freqBinSums).map(s => +(s / this._freqSnapshotCount).toFixed(1)),
            binWidth: +(this._sampleRate / (this._analyserNode?.fftSize || AUDIO.ANALYSIS_FFT_SIZE)).toFixed(2),
            sampleRate: this._sampleRate,
            fftSize: this._analyserNode?.fftSize || AUDIO.ANALYSIS_FFT_SIZE
          }
        : null,
      frequencyProfile: freqProfile,
      weakSignal: {
        frames: this._weakSignalFrames,
        rate: +(this._weakSignalFrames / n).toFixed(4)
      }
    };
  }

  _calculateNoiseFloor() {
    if (this._dbBufferFilled === 0) return -96;

    // Dolu olan kismi kopyala ve sirala
    const filled = this._dbBufferFilled;
    const sorted = new Float32Array(filled);
    for (let i = 0; i < filled; i++) {
      sorted[i] = this._dbBuffer[i];
    }
    sorted.sort();

    // En dusuk %10'un ortalamasi
    const percentileCount = Math.max(1, Math.floor(filled * QUALITY.NOISE_FLOOR_PERCENTILE / 100));
    let sum = 0;
    for (let i = 0; i < percentileCount; i++) {
      sum += sorted[i];
    }
    return sum / percentileCount;
  }

  _emptyResults(durationMs) {
    return {
      sampleCount: 0,
      durationMs,
      level: { average: 0, peak: 0, min: 0 },
      noiseFloor: { estimatedDb: -96, method: 'lowest-percentile-10' },
      snr: { estimatedDb: null, signalDb: -96, noiseDb: -96, method: 'power-ratio' },
      dynamicRange: { db: 0 },
      clipping: { rate: 0, eventCount: 0, totalFrames: 0, clippedFrames: 0 },
      dropouts: { count: 0, totalDurationMs: 0 },
      stability: { dbStdDev: 0 },
      lufs: null,
      frequencyResponse: null,
      frequencyProfile: null,
      weakSignal: { frames: 0, rate: 0 }
    };
  }

  /**
   * IEC 61672 A-agirlik egrisi (dB cinsinden)
   * @param {number} f - Frekans (Hz)
   * @returns {number} A-agirlik duzeltmesi (dB)
   */
  _aWeightDb(f) {
    const f2 = f * f;
    const f4 = f2 * f2;
    const num = 148693636 * f4;
    const d1 = f2 + 424.36;
    const d2 = f2 + 11599.29;
    const d3 = f2 + 544496.41;
    const d4 = f2 + 148693636;
    const denom = d1 * Math.sqrt(d2 * d3) * d4;
    if (denom === 0) return -Infinity;
    const ra = num / denom;
    return 20 * Math.log10(ra) + 2.0;
  }

  _reset() {
    this._lastResults = null;
    this._totalFrames = 0;
    this._clippedFrames = 0;
    this._clippingEvents = 0;
    this._lastWasClipping = false;
    this._dropoutEvents = 0;
    this._dropoutConsecutive = 0;
    this._dropoutTotalMs = 0;
    this._weakSignalFrames = 0;
    this._levelSum = 0;
    this._levelMin = 100;
    this._levelMax = 0;
    this._dbSum = 0;
    this._dbM2 = 0;
    this._dbMin = 0;
    this._dbMax = -96;
    this._dbBufferIndex = 0;
    this._dbBufferFilled = 0;
    this._signalPowerSum = 0;
    this._signalFrameCount = 0;
    this._noisePowerSum = 0;
    this._noiseFrameCount = 0;
    this._lastFrameTimestamp = 0;
    this._freqBandSums = { subBass: 0, lowMid: 0, highMid: 0, presence: 0 };
    this._freqSnapshotCount = 0;
    if (this._freqBinSums) this._freqBinSums.fill(0);
    if (this._lufsCalculator) this._lufsCalculator.reset();
    this._startTime = 0;
  }
}

// Singleton
const audioMetricsCollector = new AudioMetricsCollector();
export default audioMetricsCollector;
