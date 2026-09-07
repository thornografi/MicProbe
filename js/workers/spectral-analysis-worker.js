/**
 * PCM and Spectral Analysis Worker (module worker)
 *
 * Kanal basina PCM metrikleri ve FFT gucu hesaplanir; kanal dalgalari downmix edilmez.
 * Spektrum kaydin enerji dagilimidir, mikrofonun frekans cevabi veya gurultusu degildir.
 * Agir DSP isi burada calisir; main thread bloklanmaz. "Analysing" progress bar'ini
 * besleyen gercek is budur (canli 250ms snapshot'tan daha dogru).
 *
 * Mesaj protokolu:
 *   IN:  { type:'analyze', runId, channels:ArrayBuffer[](Float32), sampleRate, fftSize, hopSize,
 *          outputBins, progressInterval, bands:{subBass,lowMid,highMid,presence} }
 *   OUT: { type:'progress', runId, ratio } | { type:'done', runId, result } | { type:'error', runId, reason }
 */

import { analyzePcm } from '../modules/utils/pcmAnalysis.js';

if (typeof self !== 'undefined') self.onmessage = function (e) {
  const msg = e.data;
  if (!msg || msg.type !== 'analyze') return;
  try {
    const result = analyze(msg, ratio => self.postMessage({ type: 'progress', runId: msg.runId, ratio }));
    self.postMessage({ type: 'done', runId: msg.runId, result });
  } catch (err) {
    self.postMessage({ type: 'error', runId: msg.runId, reason: err && err.message ? err.message : String(err) });
  }
};

/**
 * In-place iteratif radix-2 Cooley-Tukey FFT.
 * re/im uzunlugu 2'nin kuvveti olmali. Yerinde calisir (ek allokasyon yok).
 */
function fft(re, im) {
  const n = re.length;

  // Bit-reversal permutasyonu
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  // Kelebek (butterfly) asamalari
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wlr = Math.cos(ang);
    const wli = Math.sin(ang);
    const halfLen = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let k = 0; k < halfLen; k++) {
        const a = i + k;
        const b = a + halfLen;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const nwr = wr * wlr - wi * wli;
        wi = wr * wli + wi * wlr;
        wr = nwr;
      }
    }
  }
}

export function analyze(msg, onProgress = () => {}) {
  const channels = msg.channels.map(buffer => new Float32Array(buffer));
  const audioMetrics = analyzePcm(channels, msg.sampleRate, { guidedSegments: msg.guidedSegments });
  const sampleRate = msg.sampleRate;
  const fftSize = msg.fftSize;
  const hopSize = msg.hopSize;
  const outputBins = msg.outputBins || 96;
  const progressInterval = msg.progressInterval || 8;
  const bands = msg.bands || {};
  const n = channels[0].length;
  const half = fftSize >> 1;

  if (fftSize < 2 || (fftSize & (fftSize - 1)) !== 0) throw new Error('fftSize must be power of 2');
  if (n < fftSize) throw new Error('clip shorter than fftSize');
  if (!Number.isInteger(hopSize) || hopSize < 1 || outputBins < 2) throw new Error('Invalid spectral options');

  // Hann penceresi (bir kez)
  const win = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
  }

  // FFT calisma bufferlari (frame'ler arasi yeniden kullanilir)
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const powerSum = new Float64Array(half);

  const totalFrames = Math.floor((n - fftSize) / hopSize) + 1;
  let frame = 0;

  for (let start = 0; start + fftSize <= n; start += hopSize) {
    for (const samples of channels) {
      for (let i = 0; i < fftSize; i++) {
        re[i] = samples[start + i] * win[i];
        im[i] = 0;
      }
      fft(re, im);
      // Welch ortalamasi lineer kanal guclerinden; faz iptali olusmaz.
      for (let k = 0; k < half; k++) powerSum[k] += re[k] * re[k] + im[k] * im[k];
    }

    frame++;
    if (frame % progressInterval === 0) {
      onProgress(frame / totalFrames);
    }
  }

  // Ortalama guc / bin (Welch)
  const invFrames = 1 / (totalFrames * channels.length);
  const pAvg = new Float64Array(half);
  for (let k = 0; k < half; k++) pAvg[k] = powerSum[k] * invFrames;

  const binWidthHz = sampleRate / fftSize;
  const nyquist = sampleRate / 2;
  const fMax = Math.min(nyquist, 20000);
  const fMin = 20;

  const kMin = Math.max(1, Math.floor(fMin / binWidthHz));
  const kMax = Math.min(half - 1, Math.ceil(fMax / binWidthHz));

  // Referans: analiz bandindaki en yuksek guc -> goreli dB egrisi (tepe 0 dB)
  let refPower = 1e-30;
  for (let k = kMin; k <= kMax; k++) if (pAvg[k] > refPower) refPower = pAvg[k];
  const toDbRel = (p) => {
    if (refPower <= 1e-18) return -120;
    const db = 10 * Math.log10((p + 1e-30) / refPower);
    return db < -120 ? -120 : db;
  };

  // Log-spaced cikti egrisi (fMin..fMax)
  const step = Math.log(fMax / fMin) / (outputBins - 1);
  const binsOut = new Array(outputBins);
  for (let i = 0; i < outputBins; i++) {
    const f = fMin * Math.exp(step * i);
    // Aggregate the full log bucket in linear power. Picking one FFT bin can
    // omit a narrow tone that falls between two output frequencies.
    const lo = Math.max(1, Math.min(half - 1, Math.round(f * Math.exp(-step / 2) / binWidthHz)));
    const hi = Math.max(lo, Math.min(half - 1, Math.round(f * Math.exp(step / 2) / binWidthHz)));
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += pAvg[k];
    binsOut[i] = { hz: Math.round(f), db: +toDbRel(sum / (hi - lo + 1)).toFixed(1) };
  }

  // Band enerjileri (overall ortalama guce gore goreli dB: + vurgulu, - zayif)
  let overallSum = 0, overallCount = 0;
  for (let k = kMin; k <= kMax; k++) { overallSum += pAvg[k]; overallCount++; }
  const overallMean = overallSum / Math.max(1, overallCount);
  const bandDb = (range) => {
    if (!range || refPower <= 1e-18) return null;
    const lo = Math.max(kMin, Math.floor(range[0] / binWidthHz));
    const hi = Math.min(kMax, Math.ceil(range[1] / binWidthHz));
    if (hi < lo) return null;
    let s = 0, c = 0;
    for (let k = lo; k <= hi; k++) { s += pAvg[k]; c++; }
    const mean = s / Math.max(1, c);
    return +(10 * Math.log10((mean + 1e-30) / (overallMean + 1e-30))).toFixed(1);
  };
  const bandsOut = {
    subBass: bandDb(bands.subBass),
    lowMid: bandDb(bands.lowMid),
    highMid: bandDb(bands.highMid),
    presence: bandDb(bands.presence)
  };

  // Spektral duzluk (geometrik/aritmetik ortalama, 0..1 — beyaz gurultu ~1, tonal ~0)
  let lnSum = 0, arSum = 0, cnt = 0;
  for (let k = kMin; k <= kMax; k++) {
    const p = pAvg[k] + 1e-30;
    lnSum += Math.log(p);
    arSum += p;
    cnt++;
  }
  const geoMean = Math.exp(lnSum / Math.max(1, cnt));
  const arithMean = arSum / Math.max(1, cnt);
  const spectralFlatness = refPower > 1e-18 ? +(geoMean / (arithMean + 1e-30)).toFixed(4) : null;

  return {
    frequencyResponse: {
      bins: binsOut,
      binWidthHz: +binWidthHz.toFixed(2),
      fftSize,
      sampleRate,
      frameCount: totalFrames,
      channelCount: channels.length,
      method: 'welch-channel-power-average',
      unit: 'dB-relative-to-spectrum-peak'
    },
    bands: bandsOut,
    spectralFlatness,
    audioMetrics,
    lowLevelPercentileDb: audioMetrics.lowLevel.percentileDb,
    peakDb: audioMetrics.signal.peakDb,
    rmsDb: audioMetrics.signal.rmsDb
  };
}
