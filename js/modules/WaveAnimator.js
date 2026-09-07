/**
 * WaveAnimator - Hero section ses dalgasi visualizer
 *
 * Dikey cubuklar (bars) ile STATIK ses dalgasi.
 * Ekranin tamamina yayilir, kenarlarda ve merkezde (mikrofon) fade olur.
 *
 * Yukseklik = dalga seviyesi (dort sinus + noise) x merkez zarfi.
 * Zarf kenarda en yuksek, mikrofona dogru sabit egimle kuculur ("huni", merkezde
 * birlesme). Buyuk resmin zarfi izlemesi icin: vadiler sigirlastirilir (troughDepth)
 * ve lob tepeleri ortak seviyeye cekilir (peakRegularity); yerel doku/gurultu kalir.
 */

class WaveAnimator {
  constructor(svgSelector, config = {}) {
    this.svg = document.querySelector(svgSelector);
    if (!this.svg) return;

    // Config with defaults
    this.config = {
      // Cubuk sayisi - ekrani kaplamak icin daha fazla
      barCount: config.barCount || 200,

      // ViewBox dimensions
      width: config.width || 1600,
      height: config.height || 300,

      // Cubuk boyutlari
      barWidth: config.barWidth || 2.5,
      barGap: config.barGap || 3,
      minBarHeight: config.minBarHeight || 6,
      maxBarHeight: config.maxBarHeight || 120,

      // Dalga bilesenleri: sol ve sag taraf bagimsiz (ayni karmasiklik, farkli pattern)
      // frequencies: genislik basina dongu; phases: radyan. Agirliklar sabit (WAVE_WEIGHTS).
      waveLeft: config.waveLeft || { frequencies: [1.8, 4.3, 7.1, 11.7], phases: [0, 0.7, 1.4, 2.1] },
      waveRight: config.waveRight || { frequencies: [2.3, 5.1, 8.7, 13.2], phases: [0.8, 2.1, 0.3, 1.5] },

      // Modulasyon derinligi: 1 = orijinal, >1 tepeler daha yuksek, vadiler daha derin (uzaktan belirgin girinti/cikinti)
      modulationDepth: config.modulationDepth || 1,

      // Vadi derinligi: 1 = orijinal, <1 negatif sapmalar (vadiler) sigirlasir; tepeler degismez.
      // Merkezden kenara dogrusal karisim (merkezde troughDepthCenter, kenarda troughDepthEdge)
      troughDepthCenter: config.troughDepthCenter ?? 1,
      troughDepthEdge: config.troughDepthEdge ?? config.troughDepthCenter ?? 1,

      // Lob tepelerini ortak seviyeye cekme (0 = kapali, 1 = tepeler tamamen zarfi izler)
      peakRegularity: config.peakRegularity ?? 0,
      peakRegularityWindow: config.peakRegularityWindow || 12, // Yerel tepe penceresi (bar)

      // Merkez bosluk (mikrofon ikonu icin)
      centerGap: config.centerGap || 0.12, // Merkezin %12'si bos
      centerFadeZone: config.centerFadeZone || 0.08, // Boslugun etrafinda fade

      // Kenar fade - yeni sistem
      edgeFadeStart: config.edgeFadeStart || 0.30, // Opacity azalmaya baslar
      edgeFadeEnd: config.edgeFadeEnd || 0.10,     // Tamamen seffaf

      // Merkez yukseklik azaltma (dugum efekti / huni)
      centerHeightMin: config.centerHeightMin || 0.35, // Merkezde min yukseklik orani
      centerHeightEasing: config.centerHeightEasing || 0.6, // Gecis yumusakligi (1 = dogrusal)
    };

    this.bars = [];
    this.init();
  }

  init() {
    // SVG viewBox'i ayarla
    this.svg.setAttribute('viewBox', `0 0 ${this.config.width} ${this.config.height}`);

    // Mevcut icerigi temizle
    const existingGroup = this.svg.querySelector('.wave-bars-group');
    if (existingGroup) {
      existingGroup.remove();
    }

    // Yeni grup olustur
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'wave-bars-group');

    // Cubuklari tum ekrana yay ve ORTALA
    const totalBarWidth = this.config.barWidth + this.config.barGap;
    const totalWidth = this.config.barCount * totalBarWidth;
    const startX = (this.config.width - totalWidth) / 2; // Merkeze al

    // Cubuklari olustur ve statik pozisyonla
    const centerY = this.config.height / 2;
    const { minBarHeight, maxBarHeight, barCount } = this.config;
    const heightRange = maxBarHeight - minBarHeight;

    // 1. gecis: her bar icin normalize X, opacity ve dalga seviyesi (0-1)
    const normalizedXs = [];
    const opacities = [];
    const levels = [];
    for (let i = 0; i < barCount; i++) {
      const x = startX + i * totalBarWidth;
      // normalizedX: bar'in gercek X pozisyonuna gore (viewBox koordinatlari)
      const normalizedX = (x + this.config.barWidth / 2) / this.config.width; // 0-1 arasi
      normalizedXs.push(normalizedX);
      opacities.push(this.calculateOpacity(normalizedX));
      levels.push(this.calculateWaveLevel(normalizedX, i));
    }

    // 2. gecis: lob tepelerini ortak seviyeye cek -> yukseklikler zarfi (huniyi) izler
    const shapedLevels = this.regularizePeaks(levels, opacities);

    for (let i = 0; i < barCount; i++) {
      const opacity = opacities[i];

      // Cok dusuk opacity'li bar'lari atla (performans)
      if (opacity < 0.02) continue;

      const x = startX + i * totalBarWidth;
      const normalizedX = normalizedXs[i];

      // Yukseklik = seviye x merkez zarfi
      const height = minBarHeight + shapedLevels[i] * heightRange * this.centerHeightMultiplier(normalizedX);
      const y = centerY - height / 2;

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width', this.config.barWidth);
      rect.setAttribute('height', height);
      rect.setAttribute('rx', this.config.barWidth / 2);
      rect.setAttribute('ry', this.config.barWidth / 2);
      rect.setAttribute('fill', 'url(#hero-bar-gradient)');
      rect.setAttribute('opacity', opacity);

      this.bars.push(rect);
      group.appendChild(rect);
    }

    this.svg.appendChild(group);
  }

  /**
   * Opacity hesapla - kenarlar ve merkez icin fade
   */
  calculateOpacity(normalizedX) {
    const { edgeFadeStart, edgeFadeEnd, centerGap, centerFadeZone } = this.config;

    // Kenar fade (sol ve sag) - yavas gecis
    let edgeOpacity = 1;

    // Sol kenar
    if (normalizedX < edgeFadeStart) {
      if (normalizedX < edgeFadeEnd) {
        // Tamamen seffaf
        edgeOpacity = 0;
      } else {
        // Yavas fade (edgeFadeEnd -> edgeFadeStart arasi)
        edgeOpacity = (normalizedX - edgeFadeEnd) / (edgeFadeStart - edgeFadeEnd);
      }
    }
    // Sag kenar
    else if (normalizedX > 1 - edgeFadeStart) {
      if (normalizedX > 1 - edgeFadeEnd) {
        // Tamamen seffaf
        edgeOpacity = 0;
      } else {
        // Yavas fade
        edgeOpacity = (1 - normalizedX - edgeFadeEnd) / (edgeFadeStart - edgeFadeEnd);
      }
    }

    // Merkez fade (mikrofon ikonu icin bosluk)
    let centerOpacity = 1;
    const distFromCenter = Math.abs(normalizedX - 0.5);
    const halfGap = centerGap / 2;

    if (distFromCenter < halfGap) {
      // Tam merkez - tamamen seffaf
      centerOpacity = 0;
    } else if (distFromCenter < halfGap + centerFadeZone) {
      // Fade zone - smoothstep: mikrofona yaklastikca yavasca gozden kaybolma
      const t = (distFromCenter - halfGap) / centerFadeZone;
      centerOpacity = t * t * (3 - 2 * t);
    }

    // Her iki opacity'yi carp
    return edgeOpacity * centerOpacity;
  }

  /**
   * Merkez yukseklik multiplier - kenarlarda yuksek, merkeze dogru azalan (huni)
   * Mikrofon ikonunda "dugum" / birlesme efekti yaratir
   */
  centerHeightMultiplier(normalizedX) {
    const { centerHeightMin, centerHeightEasing } = this.config;

    // Merkezden uzaklik (0 = merkez, 1 = kenarlar)
    const distFromCenter = Math.abs(normalizedX - 0.5) * 2;

    // Yumusak gecis icin easing uygula
    const eased = Math.pow(distFromCenter, centerHeightEasing);

    // Kenarlarda 1.0, merkezde centerHeightMin
    return centerHeightMin + (1 - centerHeightMin) * eased;
  }

  /**
   * Lob tepelerini ortak bir seviyeye dogru ceker; boylece yukseklikler buyuk resimde
   * zarfi izler (kenardan merkeze duzenli kuculme). Vadiler ve cubuk dokusu korunur.
   */
  regularizePeaks(levels, opacities) {
    const { peakRegularity, peakRegularityWindow: W } = this.config;
    if (!(peakRegularity > 0)) return levels;

    const n = levels.length;
    const boxBlur = (arr) => arr.map((_, i) => {
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) { sum += arr[j]; count++; }
      return sum / count;
    });

    // Yerel tepe seviyesi: pencere ici maksimum, iki kez yumusatilmis
    const localPeak = levels.map((_, i) => {
      let max = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) max = Math.max(max, levels[j]);
      return max;
    });
    const smoothPeak = boxBlur(boxBlur(localPeak));

    // Hedef: gorunur bolgedeki en yuksek yerel tepe (genlik korunur, digerleri yukari cekilir)
    const target = Math.max(...smoothPeak.filter((_, i) => opacities[i] > 0.3));

    return levels.map((level, i) => {
      const gain = 1 + (target / smoothPeak[i] - 1) * peakRegularity;
      return Math.min(1, level * gain);
    });
  }

  /**
   * Pseudo-random noise (deterministic, seed-based)
   * Farkli seed'ler farkli pattern uretir
   */
  noise(x, seed = 0) {
    const n = Math.sin((x + seed) * 127.1 + 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  /**
   * Statik dalga seviyesi (0-1) - dogal ses sinyali
   * Sol ve sag taraf BAGIMSIZ hesaplanir (ayni karmasiklik, farkli pattern)
   */
  calculateWaveLevel(normalizedX, barIndex) {
    const { waveLeft, waveRight, modulationDepth, troughDepthCenter, troughDepthEdge } = this.config;

    // Taraf secimi; sag taraf kendi 0-0.5 ekseninde hesaplanir
    const isRightSide = normalizedX > 0.5;
    const wave = isRightSide ? waveRight : waveLeft;
    const rx = isRightSide ? normalizedX - 0.5 : normalizedX;

    // Dort sinus bileseni (agirliklar: ana dalga -> ince detay)
    let combined = 0;
    for (let k = 0; k < WAVE_WEIGHTS.length; k++) {
      combined += Math.sin(rx * wave.frequencies[k] * Math.PI * 2 + wave.phases[k]) * WAVE_WEIGHTS[k];
    }

    // Her bar icin benzersiz noise (barIndex kullanarak)
    combined += (this.noise(normalizedX * 50, barIndex * 0.1) - 0.5) * 0.10;
    combined += (this.noise(barIndex * 7.3 + normalizedX * 30) - 0.5) * 0.06;

    // Modulasyon derinligi: sapmalari buyut (tepeler yukari, vadiler asagi)
    combined *= modulationDepth;

    // Vadi sikistirma: yalnizca negatif sapmalar carpilir (tepeler degismez)
    if (combined < 0) {
      const distFromCenter = Math.abs(normalizedX - 0.5) * 2;
      combined *= troughDepthCenter + (troughDepthEdge - troughDepthCenter) * distFromCenter;
    }

    // Normalize (0-1)
    return Math.max(0.1, Math.min(1, (combined + 1) / 2));
  }

  // No-op: initWaveAnimator() yeni instance oncesi stop() cagirir, bos metod yeterli
  start() {}
  stop() {}
  updateConfig(newConfig) {
    Object.assign(this.config, newConfig);
  }
}

// Sinus bilesenlerinin agirliklari: ana dalga, ikincil, ucuncul, ince detay
const WAVE_WEIGHTS = [0.35, 0.25, 0.2, 0.12];

// Singleton export for easy use
let waveAnimatorInstance = null;

export function initWaveAnimator(svgSelector = '.hero-soundwave', config = {}) {
  if (waveAnimatorInstance) {
    waveAnimatorInstance.stop();
  }
  waveAnimatorInstance = new WaveAnimator(svgSelector, config);
  return waveAnimatorInstance;
}

export default WaveAnimator;
