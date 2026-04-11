/**
 * THDAnalyzer - Toplam Harmonik Bozulma (THD) Olcumu
 *
 * Frekans domain'inde fundamental ve harmonik pikleri tespit eder.
 * THD = sqrt(H2^2 + H3^2 + ... + HN^2) / H1
 *
 * Kullanim:
 *   const thd = new THDAnalyzer(analyserNode, sampleRate);
 *   const result = thd.analyze();
 *   // { thd: 0.023, thdPercent: 2.3, fundamental: 1000, harmonics: [...] }
 *
 * NOT: En dogru sonuc icin test tonu (OscillatorNode ile 1kHz sinusoidal)
 * kullanilmali. Gercek mikrofon sinyalinde harmonikler karmasik olabilir.
 */
export class THDAnalyzer {
  /**
   * @param {number} sampleRate - AudioContext sample rate
   * @param {number} fftSize - Kullanilacak FFT boyutu (buyuk = daha hassas)
   */
  constructor(sampleRate = 48000, fftSize = 2048) {
    this._sampleRate = sampleRate;
    this._fftSize = fftSize;
    this._binWidth = sampleRate / fftSize;
    this._maxHarmonics = 8; // Fundamental + 7 harmonik
  }

  /**
   * Float frequency data'dan THD hesapla
   * @param {Float32Array} freqData - getFloatFrequencyData sonucu (dBFS)
   * @returns {{ thd: number|null, thdPercent: number|null, fundamental: number|null, harmonics: Array }}
   */
  analyze(freqData) {
    if (!freqData || freqData.length === 0) {
      return { thd: null, thdPercent: null, fundamental: null, harmonics: [] };
    }

    // Fundamental frekansi bul (en yuksek pik)
    const fundamentalBin = this._findPeakBin(freqData, 1);
    if (fundamentalBin < 0) {
      return { thd: null, thdPercent: null, fundamental: null, harmonics: [] };
    }

    const fundamentalFreq = fundamentalBin * this._binWidth;
    const fundamentalMag = this._binToLinear(freqData[fundamentalBin]);

    if (fundamentalMag <= 0) {
      return { thd: null, thdPercent: null, fundamental: fundamentalFreq, harmonics: [] };
    }

    // Harmonikleri bul (H2, H3, ..., HN)
    const harmonics = [];
    let harmonicSumSq = 0;

    for (let n = 2; n <= this._maxHarmonics; n++) {
      const harmonicFreq = fundamentalFreq * n;
      const harmonicBin = Math.round(harmonicFreq / this._binWidth);

      if (harmonicBin >= freqData.length) break;

      // Pik arama: hedef bin +/- 2 cevresinde
      const peakBin = this._findPeakBinAround(freqData, harmonicBin, 2);
      const mag = this._binToLinear(freqData[peakBin]);

      harmonics.push({
        harmonic: n,
        frequency: +(peakBin * this._binWidth).toFixed(1),
        magnitudeDb: +freqData[peakBin].toFixed(1),
        magnitudeLinear: +mag.toFixed(6)
      });

      harmonicSumSq += mag * mag;
    }

    // THD = sqrt(sum(Hn^2)) / H1
    const thd = Math.sqrt(harmonicSumSq) / fundamentalMag;

    return {
      thd: +thd.toFixed(6),
      thdPercent: +(thd * 100).toFixed(2),
      fundamental: +fundamentalFreq.toFixed(1),
      fundamentalDb: +freqData[fundamentalBin].toFixed(1),
      harmonics
    };
  }

  /**
   * En yuksek pik bin'ini bul (belirli minimum frekans ustunde)
   * @param {Float32Array} freqData - dBFS verisi
   * @param {number} minBin - Baslangic bin (DC'yi atlamak icin)
   * @returns {number} - Pik bin indeksi
   */
  _findPeakBin(freqData, minBin = 1) {
    let maxVal = -Infinity;
    let maxBin = -1;
    for (let i = minBin; i < freqData.length; i++) {
      if (freqData[i] > maxVal) {
        maxVal = freqData[i];
        maxBin = i;
      }
    }
    return maxBin;
  }

  /**
   * Belirli bir bin cevresinde pik ara
   */
  _findPeakBinAround(freqData, centerBin, radius) {
    let maxVal = -Infinity;
    let maxBin = centerBin;
    const start = Math.max(1, centerBin - radius);
    const end = Math.min(freqData.length - 1, centerBin + radius);
    for (let i = start; i <= end; i++) {
      if (freqData[i] > maxVal) {
        maxVal = freqData[i];
        maxBin = i;
      }
    }
    return maxBin;
  }

  /**
   * dBFS → lineer magnitude
   */
  _binToLinear(dbfs) {
    if (dbfs <= -120) return 0;
    return Math.pow(10, dbfs / 20);
  }
}
