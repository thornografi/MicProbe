/**
 * WaveAnimator - Hero section ses dalgasi visualizer
 *
 * Dikey cubuklar (bars) ile STATIK ses dalgasi.
 * Ekranin tamamina yayilir, kenarlarda ve merkezde (mikrofon) fade olur.
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

      // Wave parametreleri (dogal ses sinyali icin)
      waveFrequency: config.waveFrequency || 1.8,
      secondaryFrequency: config.secondaryFrequency || 4.3,
      tertiaryFrequency: config.tertiaryFrequency || 7.1,
      quaternaryFrequency: config.quaternaryFrequency || 11.7,

      // Merkez bosluk (mikrofon ikonu icin)
      centerGap: config.centerGap || 0.12, // Merkezin %12'si bos
      centerFadeZone: config.centerFadeZone || 0.08, // Boslugun etrafinda fade

      // Kenar fade - yeni sistem
      edgeFadeStart: config.edgeFadeStart || 0.30, // Opacity azalmaya baslar
      edgeFadeEnd: config.edgeFadeEnd || 0.10,     // Tamamen seffaf

      // Merkez yukseklik azaltma (dugum efekti)
      centerHeightMin: config.centerHeightMin || 0.35, // Merkezde min yukseklik orani
      centerHeightEasing: config.centerHeightEasing || 0.6, // Gecis yumusakligi
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

    for (let i = 0; i < this.config.barCount; i++) {
      const x = startX + i * totalBarWidth;
      // normalizedX: bar'in gercek X pozisyonuna gore (viewBox koordinatlari)
      const barCenterX = x + this.config.barWidth / 2;
      const normalizedX = barCenterX / this.config.width; // 0-1 arasi

      // Opacity hesapla (kenar + merkez fade)
      const opacity = this.calculateOpacity(normalizedX);

      // Cok dusuk opacity'li bar'lari atla (performans)
      if (opacity < 0.02) continue;

      // Yukseklik hesapla (barIndex ile asimetrik pattern)
      const height = this.calculateBarHeight(normalizedX, i);
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
      // Fade zone - yumusak gecis
      centerOpacity = (distFromCenter - halfGap) / centerFadeZone;
    }

    // Her iki opacity'yi carp
    return edgeOpacity * centerOpacity;
  }

  /**
   * Merkez yukseklik multiplier - kenarlarda yuksek, merkeze dogru azalan
   * Mikrofon ikonunda "dugum" efekti yaratir
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
   * Pseudo-random noise (deterministic, seed-based)
   * Farkli seed'ler farkli pattern uretir
   */
  noise(x, seed = 0) {
    const n = Math.sin((x + seed) * 127.1 + 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  /**
   * Statik dalga yuksekligi hesapla - dogal ses sinyali
   * Sol ve sag taraf BAGIMSIZ hesaplanir (ayni karmasiklik, farkli pattern)
   */
  calculateBarHeight(normalizedX, barIndex) {
    const { waveFrequency, secondaryFrequency, tertiaryFrequency, quaternaryFrequency,
            minBarHeight, maxBarHeight } = this.config;

    const isRightSide = normalizedX > 0.5;

    // Sol ve sag taraf icin TAMAMEN FARKLI frekanslar
    // Ayni karmasiklik seviyesinde ama farkli pattern
    let primary, secondary, tertiary, quaternary;

    if (!isRightSide) {
      // SOL TARAF - orijinal frekanslar
      primary = Math.sin(normalizedX * waveFrequency * Math.PI * 2) * 0.35;
      secondary = Math.sin(normalizedX * secondaryFrequency * Math.PI * 2 + 0.7) * 0.25;
      tertiary = Math.sin(normalizedX * tertiaryFrequency * Math.PI * 2 + 1.4) * 0.2;
      quaternary = Math.sin(normalizedX * quaternaryFrequency * Math.PI * 2 + 2.1) * 0.12;
    } else {
      // SAG TARAF - farkli frekanslar ve phase (ayni karmasiklik)
      const rx = normalizedX - 0.5; // Sag taraf icin normalize (0-0.5)
      primary = Math.sin(rx * 2.3 * Math.PI * 2 + 0.8) * 0.35;
      secondary = Math.sin(rx * 5.1 * Math.PI * 2 + 2.1) * 0.25;
      tertiary = Math.sin(rx * 8.7 * Math.PI * 2 + 0.3) * 0.2;
      quaternary = Math.sin(rx * 13.2 * Math.PI * 2 + 1.5) * 0.12;
    }

    // Her bar icin benzersiz noise (barIndex kullanarak)
    const noiseVal1 = (this.noise(normalizedX * 50, barIndex * 0.1) - 0.5) * 0.18;
    const noiseVal2 = (this.noise(barIndex * 7.3 + normalizedX * 30) - 0.5) * 0.12;

    // Kombine ve normalize (0-1)
    const combined = primary + secondary + tertiary + quaternary + noiseVal1 + noiseVal2;
    const normalizedHeight = Math.max(0.1, Math.min(1, (combined + 1) / 2));

    // Merkez dugum efekti - kenarlarda yuksek, merkeze dogru azalan
    const heightMult = this.centerHeightMultiplier(normalizedX);

    // Yukseklik (wave + merkez envelope)
    const heightRange = maxBarHeight - minBarHeight;
    return minBarHeight + (normalizedHeight * heightRange * heightMult);
  }

  // No-op: initWaveAnimator() yeni instance oncesi stop() cagirir, bos metod yeterli
  start() {}
  stop() {}
  updateConfig(newConfig) {
    Object.assign(this.config, newConfig);
  }
}

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
