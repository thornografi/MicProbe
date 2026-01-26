/**
 * Player - Kayit oynatma yonetimi
 * OCP: Farkli format destekleri eklenebilir
 */
import eventBus from './EventBus.js';
import { formatTime, formatTimestampYYMMDDHHMMSS, isValidDuration, log } from './utils.js';
import { BYTES } from './constants.js';

// Clean Code: Tekrarlayan SVG iconlari constant olarak
const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
const REPLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';

// Clean Code: Magic strings yerine constants
const TIME_PLACEHOLDER = '0:00 / 0:00';
const UNKNOWN_DURATION = '--:--';

class Player {
  constructor(config) {
    this.containerEl = document.getElementById(config.containerId);
    this.playBtnEl = document.getElementById(config.playBtnId);
    this.progressBarEl = document.getElementById(config.progressBarId);
    this.progressFillEl = document.getElementById(config.progressFillId);
    this.timeEl = document.getElementById(config.timeId);
    this.filenameEl = document.getElementById(config.filenameId);
    this.metaEl = document.getElementById(config.metaId);
    this.downloadBtnEl = document.getElementById(config.downloadBtnId);
    this.noRecordingEl = document.getElementById(config.noRecordingId);

    this.audio = new Audio();
    this.isPlaying = false;
    this.isEnded = false;
    this.currentBlob = null;
    this.currentUrl = null;
    this.knownDurationSeconds = null;
    this.progressAnimId = null; // requestAnimationFrame loop

    this.bindEvents();

    // Event listener referansları (memory leak önleme - VuMeter pattern)
    this._onRecordingCompleted = (data) => this.load(data);
    this._onRecordingStarted = () => this.reset();

    // Event dinle
    eventBus.on('recording:completed', this._onRecordingCompleted);
    eventBus.on('recording:started', this._onRecordingStarted);
  }

  bindEvents() {
    if (this.playBtnEl) {
      this.playBtnEl.onclick = () => this.togglePlay();
    }

    if (this.progressBarEl) {
      this.progressBarEl.onclick = (e) => this.seek(e);
    }

    // timeupdate yerine requestAnimationFrame kullaniliyor (daha akici)
    this.audio.onended = () => this.onEnded();
    this.audio.onloadedmetadata = () => this.onLoaded();
    // WebM dosyalarinda duration bazen gecikebilir
    this.audio.ondurationchange = () => this.onDurationChange();
  }

  load(data) {
    const { blob, mimeType, filename, durationMs } = data;

    // Playback state sifirla
    this.stopProgressLoop();
    this.audio.pause();
    this.isPlaying = false;
    this.isEnded = false;

    // Onceki URL'i temizle
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
    }

    this.currentBlob = blob;
    // Duration varsa direkt kullan (WASM Opus icin onemli - decodeAudioData calismayabilir)
    this.knownDurationSeconds = durationMs ? durationMs / 1000 : null;
    this.currentUrl = URL.createObjectURL(blob);

    this.audio.src = this.currentUrl;

    // Yeni kayit yuklenince progress'i sifirla (aksi halde onceki kayittan kalan doluluk gorunebilir)
    if (this.progressFillEl) {
      this.progressFillEl.style.transform = 'scaleX(0)';
    }

    if (this.filenameEl) {
      this.filenameEl.textContent = filename;
    }

    if (this.metaEl) {
      const durationText = this.knownDurationSeconds ? formatTime(this.knownDurationSeconds) : UNKNOWN_DURATION;
      this.metaEl.textContent = `${(blob.size / BYTES.PER_KB).toFixed(1)} KB - ${mimeType} - Duration: ${durationText}`;
    }

    if (this.timeEl && this.knownDurationSeconds) {
      this.timeEl.textContent = `0:00 / ${formatTime(this.knownDurationSeconds)}`;
    }

    this.syncPlayButtonIcon();

    if (this.downloadBtnEl) {
      this.downloadBtnEl.href = this.currentUrl;
      this.downloadBtnEl.download = filename || `kayit_${formatTimestampYYMMDDHHMMSS()}.webm`;
    }

    if (this.containerEl) {
      this.containerEl.classList.add('visible');
    }

    if (this.noRecordingEl) {
      this.noRecordingEl.style.display = 'none';
    }

    // Duration bazen metadata ile gec gelir (webm/opus). Play'e basmadan sureyi gostermek icin probe et.
    this.probeDuration(blob, mimeType).catch((err) => {
      log.error('Player: duration probe hatasi (kritik degil)', { error: err.message });
    });

    eventBus.emit('player:loaded', { filename, size: blob.size });
  }

  reset() {
    // Oynatmayi durdur
    this.audio.pause();
    this.audio.src = '';
    this.isPlaying = false;
    this.isEnded = false;
    this.knownDurationSeconds = null;

    // URL temizle
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    this.currentBlob = null;

    // UI sifirla
    if (this.containerEl) {
      this.containerEl.classList.remove('visible');
    }

    if (this.progressFillEl) {
      this.progressFillEl.style.transform = 'scaleX(0)';
    }

    if (this.timeEl) {
      this.timeEl.textContent = TIME_PLACEHOLDER;
    }

    this.syncPlayButtonIcon();

    if (this.noRecordingEl) {
      this.noRecordingEl.style.display = 'block';
    }

    eventBus.emit('player:reset');
  }

  async probeDuration(blob, mimeType) {
    // Duration zaten biliniyorsa (recording:completed'dan geldi) atla
    if (this.knownDurationSeconds && this.knownDurationSeconds > 0) {
      return;
    }

    // 1) Metadata'dan gelirse kullan
    await new Promise((resolve) => {
      const onMeta = () => resolve();
      const onErr = () => resolve();
      this.audio.addEventListener('loadedmetadata', onMeta, { once: true });
      this.audio.addEventListener('durationchange', onMeta, { once: true });
      this.audio.addEventListener('error', onErr, { once: true });

      // Metadata zaten gelmis olabilir
      if (this.hasValidDuration()) {
        resolve();
      }
    });

    if (this.hasValidDuration()) {
      this.knownDurationSeconds = this.audio.duration;
      this.updateDurationUI(mimeType, blob.size, this.audio.duration);
      return;
    }

    // 2) Fallback: decodeAudioData ile sureyi hesapla (play'e basmadan)
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;

    const arrayBuffer = await blob.arrayBuffer();
    const ac = new AudioContextCtor();
    try {
      const decoded = await ac.decodeAudioData(arrayBuffer.slice(0));
      const durationSeconds = decoded?.duration;
      if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
        this.knownDurationSeconds = durationSeconds;
        this.updateDurationUI(mimeType, blob.size, durationSeconds);
      }
    } finally {
      try {
        await ac.close();
      } catch {
        // ignore
      }
    }
  }

  updateDurationUI(mimeType, sizeBytes, durationSeconds) {
    if (this.timeEl) {
      this.timeEl.textContent = `0:00 / ${formatTime(durationSeconds)}`;
    }

    if (this.metaEl) {
      this.metaEl.textContent = `${(sizeBytes / BYTES.PER_KB).toFixed(1)} KB - ${mimeType} - Duration: ${formatTime(durationSeconds)}`;
    }
  }

  pause() {
    if (!this.isPlaying) return;

    this.audio.pause();
    this.isPlaying = false;
    this.stopProgressLoop();

    this.syncPlayButtonIcon();

    eventBus.emit('player:paused');
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      if (!this.currentUrl) return;

      // Replay: ended state'de bastiginda basa sar
      if (this.shouldReplayOnNextPlay()) {
        this.audio.currentTime = 0;
        this.setProgressFill(0, { disableTransition: true });
        this.isEnded = false;
      }

      void this.audio.play();
      this.isPlaying = true;
      this.isEnded = false;
      this.syncPlayButtonIcon();
      this.startProgressLoop();
    }
  }

  /**
   * Progress bar icin requestAnimationFrame loop baslat
   * timeupdate (~4Hz) yerine 60fps akici animasyon
   */
  startProgressLoop() {
    const loop = () => {
      if (!this.isPlaying) return;
      this.updateProgress();
      this.progressAnimId = requestAnimationFrame(loop);
    };
    loop();
  }

  stopProgressLoop() {
    if (this.progressAnimId) {
      cancelAnimationFrame(this.progressAnimId);
      this.progressAnimId = null;
    }
  }

  seek(e) {
    // NULL GUARD: progressBarEl yoksa seek yapilamaz
    if (!this.progressBarEl) return;

    let duration = this.audio.duration;

    // Gecersiz duration'da fallback: knownDurationSeconds kullan
    if (!isValidDuration(duration)) {
      duration = this.knownDurationSeconds;
      // Hala gecersizse seek yapma
      if (!isValidDuration(duration)) return;
    }

    const rect = this.progressBarEl.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    this.audio.currentTime = percent * duration;
    this.isEnded = false;

    // Seek sirasinda instant update - transition'siz
    this.setProgressFill(percent, { disableTransition: true });

    // Seek sonrasi ended/replay ikonunu senkronize et (ozellikle sona seek edildiyse)
    if (!this.isPlaying) {
      this.isEnded = this.isAtEnd(duration);
      this.syncPlayButtonIcon();
    }
  }

  updateProgress() {
    const duration = this.audio.duration;
    const currentTime = this.audio.currentTime;

    // Gecersiz duration kontrolu
    if (!isValidDuration(duration)) {
      // Duration gec geliyorsa (webm) eski doluluk gorunmesin
      const fallbackDuration = this.knownDurationSeconds;
      if (this.progressFillEl) {
        if (isValidDuration(fallbackDuration)) {
          const progress = Math.max(0, Math.min(1, currentTime / fallbackDuration));
          this.progressFillEl.style.transform = `scaleX(${progress})`;
        } else {
          this.progressFillEl.style.transform = 'scaleX(0)';
        }
      }
      if (this.timeEl) {
        const durationText = isValidDuration(fallbackDuration)
          ? formatTime(fallbackDuration)
          : UNKNOWN_DURATION;
        this.timeEl.textContent = `${formatTime(currentTime)} / ${durationText}`;
      }
      return;
    }

    const progress = currentTime / duration;

    if (this.progressFillEl) {
      this.progressFillEl.style.transform = `scaleX(${progress})`;
    }

    if (this.timeEl) {
      this.timeEl.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
    }
  }

  onEnded() {
    this.stopProgressLoop();
    this.isPlaying = false;
    this.isEnded = true;

    // Progress sonda kalsin (auto sifirlanmasin)
    this.setProgressFill(1);

    // Time display'i sonda goster
    const durationSeconds = this.getDurationSeconds();
    if (this.timeEl) {
      const endText = durationSeconds ? formatTime(durationSeconds) : formatTime(this.audio.currentTime);
      const durationText = durationSeconds ? formatTime(durationSeconds) : UNKNOWN_DURATION;
      this.timeEl.textContent = `${endText} / ${durationText}`;
    }

    this.syncPlayButtonIcon();

    eventBus.emit('player:ended');
  }

  onLoaded() {
    this.updateDurationDisplay();
  }

  onDurationChange() {
    this.updateDurationDisplay();
  }

  updateDurationDisplay() {
    if (this.timeEl) {
      const duration = this.audio.duration;
      // Gecersiz duration kontrolu (Infinity, NaN veya <= 0)
      if (!isValidDuration(duration)) {
        const fallback = this.knownDurationSeconds ? formatTime(this.knownDurationSeconds) : UNKNOWN_DURATION;
        if (this.isEnded) {
          const endText = this.knownDurationSeconds ? formatTime(this.knownDurationSeconds) : formatTime(this.audio.currentTime);
          this.timeEl.textContent = `${endText} / ${fallback}`;
        } else {
          this.timeEl.textContent = `0:00 / ${fallback}`;
        }
      } else {
        const durationText = formatTime(duration);
        if (this.isEnded) {
          this.timeEl.textContent = `${durationText} / ${durationText}`;
        } else {
          this.timeEl.textContent = `0:00 / ${durationText}`;
        }
      }
    }
  }

  // Gecerli duration kontrolu
  hasValidDuration() {
    return isValidDuration(this.audio.duration);
  }

  getDurationSeconds() {
    const duration = this.audio.duration;
    if (Number.isFinite(duration) && duration > 0) return duration;
    if (Number.isFinite(this.knownDurationSeconds) && this.knownDurationSeconds > 0) return this.knownDurationSeconds;
    return null;
  }

  isAtEnd(durationSeconds) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;
    // 50ms tolerance (float rounding / duration drift)
    return this.audio.currentTime >= durationSeconds - 0.05;
  }

  shouldReplayOnNextPlay() {
    const durationSeconds = this.getDurationSeconds();
    return this.isEnded || this.audio.ended || (durationSeconds ? this.isAtEnd(durationSeconds) : false);
  }

  setProgressFill(progress, options = {}) {
    if (!this.progressFillEl) return;
    const clamped = Math.max(0, Math.min(1, progress));

    if (options.disableTransition) {
      this.progressFillEl.classList.add('no-transition');
      this.progressFillEl.style.transform = `scaleX(${clamped})`;
      requestAnimationFrame(() => {
        this.progressFillEl.classList.remove('no-transition');
      });
      return;
    }

    this.progressFillEl.style.transform = `scaleX(${clamped})`;
  }

  syncPlayButtonIcon() {
    if (!this.playBtnEl) return;

    if (this.isPlaying) {
      this.playBtnEl.innerHTML = PAUSE_ICON;
      return;
    }

    this.playBtnEl.innerHTML = this.shouldReplayOnNextPlay() ? REPLAY_ICON : PLAY_ICON;
  }

  /**
   * Cleanup - EventBus listener'larini kaldir (memory leak onleme)
   */
  destroy() {
    this.stopProgressLoop();
    this.audio.pause();
    this.audio.src = '';

    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }

    eventBus.off('recording:completed', this._onRecordingCompleted);
    eventBus.off('recording:started', this._onRecordingStarted);
  }
}

export default Player;
