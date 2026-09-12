/**
 * Player - Kayit oynatma yonetimi
 * OCP: Farkli format destekleri eklenebilir
 */
import eventBus from './EventBus.js';
import { formatTime, formatTimestampYYMMDDHHMMSS, getExtensionForMimeType, isValidDuration, log, setVisible } from './utils.js';
import { BYTES, EVENTS } from './constants.js';
import { convertToMp3 } from './Mp3Converter.js';
import PlayerDownloadMenu from '../ui/PlayerDownloadMenu.js';

// Clean Code: Tekrarlayan SVG iconlari constant olarak
const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><use href="#icon-play"/></svg>';
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
    this.fileDetailsEl = document.getElementById('playerFileDetails');
    this.originalLabelEl = document.getElementById('downloadOriginalLabel');
    this.downloadStatusEl = document.getElementById('downloadStatus');
    this.downloadBtnEl = document.getElementById(config.downloadBtnId);
    this.mp3DownloadBtnEl = config.mp3DownloadBtnId ? document.getElementById(config.mp3DownloadBtnId) : null;
    this.noRecordingEl = document.getElementById(config.noRecordingId);
    // Playback kartini saran panel (resolved element) - call kategorisinde display:none
    // baslar, load() ile gorunur yapilir. Verilmezse davranis degismez.
    this.panelEl = config.panelEl || null;

    this.audio = new Audio();
    this.isPlaying = false;
    this.isEnded = false;
    this.currentBlob = null;
    this.currentUrl = null;
    this.knownDurationSeconds = null;
    this.progressAnimId = null; // requestAnimationFrame loop
    this._playRequest = 0;
    this.downloadMenu = new PlayerDownloadMenu(() => !!this.currentBlob && this._canDownload(this.currentBlob));

    this.bindEvents();

    // Event listener referansları (memory leak önleme - VuMeter pattern)
    this._onRecordingCompleted = (data) => this.load(data);
    this._onRecordingStarted = () => this.reset();
    this._onUiStateChanged = () => {
      if (!this.currentBlob || !this._canDownload(this.currentBlob)) this.downloadMenu.close();
    };

    // Event dinle
    eventBus.on(EVENTS.RECORDING_COMPLETED, this._onRecordingCompleted);
    eventBus.on(EVENTS.RECORDING_STARTED, this._onRecordingStarted);
    eventBus.on(EVENTS.UI_STATE_CHANGED, this._onUiStateChanged);
  }

  bindEvents() {
    if (this.playBtnEl) {
      this.playBtnEl.onclick = () => this.togglePlay();
    }

    if (this.progressBarEl) {
      this.progressBarEl.onclick = (e) => this.seek(e);
      this.progressBarEl.addEventListener('keydown', (e) => this._onProgressKeydown(e));
    }

    // timeupdate yerine requestAnimationFrame kullaniliyor (daha akici)
    this.audio.onended = () => this.onEnded();
    this.audio.onloadedmetadata = () => this.onLoaded();
    // WebM dosyalarinda duration bazen gecikebilir
    this.audio.ondurationchange = () => this.onDurationChange();
  }

  load(data) {
    const { blob, mimeType, filename, durationMs, runSnapshot } = data;
    this.downloadMenu.close();
    this._setDownloadStatus('');
    this.recordedAt = runSnapshot?.startedAt || new Date().toISOString();

    // Playback state sifirla
    this.pause();
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
      this.filenameEl.textContent = runSnapshot?.profileLabel || 'Microphone sample';
    }

    if (this.metaEl) {
      const date = new Date(this.recordedAt);
      const recordedTime = Number.isFinite(date.getTime())
        ? date.toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Time unavailable';
      this.metaEl.textContent = recordedTime;
    }
    const extension = getExtensionForMimeType(blob.type || mimeType, '') || filename?.match(/\.([a-z0-9]+)$/i)?.[1] || '';
    if (this.originalLabelEl) this.originalLabelEl.textContent = extension ? `Original · ${extension.toUpperCase()}` : 'Original recording';
    if (this.fileDetailsEl) this.fileDetailsEl.textContent = `${(blob.size / BYTES.PER_KB).toFixed(1)} KB`;
    if (this.downloadBtnEl) this.downloadBtnEl.title = filename;

    if (this.timeEl) {
      this.timeEl.textContent = `0:00 / ${this.knownDurationSeconds ? formatTime(this.knownDurationSeconds) : UNKNOWN_DURATION}`;
    }

    this.syncPlayButtonIcon();

    if (this.downloadBtnEl) {
      this.downloadBtnEl.href = this.currentUrl;
      this.downloadBtnEl.download = filename;
      this.downloadBtnEl.onclick = (event) => {
        if (!this._canDownload(blob)) event.preventDefault();
        else this.downloadMenu.close();
      };
    }
    if (this.mp3DownloadBtnEl) {
      this.mp3DownloadBtnEl.hidden = extension.toLowerCase() === 'mp3';
      this._setupMp3Download(blob, filename);
    }

    if (this.containerEl) {
      this.containerEl.classList.add('visible');
    }

    // Kart profil nedeniyle gizliyse (call kategorisi) kayit yuklenince gorunur yap
    if (this.panelEl) {
      this.panelEl.dataset.runId = runSnapshot?.runId || '';
      setVisible(this.panelEl, true);
    }

    setVisible(this.noRecordingEl, false);

    // Duration bazen metadata ile gec gelir (webm/opus). Play'e basmadan sureyi gostermek icin probe et.
    this.probeDuration(blob).catch((err) => {
      log.error('Player: duration probe error (non-critical)', { error: err.message });
    });

    eventBus.emit(EVENTS.PLAYER_LOADED, { filename, size: blob.size });
  }

  reset() {
    this.downloadMenu.close();
    this._setDownloadStatus('');
    if (this.panelEl) {
      delete this.panelEl.dataset.runId;
      setVisible(this.panelEl, false);
    }
    // Oynatmayi durdur
    this.pause();
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
    this.downloadBtnEl?.removeAttribute('href');
    this.mp3DownloadBtnEl?.removeAttribute('href');
    if (this._mp3Url) {
      URL.revokeObjectURL(this._mp3Url);
      this._mp3Url = null;
    }

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

    setVisible(this.noRecordingEl, true);

    eventBus.emit(EVENTS.PLAYER_RESET);
  }

  async probeDuration(blob) {
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

    if (this.currentBlob !== blob) return;
    if (this.hasValidDuration()) {
      this.knownDurationSeconds = this.audio.duration;
      this.updateDurationUI(this.audio.duration);
      return;
    }

    // 2) Fallback: decodeAudioData ile sureyi hesapla (play'e basmadan)
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;

    const arrayBuffer = await blob.arrayBuffer();
    const ac = new AudioContextCtor();
    try {
      const decoded = await ac.decodeAudioData(arrayBuffer);
      const durationSeconds = decoded?.duration;
      if (this.currentBlob === blob && Number.isFinite(durationSeconds) && durationSeconds > 0) {
        this.knownDurationSeconds = durationSeconds;
        this.updateDurationUI(durationSeconds);
      }
    } finally {
      try {
        await ac.close();
      } catch {
        // ignore
      }
    }
  }

  updateDurationUI(durationSeconds) {
    if (this.timeEl) {
      this.timeEl.textContent = `0:00 / ${formatTime(durationSeconds)}`;
    }
  }

  pause() {
    ++this._playRequest;
    const wasPlaying = this.isPlaying;
    this.audio.pause();
    this.isPlaying = false;
    this.stopProgressLoop();

    this.syncPlayButtonIcon();

    if (wasPlaying) eventBus.emit(EVENTS.PLAYER_PAUSED);
  }

  async togglePlay() {
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

      const request = ++this._playRequest;
      this.isPlaying = true;
      this.isEnded = false;
      this.syncPlayButtonIcon();
      this.startProgressLoop();
      try {
        await this.audio.play();
      } catch (error) {
        // Pause, a new recording or a newer Play owns the UI now.
        if (request !== this._playRequest) return;
        this.pause();
        if (error.name !== 'AbortError') {
          log.error('Playback failed', { error: error.message });
          eventBus.emit(EVENTS.UI_MESSAGE, {
            message: 'The sample could not play. Try Play again or download the original recording.', tone: 'error'
          });
        }
      }
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
    this._updateSliderAria(this.audio.currentTime, duration);

    // Seek sonrasi ended/replay ikonunu senkronize et (ozellikle sona seek edildiyse)
    if (!this.isPlaying) {
      this.isEnded = this.isAtEnd(duration);
      this.syncPlayButtonIcon();
    }
  }

  /**
   * Klavye ile seek (a11y slider) - Ok tuslari +/-5sn, Home/End
   */
  _onProgressKeydown(e) {
    const duration = this.getDurationSeconds();
    if (!duration) return;
    let target = this.audio.currentTime;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp': target += 5; break;
      case 'ArrowLeft':
      case 'ArrowDown': target -= 5; break;
      case 'Home': target = 0; break;
      case 'End': target = duration; break;
      default: return;
    }
    e.preventDefault();
    this.audio.currentTime = Math.max(0, Math.min(duration, target));
    this.isEnded = false;
    this.setProgressFill(this.audio.currentTime / duration, { disableTransition: true });
    this._updateSliderAria(this.audio.currentTime, duration);
    if (!this.isPlaying) {
      this.isEnded = this.isAtEnd(duration);
      this.syncPlayButtonIcon();
    }
  }

  /** Slider ARIA degerlerini guncelle (progressBar role=slider) */
  _updateSliderAria(currentTime, duration) {
    if (!this.progressBarEl) return;
    const pct = duration > 0 ? Math.round(Math.max(0, Math.min(1, currentTime / duration)) * 100) : 0;
    this.progressBarEl.setAttribute('aria-valuenow', String(pct));
    this.progressBarEl.setAttribute('aria-valuetext', `${formatTime(currentTime)} / ${formatTime(duration)}`);
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

    this._updateSliderAria(currentTime, duration);

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

    eventBus.emit(EVENTS.PLAYER_ENDED);
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
      this.playBtnEl.setAttribute('aria-label', 'Pause');
      return;
    }

    const replay = this.shouldReplayOnNextPlay();
    this.playBtnEl.innerHTML = replay ? REPLAY_ICON : PLAY_ICON;
    this.playBtnEl.setAttribute('aria-label', replay ? 'Replay' : 'Play');
  }

  /**
   * Downloads share the playback lock, including keyboard activation.
   */
  _canDownload(blob) {
    return this.currentBlob === blob && !this.downloadMenu.button?.disabled
      && this.downloadBtnEl?.getAttribute('aria-disabled') !== 'true';
  }

  _setDownloadStatus(message) {
    if (this.downloadStatusEl) this.downloadStatusEl.textContent = message;
  }

  /**
   * Optional MP3 export; the primary download keeps the measured original file.
   */
  _setupMp3Download(blob, filename) {
    const button = this.mp3DownloadBtnEl;
    // Onceki mp3 URL'i temizle
    if (this._mp3Url) {
      URL.revokeObjectURL(this._mp3Url);
      this._mp3Url = null;
    }

    // Dosya adini .mp3 uzantisiyla olustur
    const baseName = (filename || `kayit_${formatTimestampYYMMDDHHMMSS()}`)
      .replace(/\.[a-z0-9]+$/i, '');
    const mp3Filename = `${baseName}.mp3`;

    // href'i temizle (tiklaninca JS handle edecek)
    button.href = '#';
    button.download = mp3Filename;

    button.onclick = async (e) => {
      e.preventDefault();
      if (this._convertingBlob === blob || !this._canDownload(blob)) return;

      this._convertingBlob = blob;
      this.downloadMenu.close();
      this._setDownloadStatus('Preparing MP3…');

      try {
        const mp3Blob = await convertToMp3(blob, {
          onProgress: (p) => { if (this.currentBlob === blob) this._setDownloadStatus(`Preparing MP3… ${p}%`); }
        });
        // A late conversion must not download or relabel a newer recording.
        if (!this._canDownload(blob)) return;
        if (this._mp3Url) URL.revokeObjectURL(this._mp3Url);
        this._mp3Url = URL.createObjectURL(mp3Blob);

        const a = document.createElement('a');
        a.href = this._mp3Url;
        a.download = mp3Filename;
        a.click();
        this._setDownloadStatus('MP3 ready.');

        log.player(`MP3 indirildi: ${mp3Filename} (${(mp3Blob.size / BYTES.PER_KB).toFixed(1)} KB)`);
      } catch (err) {
        log.error('MP3 conversion error', { error: err.message });
        if (this._canDownload(blob)) this._setDownloadStatus('MP3 could not be prepared. Try again or download the original.');
      } finally {
        if (this._convertingBlob === blob) this._convertingBlob = null;
      }
    };
  }

  /**
   * Cleanup - EventBus listener'larini kaldir (memory leak onleme)
   */
  destroy() {
    this.downloadMenu.destroy();
    this.currentBlob = null;
    this.pause();
    this.audio.src = '';

    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    if (this._mp3Url) {
      URL.revokeObjectURL(this._mp3Url);
      this._mp3Url = null;
    }

    eventBus.off(EVENTS.RECORDING_COMPLETED, this._onRecordingCompleted);
    eventBus.off(EVENTS.RECORDING_STARTED, this._onRecordingStarted);
    eventBus.off(EVENTS.UI_STATE_CHANGED, this._onUiStateChanged);
  }
}

export default Player;
