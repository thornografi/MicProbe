/**
 * Continuous PCM loudness: BS.1770 K weighting and gated 400 ms blocks at 100 ms
 * steps. EBU momentary/short-term windows are 400 ms/3 s. Channel powers are
 * summed, never waveform-downmixed. This is not a true-peak meter or a claim of
 * certified EBU compliance. Feed contiguous samples, not AnalyserNode snapshots.
 */
export class LUFSCalculator {
  constructor(sampleRate = 48000, channelCount = 1, channelWeights = null) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8000) throw new Error('Invalid sample rate');
    if (!Number.isInteger(channelCount) || channelCount < 1) throw new Error('Invalid channel count');
    // Without channel-layout metadata, surround/LFE weights cannot be inferred.
    if (channelCount > 2 && !channelWeights) throw new Error('Channel layout required for multichannel LUFS');
    this._weights = channelWeights || new Array(channelCount).fill(1);
    if (this._weights.length !== channelCount || this._weights.some(w => !Number.isFinite(w) || w < 0)) {
      throw new Error('Invalid channel weights');
    }
    this._sampleRate = sampleRate;
    this._channelCount = channelCount;
    this._momentarySize = Math.round(sampleRate * 0.4);
    this._shortTermSize = Math.round(sampleRate * 3);
    this._hopSize = Math.round(sampleRate * 0.1);
    this._initKWeightingCoeffs(sampleRate);
    this.reset();
  }

  _initKWeightingCoeffs(fs) {
    if (fs === 48000) {
      this._pf = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285,
        a1: -1.69065929318241, a2: 0.73248077421585 };
      this._rlb = { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 };
      return;
    }
    const k = Math.tan(Math.PI * 1681.974450955533 / fs);
    const q = 0.7071752369554196;
    const vh = 10 ** (3.999843853973347 / 20);
    const vb = vh ** 0.4996667741545416;
    const a0 = 1 + k / q + k * k;
    this._pf = {
      b0: (vh + vb * k / q + k * k) / a0, b1: 2 * (k * k - vh) / a0,
      b2: (vh - vb * k / q + k * k) / a0,
      a1: 2 * (k * k - 1) / a0, a2: (1 - k / q + k * k) / a0
    };
    const r = Math.tan(Math.PI * 38.13547087602444 / fs);
    const rq = 0.5003270373238773;
    const r0 = 1 + r / rq + r * r;
    // RLB numerator intentionally has unity coefficients (BS.1770 table 2).
    this._rlb = { b0: 1, b1: -2, b2: 1,
      a1: 2 * (r * r - 1) / r0, a2: (1 - r / rq + r * r) / r0 };
  }

  _biquad(sample, coeffs, state) {
    const out = coeffs.b0 * sample + coeffs.b1 * state.x1 + coeffs.b2 * state.x2
      - coeffs.a1 * state.y1 - coeffs.a2 * state.y2;
    state.x2 = state.x1; state.x1 = sample;
    state.y2 = state.y1; state.y1 = out;
    return out;
  }

  /** Mono Float32Array or an array of equally sized, ordered channel buffers. */
  process(input) {
    const channels = Array.isArray(input) ? input : [input];
    const length = channels[0]?.length;
    if (channels.length !== this._channelCount || channels.some(c => c.length !== length)) {
      throw new Error('PCM channel lengths/count do not match');
    }
    for (let i = 0; i < length; i++) {
      let power = 0;
      for (let ch = 0; ch < channels.length; ch++) {
        const sample = channels[ch][i];
        if (!Number.isFinite(sample)) throw new Error('Non-finite PCM sample');
        const state = this._states[ch];
        const filtered = this._biquad(this._biquad(sample, this._pf, state.pre), this._rlb, state.rlb);
        power += this._weights[ch] * filtered * filtered;
      }
      const index = this._sampleCount % this._shortTermSize;
      const oldMomentary = this._sampleCount >= this._momentarySize
        ? this._powers[(this._sampleCount - this._momentarySize) % this._shortTermSize] : 0;
      this._momentarySum += power - oldMomentary;
      this._shortTermSum += power - this._powers[index];
      this._powers[index] = power;
      this._sampleCount++;
      if (this._sampleCount >= this._momentarySize
        && (this._sampleCount - this._momentarySize) % this._hopSize === 0) {
        this._momentaryPower = Math.max(0, this._momentarySum) / this._momentarySize;
        this._blockPowers.push(this._momentaryPower);
      }
      if (this._sampleCount >= this._shortTermSize
        && (this._sampleCount - this._shortTermSize) % this._hopSize === 0) {
        this._shortTermPower = Math.max(0, this._shortTermSum) / this._shortTermSize;
      }
    }
  }

  _calculateIntegrated() {
    const aboveAbsolute = this._blockPowers.filter(p => p > 10 ** ((-70 + 0.691) / 10));
    if (!aboveAbsolute.length) return null;
    const relativeGate = aboveAbsolute.reduce((sum, p) => sum + p, 0) / aboveAbsolute.length / 10;
    const gated = aboveAbsolute.filter(p => p > relativeGate);
    return this._toLufs(gated.reduce((sum, p) => sum + p, 0) / gated.length);
  }

  _toLufs(power) {
    return power > 1e-18 ? +(-0.691 + 10 * Math.log10(power)).toFixed(2) : null;
  }

  getResults() {
    const integrated = this._calculateIntegrated();
    return {
      status: this._blockPowers.length ? 'measured' : 'unavailable',
      integrated, momentary: this._toLufs(this._momentaryPower), shortTerm: this._toLufs(this._shortTermPower),
      integratedStatus: integrated === null ? (this._blockPowers.length ? 'below-gate' : 'too-short') : 'measured',
      method: 'ITU-R-BS.1770', blockCount: this._blockPowers.length,
      windowMs: 400, hopMs: 100, shortTermWindowMs: 3000,
      analyzedSamples: this._sampleCount, channelCount: this._channelCount
    };
  }

  reset() {
    const state = () => ({ x1: 0, x2: 0, y1: 0, y2: 0 });
    this._states = Array.from({ length: this._channelCount }, () => ({ pre: state(), rlb: state() }));
    this._powers = new Float64Array(this._shortTermSize);
    this._sampleCount = 0;
    this._momentarySum = 0; this._shortTermSum = 0;
    this._momentaryPower = 0; this._shortTermPower = 0;
    this._blockPowers = [];
  }
}
