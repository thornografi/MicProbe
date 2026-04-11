/**
 * LUFSCalculator - ITU-R BS.1770 loudness olcumu
 *
 * K-agirlik filtresi (pre-filter + RLB weighting) uygulayarak
 * momentary (400ms), short-term (3s) ve integrated LUFS hesaplar.
 *
 * Kullanim:
 *   const calc = new LUFSCalculator(48000);
 *   calc.process(float32Array);  // 100ms aralikla besle
 *   const result = calc.getResults();
 */

export class LUFSCalculator {
  /**
   * @param {number} sampleRate - AudioContext sample rate
   */
  constructor(sampleRate = 48000) {
    this._sampleRate = sampleRate;

    // K-agirlik filtre katsayilari (ITU-R BS.1770-4)
    this._initKWeightingCoeffs(sampleRate);

    // Filtre state (biquad)
    this._preFilterState = { x1: 0, x2: 0, y1: 0, y2: 0 };
    this._rlbFilterState = { x1: 0, x2: 0, y1: 0, y2: 0 };

    // 400ms pencere (momentary) — overlap'siz bloklar
    this._blockSize400ms = Math.round(sampleRate * 0.4);
    this._blockBuffer = new Float32Array(this._blockSize400ms);
    this._blockIndex = 0;

    // Gating blok gucleri (integrated LUFS icin)
    this._blockPowers = [];

    // Short-term: son 3s'lik bloklar (3s / 0.4s = 7.5 → 8 blok)
    this._shortTermBlockCount = Math.ceil(3.0 / 0.4);

    // Son hesaplanan degerler
    this._momentaryLUFS = -Infinity;
    this._shortTermLUFS = -Infinity;
  }

  /**
   * K-agirlik filtre katsayilarini hesapla
   * Stage 1: Pre-filter (shelf boost ~+4dB > 1.5kHz)
   * Stage 2: RLB (revised low-frequency B-curve, high-pass ~60Hz)
   */
  _initKWeightingCoeffs(fs) {
    // Stage 1: Pre-filter (high-shelf)
    // ITU-R BS.1770-4 tablo katsayilari (48kHz icin optimize, diger fs'ler icin bilinear transform)
    if (fs === 48000) {
      this._pf = {
        b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285,
        a1: -1.69065929318241, a2: 0.73248077421585
      };
      this._rlb = {
        b0: 1.0, b1: -2.0, b2: 1.0,
        a1: -1.99004745483398, a2: 0.99007225036621
      };
    } else {
      // Genel bilinear transform (yaklasik)
      this._pf = this._computePreFilter(fs);
      this._rlb = this._computeRLBFilter(fs);
    }
  }

  /**
   * Pre-filter katsayilari (bilinear transform)
   */
  _computePreFilter(fs) {
    const db = 3.999843853973347;
    const f0 = 1681.974450955533;
    const Q = 0.7071752369554196;
    const K = Math.tan(Math.PI * f0 / fs);
    const Vh = Math.pow(10, db / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    const a0_ = 1 + K / Q + K * K;
    return {
      b0: (Vh + Vb * K / Q + K * K) / a0_,
      b1: 2 * (K * K - Vh) / a0_,
      b2: (Vh - Vb * K / Q + K * K) / a0_,
      a1: 2 * (K * K - 1) / a0_,
      a2: (1 - K / Q + K * K) / a0_
    };
  }

  /**
   * RLB high-pass katsayilari (bilinear transform)
   */
  _computeRLBFilter(fs) {
    const f0 = 38.13547087602444;
    const Q = 0.5003270373238773;
    const K = Math.tan(Math.PI * f0 / fs);
    const a0_ = 1 + K / Q + K * K;
    return {
      b0: 1 / a0_,
      b1: -2 / a0_,
      b2: 1 / a0_,
      a1: 2 * (K * K - 1) / a0_,
      a2: (1 - K / Q + K * K) / a0_
    };
  }

  /**
   * Biquad filtre uygula (Direct Form I)
   */
  _biquad(sample, coeffs, state) {
    const out = coeffs.b0 * sample + coeffs.b1 * state.x1 + coeffs.b2 * state.x2
      - coeffs.a1 * state.y1 - coeffs.a2 * state.y2;
    state.x2 = state.x1;
    state.x1 = sample;
    state.y2 = state.y1;
    state.y1 = out;
    return out;
  }

  /**
   * Float32Array PCM verisini isle
   * @param {Float32Array} samples - Raw PCM [-1,1]
   */
  process(samples) {
    for (let i = 0; i < samples.length; i++) {
      // K-agirlik: Stage 1 (pre-filter) → Stage 2 (RLB)
      const preFiltered = this._biquad(samples[i], this._pf, this._preFilterState);
      const kWeighted = this._biquad(preFiltered, this._rlb, this._rlbFilterState);

      this._blockBuffer[this._blockIndex] = kWeighted;
      this._blockIndex++;

      // 400ms blok doldu
      if (this._blockIndex >= this._blockSize400ms) {
        this._processBlock();
        this._blockIndex = 0;
      }
    }
  }

  /**
   * 400ms blok gucunu hesapla
   */
  _processBlock() {
    let sumSq = 0;
    for (let i = 0; i < this._blockSize400ms; i++) {
      sumSq += this._blockBuffer[i] * this._blockBuffer[i];
    }
    const meanPower = sumSq / this._blockSize400ms;

    // Momentary LUFS (son 400ms blok)
    this._momentaryLUFS = meanPower > 0 ? -0.691 + 10 * Math.log10(meanPower) : -Infinity;

    // Blok gucunu sakla (gating icin)
    this._blockPowers.push(meanPower);

    // Short-term LUFS (son 3s = son N blok)
    const stStart = Math.max(0, this._blockPowers.length - this._shortTermBlockCount);
    const stBlocks = this._blockPowers.slice(stStart);
    if (stBlocks.length > 0) {
      const stMean = stBlocks.reduce((s, p) => s + p, 0) / stBlocks.length;
      this._shortTermLUFS = stMean > 0 ? -0.691 + 10 * Math.log10(stMean) : -Infinity;
    }
  }

  /**
   * Integrated LUFS hesapla (ITU-R BS.1770 gating)
   * Absolute gate: -70 LUFS, Relative gate: -10 dB from ungated mean
   */
  _calculateIntegrated() {
    if (this._blockPowers.length === 0) return -Infinity;

    // Absolute gate (-70 LUFS → lineer threshold)
    const absThreshold = Math.pow(10, (-70 + 0.691) / 10);
    const aboveAbs = this._blockPowers.filter(p => p > absThreshold);
    if (aboveAbs.length === 0) return -Infinity;

    // Ungated mean
    const ungatedMean = aboveAbs.reduce((s, p) => s + p, 0) / aboveAbs.length;

    // Relative gate (-10 dB below ungated mean)
    const relThreshold = ungatedMean * Math.pow(10, -10 / 10);
    const aboveRel = aboveAbs.filter(p => p > relThreshold);
    if (aboveRel.length === 0) return -Infinity;

    const gatedMean = aboveRel.reduce((s, p) => s + p, 0) / aboveRel.length;
    return -0.691 + 10 * Math.log10(gatedMean);
  }

  /**
   * Sonuclari dondur
   * @returns {{ integrated: number, momentary: number, shortTerm: number }}
   */
  getResults() {
    return {
      integrated: +this._calculateIntegrated().toFixed(1),
      momentary: +this._momentaryLUFS.toFixed(1),
      shortTerm: +this._shortTermLUFS.toFixed(1)
    };
  }

  /**
   * State'i sifirla
   */
  reset() {
    this._preFilterState = { x1: 0, x2: 0, y1: 0, y2: 0 };
    this._rlbFilterState = { x1: 0, x2: 0, y1: 0, y2: 0 };
    this._blockBuffer.fill(0);
    this._blockIndex = 0;
    this._blockPowers = [];
    this._momentaryLUFS = -Infinity;
    this._shortTermLUFS = -Infinity;
  }
}
