/**
 * DeviceInfo - Ses Cihazi Yonetimi ve Durum Paneli
 * 1. Mikrofon secimi ve listeleme
 * 2. Cihaz bilgisi gosterimi (mikrofon, kanal)
 * 3. Codec bilgisi gosterimi (bitrate)
 * Stream baslangicinda ve profil degisikliginde guncellenir
 */
import eventBus from './EventBus.js';
import { stopStreamTracks, log, getStreamErrorMessage } from './utils.js';
import { EVENTS } from './constants.js';

// Storage key for persisting mic selection
const MIC_STORAGE_KEY = 'micprobe_selectedMic';

// 'denied' durumunda tiklama getUserMedia'yi tetiklese de tarayici yeniden izin
// SORMAZ (sessiz dongu) - bu yuzden dogru-eylemli yonlendirme gosterilir
const MIC_PERMISSION_DENIED_MESSAGE = 'Microphone blocked. Allow access in browser site settings, then click Refresh.';

class DeviceInfo {
  constructor() {
    // UI elementleri - Cihaz bolumu
    this.panelEl = document.getElementById('deviceInfoPanel');
    this.micNameEl = document.getElementById('infoMicName');
    this.channelsEl = document.getElementById('infoChannels');
    this.sampleRateEl = document.getElementById('infoSampleRate');
    this.codecEl = document.getElementById('infoCodec');
    this.actualBitrateLabel = document.getElementById('infoActualBitrateLabel');

    // UI elementleri - Codec bolumu
    this.targetBitrateEl = document.getElementById('infoTargetBitrate');
    this.actualBitrateEl = document.getElementById('infoActualBitrate');

    // Mikrofon secici elementleri (init ile set edilir)
    this.micSelector = null;
    this.refreshMicsBtn = null;

    // Bos secim sistem varsayilanini izler; yalniz kullanicinin cihaz secimi saklanir.
    try { this.selectedDeviceId = localStorage.getItem(MIC_STORAGE_KEY) || ''; }
    catch { this.selectedDeviceId = ''; }
    this._defaultDeviceId = '';
    this.hasMicPermission = false;
    this.accessState = 'checking';

    // Permissions API durumu (destekleniyorsa): 'granted' | 'denied' | 'prompt' | null
    this._permissionStatus = null;
    this._micPermissionState = null;

    // Event listener referansları (memory leak önleme - VuMeter pattern)
    this._onStreamStarted = (stream) => this.updateStreamInfo(stream);
    this._onProfileChanged = (data) => { this.resetPanel(); this.updateTargetBitrate(data); };
    this._onLoopbackStats = (stats) => this.updateActualBitrate(stats);
    this._onOpusBitrateChanged = ({ value }) => this.updateTargetBitrate({ values: { loopback: true, bitrate: value } });
    this._onMediaBitrateChanged = ({ value }) => this.updateTargetBitrate({ values: { loopback: false, mediaBitrate: value } });
    this._onReportReady = (report) => this.updateReportInfo(report);

    // Event dinleyiciler
    eventBus.on(EVENTS.STREAM_STARTED, this._onStreamStarted);
    eventBus.on(EVENTS.PROFILE_CHANGED, this._onProfileChanged);
    eventBus.on(EVENTS.LOOPBACK_STATS, this._onLoopbackStats);
    eventBus.on(EVENTS.DIAGNOSTIC_REPORT_READY, this._onReportReady);
    eventBus.on('setting:Opus Bitrate:changed', this._onOpusBitrateChanged);
    eventBus.on('setting:Media Bitrate:changed', this._onMediaBitrateChanged);
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
          // denied: getUserMedia izin diyalogu ACMAZ - tekrar denemek anlamsiz
          if (this._micPermissionState === 'denied') {
            eventBus.emit(EVENTS.UI_MESSAGE, { message: MIC_PERMISSION_DENIED_MESSAGE, tone: 'error' });
            return;
          }
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

        this._saveSelectedDevice();

        log.stream(`Mikrofon secildi: ${selectedOption?.textContent || 'System default'}`, { deviceId: this.selectedDeviceId || 'default' });
      });
    }

    // Cihaz degisikligi dinle - named handler (memory leak onleme icin destroy()'da kaldirilir)
    this._onDeviceChange = async () => {
      // Listeyi guncellemek mikrofon acmamali veya aktif kaydi yeniden baslatmamali.
      // Izin/cihaz geri geldiginde de toparlanabilmek icin eski permission state'e baglanma.
      log.stream('Device change detected, updating list...', {});
      await this.tryEnumerateWithoutPermission();
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

    // Tarayicinin varsayilan/iletisim alias'larini sabit cihaz listesinde yineleme.
    const virtualIds = ['default', 'communications'];
    const realMics = allMics.filter(m => !virtualIds.includes(m.deviceId));

    // Varsayilan cihazi bul
    const defaultEntry = allMics.find(m => m.deviceId === 'default');
    // Chromium'un dinamik alias'ini yalniz tarayici sunuyorsa capture'a ilet.
    // Fiziksel ID'ye cevirmek varsayilan secimini o cihaza sabitler.
    this._defaultDeviceId = defaultEntry?.deviceId || '';
    let defaultRealDeviceId = null;

    if (defaultEntry) {
      // Locale-bagimsiz eslesme: ayni fiziksel cihazin girdileri ayni groupId'yi paylasir
      if (defaultEntry.groupId) {
        const matchingByGroup = realMics.find(m => m.groupId === defaultEntry.groupId);
        if (matchingByGroup) {
          defaultRealDeviceId = matchingByGroup.deviceId;
        }
      }

      // Fallback: etiketten on eki soy (Chromium on eki tarayici UI diline gore degisir)
      if (!defaultRealDeviceId && defaultEntry.label) {
        const defaultLabel = defaultEntry.label.replace(/^(Varsay[ıi]lan|Default)\s*-\s*/i, '').trim();
        const matchingReal = realMics.find(m => m.label === defaultLabel);
        if (matchingReal) {
          defaultRealDeviceId = matchingReal.deviceId;
        }
      }
    }

    // Dropdown temizle
    this.micSelector.replaceChildren();

    // Secili cihaz hala mevcut mu kontrol et
    const selectedStillExists = realMics.some(m => m.deviceId === this.selectedDeviceId);
    if (this.selectedDeviceId && !selectedStillExists) {
      if (logWarnings) {
        log.warning('Previously selected microphone is no longer available', { lostDeviceId: this.selectedDeviceId.slice(0, 8) });
      }
      this.selectedDeviceId = '';
      this._saveSelectedDevice();
    }

    const defaultMic = realMics.find(m => m.deviceId === defaultRealDeviceId);
    const systemOption = document.createElement('option');
    systemOption.value = '';
    systemOption.textContent = defaultMic?.label
      ? `System default (${defaultMic.label})`
      : 'System default';
    this.micSelector.appendChild(systemOption);

    // Sabit cihaz secenekleri; sistem varsayilani ayri bir tercih olarak kalir.
    realMics.forEach((mic, index) => {
      const option = document.createElement('option');
      option.value = mic.deviceId;

      let label = mic.label || `Microphone ${index + 1}`;
      if (mic.deviceId === defaultRealDeviceId) {
        label += ' (default)';
      }
      option.textContent = label;

      this.micSelector.appendChild(option);
    });
    this.micSelector.value = this.selectedDeviceId;

    return realMics;
  }

  _saveSelectedDevice() {
    // Storage is optional; the selected microphone still works for this page.
    try {
      if (this.selectedDeviceId) localStorage.setItem(MIC_STORAGE_KEY, this.selectedDeviceId);
      else localStorage.removeItem(MIC_STORAGE_KEY);
    } catch { log.warning('Microphone preference could not be saved for the next visit'); }
  }

  _showMicPermissionPlaceholder(message = 'Allow microphone access') {
    if (!this.micSelector) return;
    const option = document.createElement('option');
    option.value = '';
    option.disabled = true;
    option.selected = true;
    option.textContent = message;
    this.micSelector.replaceChildren(option);
  }

  _publishAccess(state) {
    this.accessState = state;
    eventBus.emit(EVENTS.MICROPHONE_ACCESS_CHANGED, { state });
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
      // Bazi platformlar ayri cihazlar yerine yalniz varsayilan girisi sunar.
      this._publishAccess(allMics.length ? 'ready' : 'unavailable');

      if (!silent) {
        log.stream(`${realMics.length} microphone(s) found`, { devices: realMics.map(m => m.label || m.deviceId.slice(0, 8)) });
      }
      eventBus.emit(EVENTS.UI_CLEAR_MESSAGE);
    } catch (err) {
      const userMessage = getStreamErrorMessage(err);
      const recoveryMessage = err.name === 'NotFoundError'
        ? 'Connect a microphone, then click Refresh.'
        : 'Allow microphone access in the browser, then click Refresh.';

      this.hasMicPermission = false;
      this._publishAccess(err.name === 'NotAllowedError' ? 'denied' : 'unavailable');
      log.error('Failed to enumerate microphones', { category: 'stream', error: err.message });
      this._showMicPermissionPlaceholder(userMessage);
      eventBus.emit(EVENTS.UI_MESSAGE, {
        message: `${userMessage}. ${recoveryMessage}`,
        tone: 'error'
      });
    }
  }

  /**
   * Tarayici mikrofon izin durumunu Permissions API'den senkronize et.
   * onchange ile izin degisiminde (site ayarlarindan Allow/Block) dropdown
   * reload beklemeden guncellenir. Desteklenmeyen tarayicida sessizce atlanir.
   */
  async _syncMicPermissionState() {
    if (this._permissionStatus || !navigator.permissions?.query) return;
    try {
      const status = await navigator.permissions.query({ name: 'microphone' });
      this._permissionStatus = status;
      this._micPermissionState = status.state;
      status.onchange = () => {
        this._micPermissionState = status.state;
        if (status.state === 'denied') {
          this.hasMicPermission = false;
          this._showMicPermissionPlaceholder(MIC_PERMISSION_DENIED_MESSAGE);
          this._publishAccess('denied');
        } else {
          this.tryEnumerateWithoutPermission();
        }
      };
    } catch {
      this._micPermissionState = null;   // Orn. Firefox 'microphone' query'yi desteklemez
    }
  }

  /**
   * Izinsiz mikrofon listele (label'lar bos olabilir)
   */
  async tryEnumerateWithoutPermission() {
    if (!this.micSelector) return;

    await this._syncMicPermissionState();

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const allMics = devices.filter(d => d.kind === 'audioinput');

      const hasLabels = allMics.some(m => m.label);
      this.hasMicPermission = hasLabels;

      if (hasLabels) {
        this.buildMicrophoneDropdown(allMics, { logWarnings: false });
        this._publishAccess('ready');
      } else if (this._micPermissionState === 'denied') {
        this._showMicPermissionPlaceholder(MIC_PERMISSION_DENIED_MESSAGE);
        this._publishAccess('denied');
      } else if (!allMics.length && this._micPermissionState === 'granted') {
        this.buildMicrophoneDropdown([], { logWarnings: false });
        this._publishAccess('unavailable');
      } else {
        this._showMicPermissionPlaceholder();
        this._publishAccess('prompt');
      }
    } catch (err) {
      this._showMicPermissionPlaceholder();
      this._publishAccess('unavailable');
    }
  }

  /**
   * Secili mikrofon deviceId'sini dondur
   * @returns {string} Sabit deviceId, desteklenen 'default' alias'i veya ''
   */
  getSelectedDeviceId() {
    // Izin placeholder'i DOM secimini gizlese de kullanicinin tercihi korunur.
    // Sistem modunda fiziksel ID yerine alias kullanilir; alias sunmayan
    // tarayicida bos deger Dependencies'in deviceId kisiti koymamasini saglar.
    return this.selectedDeviceId || this._defaultDeviceId;
  }

  /**
   * Hedef bitrate guncelle (profil degistiginde)
   */
  updateTargetBitrate(data) {
    if (!this.targetBitrateEl) return;

    const { profile, values, category } = data;

    // Loopback durumuna gore bitrate secimi:
    // - loopback ON: bitrate (WebRTC Opus) - sesli gorusme testi
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
      this.targetBitrateEl.textContent = values?.loopback ? `Max ${kbps} kbps` : `${kbps} kbps`;
    } else {
      this.targetBitrateEl.textContent = values?.encoder === 'pcm-wav' ? 'PCM' : bitrate === 0 ? 'Auto' : 'N/A';
    }
  }

  /**
   * Gercek bitrate guncelle (WebRTC stats'tan)
   */
  updateActualBitrate(stats) {
    if (this.codecEl) this.codecEl.textContent = stats?.senderCodec?.mimeType || '--';
    if (this.actualBitrateLabel) this.actualBitrateLabel.textContent = 'Measured RTP bitrate';
    if (!this.actualBitrateEl) return;

    if (Number.isFinite(stats?.actualBitrate)) {
      const kbps = Math.round(stats.actualBitrate / 1000);
      this.actualBitrateEl.textContent = `${kbps} kbps`;
    } else {
      this.actualBitrateEl.textContent = '--';
    }
  }

  // A saved file and RTP payload have different byte counts. Never label file
  // bitrate as a call's transport bitrate, or infer a codec from the profile name.
  updateReportInfo(report) {
    if (!report?.recording) return;
    if (report.run?.type === 'test') {
      this.updateActualBitrate(report.loopback);
      return;
    }
    if (this.codecEl) this.codecEl.textContent = report.recording.mimeType || '--';
    if (this.actualBitrateLabel) this.actualBitrateLabel.textContent = 'Measured file bitrate';
    if (this.actualBitrateEl) {
      const bitrate = report.recording.actualBitrate;
      this.actualBitrateEl.textContent = Number.isFinite(bitrate) ? `${Math.round(bitrate / 1000)} kbps` : '--';
    }
  }

  updateStreamInfo(stream) {
    if (!stream) return;

    const track = stream.getAudioTracks()[0];
    if (!track) return;
    // A new capture must not show codec or throughput from the previous run.
    if (this.codecEl) this.codecEl.textContent = '--';
    if (this.actualBitrateEl) this.actualBitrateEl.textContent = '--';
    if (this.actualBitrateLabel) this.actualBitrateLabel.textContent = 'Measured bitrate';

    // A successful capture also grants access when the user starts with Run Test.
    this.hasMicPermission = true;
    this._publishAccess('ready');
    void this.tryEnumerateWithoutPermission();

    const settings = track.getSettings();

    // Mikrofon adi (Cihaz bolumu)
    if (this.micNameEl) {
      // Track label mikrofon adini icerir
      const label = track.label || 'Unknown';
      // Uzun isimleri kisalt
      this.micNameEl.textContent = label.length > 25 ? label.substring(0, 22) + '...' : label;
      this.micNameEl.title = label; // Tam isim tooltip olarak
    }

    // Mikrofon kanal sayisi (Cihaz bolumu)
    if (this.channelsEl) {
      const count = settings.channelCount;
      this.channelsEl.textContent = count === 1 ? 'Mono' : count === 2 ? 'Stereo' : count > 0 ? `${count} channels` : '--';
    }
    if (this.sampleRateEl) this.sampleRateEl.textContent = settings.sampleRate > 0 ? `${settings.sampleRate / 1000} kHz` : '--';

    // Device capabilities (EC/NS/AGC donanim destegi, sampleRate aralik)
    const caps = track.getCapabilities?.() ?? {};
    this._capabilities = {
      sampleRateRange: caps.sampleRate ?? null,
      channelCountRange: caps.channelCount ?? null,
      ecSupported: caps.echoCancellation ?? null,
      nsSupported: caps.noiseSuppression ?? null,
      agcSupported: caps.autoGainControl ?? null
    };
  }

  getCapabilities() {
    return this._capabilities ?? null;
  }

  /**
   * Panel degerlerini sifirla
   */
  resetPanel() {
    if (this.micNameEl) this.micNameEl.textContent = '--';
    if (this.channelsEl) this.channelsEl.textContent = '--';
    if (this.sampleRateEl) this.sampleRateEl.textContent = '--';
    if (this.codecEl) this.codecEl.textContent = '--';
    if (this.actualBitrateLabel) this.actualBitrateLabel.textContent = 'Measured bitrate';
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
    eventBus.off(EVENTS.DIAGNOSTIC_REPORT_READY, this._onReportReady);
    eventBus.off('setting:Opus Bitrate:changed', this._onOpusBitrateChanged);
    eventBus.off('setting:Media Bitrate:changed', this._onMediaBitrateChanged);

    // devicechange listener cleanup
    if (navigator.mediaDevices?.removeEventListener && this._onDeviceChange) {
      navigator.mediaDevices.removeEventListener('devicechange', this._onDeviceChange);
    }

    // Permissions API onchange cleanup
    if (this._permissionStatus) {
      this._permissionStatus.onchange = null;
      this._permissionStatus = null;
    }
  }
}

export default DeviceInfo;
