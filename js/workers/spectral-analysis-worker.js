/**
 * Spectral Analysis Worker (classic worker)
 *
 * Ham PCM (mono Float32) uzerinde yuksek cozunurluklu pencereli FFT (Welch ortalamasi)
 * uygular; frekans yaniti, band enerjileri, spektral duzluk, noise floor ve peak/rms uretir.
 * Agir DSP isi burada calisir; main thread bloklanmaz. "Analysing" progress bar'ini
 * besleyen gercek is budur (canli 250ms snapshot'tan daha dogru).
 *
 * Mesaj protokolu:
 *   IN:  { type:'analyze', pcm:ArrayBuffer(Float32), sampleRate, fftSize, hopSize,
 *          outputBins, progressInterval, bands:{subBass,lowMid,highMid,presence} }
 *   OUT: { type:'progress', ratio }  |  { type:'done', result }  |  { type:'error', reason }
 */

self.onmessage = function (e) {
  const msg = e.data;
  if (!msg || msg.type !== 'analyze') return;
  try {
    const result = analyze(msg);
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', reason: err && err.message ? err.message : String(err) });
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

function analyze(msg) {
  const samples = new Float32Array(msg.pcm);
  const sampleRate = msg.sampleRate;
  const fftSize = msg.fftSize;
  const hopSize = msg.hopSize;
  const outputBins = msg.outputBins || 96;
  const progressInterval = msg.progressInterval || 8;
  const bands = msg.bands || {};
  const n = samples.length;
  const half = fftSize >> 1;

  if (fftSize < 2 || (fftSize & (fftSize - 1)) !== 0) throw new Error('fftSize must be power of 2');
  if (n < fftSize) throw new Error('clip shorter than fftSize');

  // Hann penceresi (bir kez)
  const win = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
  }

  // FFT calisma bufferlari (frame'ler arasi yeniden kullanilir)
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const powerSum = new Float64Array(half);
  const frameRmsDb = [];

  const totalFrames = Math.floor((n - fftSize) / hopSize) + 1;
  let frame = 0;

  for (let start = 0; start + fftSize <= n; start += hopSize) {
    // Ham frame RMS (noise floor icin — pencere UYGULANMADAN)
    let sq = 0;
    for (let i = 0; i < fftSize; i++) {
      const s = samples[start + i];
      sq += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    const rms = Math.sqrt(sq / fftSize);
    frameRmsDb.push(rms > 1e-9 ? 20 * Math.log10(rms) : -180);

    fft(re, im);

    // Guc spektrumu biriktir (yalniz [0, Nyquist))
    for (let k = 0; k < half; k++) {
      powerSum[k] += re[k] * re[k] + im[k] * im[k];
    }

    frame++;
    if (frame % progressInterval === 0) {
      self.postMessage({ type: 'progress', ratio: frame / totalFrames });
    }
  }

  // Ortalama guc / bin (Welch)
  const invFrames = 1 / totalFrames;
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
    const db = 10 * Math.log10((p + 1e-30) / refPower);
    return db < -120 ? -120 : db;
  };

  // Log-spaced cikti egrisi (fMin..fMax)
  const step = Math.log(fMax / fMin) / (outputBins - 1);
  const binsOut = new Array(outputBins);
  for (let i = 0; i < outputBins; i++) {
    const f = fMin * Math.exp(step * i);
    let k = Math.round(f / binWidthHz);
    if (k < 1) k = 1;
    if (k > half - 1) k = half - 1;
    binsOut[i] = { hz: Math.round(f), db: +toDbRel(pAvg[k]).toFixed(1) };
  }

  // Band enerjileri (overall ortalama guce gore goreli dB: + vurgulu, - zayif)
  let overallSum = 0, overallCount = 0;
  for (let k = kMin; k <= kMax; k++) { overallSum += pAvg[k]; overallCount++; }
  const overallMean = overallSum / Math.max(1, overallCount);
  const bandDb = (range) => {
    if (!range) return null;
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
  const spectralFlatness = +(geoMean / (arithMean + 1e-30)).toFixed(4);

  // Noise floor: frame RMS dB dagiliminin 10. persentili
  const sorted = frameRmsDb.slice().sort((a, b) => a - b);
  const p10 = sorted.length ? sorted[Math.floor(sorted.length * 0.10)] : -180;

  // Overall peak / rms (tum sinyal)
  let totalSq = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    totalSq += s * s;
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
  }
  const overallRms = Math.sqrt(totalSq / n);

  return {
    frequencyResponse: {
      bins: binsOut,
      binWidthHz: +binWidthHz.toFixed(2),
      fftSize,
      sampleRate,
      frameCount: totalFrames
    },
    bands: bandsOut,
    spectralFlatness,
    noiseFloorDb: +p10.toFixed(1),
    peakDb: +(peak > 1e-9 ? 20 * Math.log10(peak) : -180).toFixed(1),
    rmsDb: +(overallRms > 1e-9 ? 20 * Math.log10(overallRms) : -180).toFixed(1)
  };
}
