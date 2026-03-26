/**
 * DeviceInfo - Ses Cihazi Yonetimi ve Durum Paneli
 * 1. Mikrofon secimi ve listeleme
 * 2. Cihaz bilgisi gosterimi (mikrofon, kanal)
 * 3. Codec bilgisi gosterimi (bitrate)
 * Stream baslangicinda ve profil degisikliginde guncellenir
 */
import eventBus from './EventBus.js';
import { stopStreamTracks, log } from './utils.js';
import { EVENTS } from './constants.js';

// Storage key for persisting mic selection
const MIC_STORAGE_KEY = 'micprobe_selectedMic';

class DeviceInfo {
  constructor() {
    // UI elementleri - Cihaz bolumu
    this.panelEl = document.getElementById('deviceInfoPanel');
    this.micNameEl = document.getElementById('infoMicName');
    this.channelsEl = document.getElementById('infoChannels');

    // UI elementleri - Codec bolumu
    this.targetBitrateEl = document.getElementById('infoTargetBitrate');
    this.actualBitrateEl = document.getElementById('infoActualBitrate');

    // Mikrofon secici elementleri (init ile set edilir)
    this.micSelector = null;
    this.refreshMicsBtn = null;

    // Mikrofon state
    this.selectedDeviceId = localStorage.getItem(MIC_STORAGE_KEY) || '';
    this.hasMicPermission = false;

    // Panel her zaman gorunur
    this.showPanel();

    // Event listener referansları (memory leak önleme - VuMeter pattern)
    this._onStreamStarted = (stream) => this.updateStreamInfo(stream);
    this._onProfileChanged = (data) => this.updateTargetBitrate(data);
    this._onLoopbackStats = (stats) => this.updateActualBitrate(stats);

    // Event dinleyiciler
    eventBus.on(EVENTS.STREAM_STARTED, this._onStreamStarted);
    eventBus.on(EVENTS.PROFILE_CHANGED, this._onProfileChanged);
    eventBus.on(EVENTS.LOOPBACK_STATS, this._onLoopbackStats);
  }

  /**
   * Mikrofon secici elementlerini initialize et
   * @param {Object} elements - { micSelector, refreshMicsBtn }
   */
  initMicSelector(elements) {
    this.micSelector = elements.micSelector;
    this.refreshMicsBtn = elements.refreshMicsBtn;

    // Event listener'lari baglat
    this.setupMicEventListeners();

    // Sayfa yuklendiginde izinsiz listele
    this.tryEnumerateWithoutPermission();
  }

  /**
   * Mikrofon event listener'larini kur
   */
  setupMicEventListeners() {
    // Yenile butonu
    if (this.refreshMicsBtn) {
      this.refreshMicsBtn.addEventListener('click', () => {
        this.enumerateMicrophones();
      });
    }

    // Mikrofon secici
    if (this.micSelector) {
      // Tiklandiginda izin yoksa iste
      this.micSelector.addEventListener('mousedown', async (e) => {
        if (!this.hasMicPermission) {
          e.preventDefault();
          try {
            await this.enumerateMicrophones();
          } catch (err) {
            log.error('Mikrofon listesi yuklenemedi', { error: err.message });
          }
        }
      });

      // Secim degistiginde
      this.micSelector.addEventListener('change', (e) => {
        this.selectedDeviceId = e.target.value;
        const selectedOption = this.micSelector.options[this.micSelector.selectedIndex];

        // localStorage'a kaydet
        if (this.selectedDeviceId) {
          localStorage.setItem(MIC_STORAGE_KEY, this.selectedDeviceId);
        } else {
          localStorage.removeItem(MIC_STORAGE_KEY);
        }

        log.stream(`Mikrofon secildi: ${selectedOption.textContent}`, { deviceId: this.selectedDeviceId || 'default' });
      });
    }

    // Cihaz degisikligi dinle - named handler (memory leak onleme icin destroy()'da kaldirilir)
    this._onDeviceChange = async () => {
      if (this.hasMicPermission) {
        log.stream('Cihaz degisikligi algilandi, liste guncelleniyor...', {});
        try {
          await this.enumerateMicrophones(true);
        } catch (err) {
          log.error('Cihaz degisikligi sonrasi liste guncellenemedi', { error: err.message });
        }
      }
    };

    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', this._onDeviceChange);
    }
  }

  /**
   * Mikrofon listesini dropdown'a doldur
   * @param {MediaDeviceInfo[]} allMics - Tum audio input cihazlari
   * @param {Object} options - { logWarnings: boolean }
   * @returns {MediaDeviceInfo[]} Filtrelenmis gercek mikrofonlar
   */
  buildMicrophoneDropdown(allMics, options = {}) {
    const { logWarnings = true } = options;

    if (!this.micSelector) return [];

    // Windows virtual entries'i filtrele
    const virtualIds = ['default', 'communications'];
    const realMics = allMics.filter(m => !virtualIds.includes(m.deviceId));

    // Varsayilan cihazi bul
    const defaultEntry = allMics.find(m => m.deviceId === 'default');
    let defaultRealDeviceId = null;

    if (defaultEntry && defaultEntry.label) {
      const defaultLabel = defaultEntry.label.replace(/^(Varsay[ıi]lan|Default)\s*-\s*/i, '').trim();
      const matchingReal = realMics.find(m => m.label === defaultLabel);
      if (matchingReal) {
        defaultRealDeviceId = matchingReal.deviceId;
      }
    }

    if (!defaultRealDeviceId && realMics.length > 0) {
      defaultRealDeviceId = realMics[0].deviceId;
    }

    // Dropdown temizle
    this.micSelector.innerHTML = '';

    // Secili cihaz hala mevcut mu kontrol et
    const selectedStillExists = realMics.some(m => m.deviceId === this.selectedDeviceId);
    if (this.selectedDeviceId && !selectedStillExists) {
      if (logWarnings) {
        log.warning('Onceden secili mikrofon artik mevcut degil', { lostDeviceId: this.selectedDeviceId.slice(0, 8) });
      }
      this.selectedDeviceId = '';
      localStorage.removeItem(MIC_STORAGE_KEY);
    }

    // Dropdown doldur
    realMics.forEach((mic, index) => {
      const option = document.createElement('option');
      option.value = mic.deviceId;

      let label = mic.label || `Microphone ${index + 1}`;
      if (mic.deviceId === defaultRealDeviceId) {
        label += ' (default)';
      }
      option.textContent = label;

      if (mic.deviceId === this.selectedDeviceId) {
        option.selected = true;
      } else if (!this.selectedDeviceId && mic.deviceId === defaultRealDeviceId) {
        option.selected = true;
        this.selectedDeviceId = mic.deviceId;
      }

      this.micSelector.appendChild(option);
    });

    return realMics;
  }

  /**
   * Mikrofonlari listele (izin isteyerek)
   * @param {boolean} silent - Log yazma
   */
  async enumerateMicrophones(silent = false) {
    try {
      // Izin almak icin getUserMedia cagir
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stopStreamTracks(tempStream);
      this.hasMicPermission = true;

      const devices = await navigator.mediaDevices.enumerateDevices();
      const allMics = devices.filter(d => d.kind === 'audioinput');

      const realMics = this.buildMicrophoneDropdown(allMics, { logWarnings: true });

      if (!silent) {
        log.stream(`${realMics.length} mikrofon bulundu`, { devices: realMics.map(m => m.label || m.deviceId.slice(0, 8)) });
      }
    } catch (err) {
      this.hasMicPermission = false;
      log.error('Mikrofon listesi alinamadi', { category: 'stream', error: err.message });
    }
  }

  /**
   * Izinsiz mikrofon listele (label'lar bos olabilir)
   */
  async tryEnumerateWithoutPermission() {
    if (!this.micSelector) return;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const allMics = devices.filter(d => d.kind === 'audioinput');

      const hasLabels = allMics.some(m => m.label);
      this.hasMicPermission = hasLabels;

      if (hasLabels) {
        this.buildMicrophoneDropdown(allMics, { logWarnings: false });
      } else {
        this.micSelector.innerHTML = '<option value="" disabled>🎤 Click to allow microphone access</option>';
      }
    } catch (err) {
      this.micSelector.innerHTML = '<option value="" disabled>🎤 Click to allow microphone access</option>';
    }
  }

  /**
   * Secili mikrofon deviceId'sini dondur
   * @returns {string} deviceId veya ''
   */
  getSelectedDeviceId() {
    return this.micSelector?.value || '';
  }

  /**
   * Hedef bitrate guncelle (profil degistiginde)
   */
  updateTargetBitrate(data) {
    if (!this.targetBitrateEl) return;

    const { profile, values, category } = data;

    // Loopback durumuna gore bitrate secimi:
    // - loopback ON: bitrate (WebRTC Opus) - sesli gorusme/monitoring
    // - loopback OFF: mediaBitrate (MediaRecorder) - kayit
    // NOT: Kategori degil, gercek loopback durumu onemli (Ham Kayit'ta dinamik degisebilir)
    let bitrate;
    if (values?.loopback === true) {
      bitrate = values?.bitrate;
    } else {
      bitrate = values?.mediaBitrate;
    }

    if (bitrate && bitrate > 0) {
      const kbps = Math.round(bitrate / 1000);
      this.targetBitrateEl.textContent = `${kbps} kbps`;
    } else {
      this.targetBitrateEl.textContent = 'N/A';
    }
  }

  /**
   * Gercek bitrate guncelle (WebRTC stats'tan)
   */
  updateActualBitrate(stats) {
    if (!this.actualBitrateEl) return;

    if (stats && stats.actualBitrate !== undefined) {
      const kbps = Math.round(stats.actualBitrate / 1000);
      this.actualBitrateEl.textContent = `${kbps} kbps`;
    } else {
      this.actualBitrateEl.textContent = '--';
    }
  }

  showPanel() {
    if (this.panelEl) {
      this.panelEl.classList.add('visible');
    }
  }

  updateStreamInfo(stream) {
    if (!stream) return;

    const track = stream.getAudioTracks()[0];
    if (!track) return;

    const settings = track.getSettings();

    // Mikrofon adi (Cihaz bolumu)
    if (this.micNameEl) {
      // Track label mikrofon adini icerir
      const label = track.label || 'Bilinmiyor';
      // Uzun isimleri kisalt
      this.micNameEl.textContent = label.length > 25 ? label.substring(0, 22) + '...' : label;
      this.micNameEl.title = label; // Tam isim tooltip olarak
    }

    // Mikrofon kanal sayisi (Cihaz bolumu)
    if (this.channelsEl) {
      const count = settings.channelCount || 1;
      this.channelsEl.textContent = count === 1 ? 'Mono' : 'Stereo';
    }
  }

  /**
   * Panel degerlerini sifirla
   */
  resetPanel() {
    if (this.micNameEl) this.micNameEl.textContent = '--';
    if (this.channelsEl) this.channelsEl.textContent = '--';
    if (this.targetBitrateEl) this.targetBitrateEl.textContent = '--';
    if (this.actualBitrateEl) this.actualBitrateEl.textContent = '--';
  }

  /**
   * Cleanup - EventBus listener'larini kaldir (memory leak onleme)
   */
  destroy() {
    eventBus.off(EVENTS.STREAM_STARTED, this._onStreamStarted);
    eventBus.off(EVENTS.PROFILE_CHANGED, this._onProfileChanged);
    eventBus.off(EVENTS.LOOPBACK_STATS, this._onLoopbackStats);

    // devicechange listener cleanup
    if (navigator.mediaDevices?.removeEventListener && this._onDeviceChange) {
      navigator.mediaDevices.removeEventListener('devicechange', this._onDeviceChange);
    }
  }
}

export default DeviceInfo;
