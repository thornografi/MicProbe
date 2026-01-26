/**
 * UIStateManager - UI durumu yonetimi
 * OCP: Button states, preparing overlay, control locking tek yerde
 * DRY: Tekrarlanan UI state guncellemeleri merkezi
 */

import { PROFILES, SETTINGS } from './Config.js';
import { ENCODER } from './constants.js';
import { formatTime, needsBufferSetting, shouldDisableTimeslice } from './utils.js';

/**
 * UIStateManager class - UI durumlarini yonetir
 */
class UIStateManager {
  constructor() {
    // UI element referanslari
    this.elements = {
      recordToggleBtn: null,
      monitorToggleBtn: null,
      testBtn: null,
      testCountdownEl: null,
      loopbackToggle: null,
      ecCheckbox: null,
      nsCheckbox: null,
      agcCheckbox: null,
      pipelineContainer: null,
      encoderContainer: null,
      timesliceContainer: null,
      recordingPlayerCard: null,
      playBtn: null,
      progressBar: null,
      downloadBtn: null,
      micSelector: null,
      refreshMicsBtn: null,
      profileSelector: null,
      timerEl: null,
      headerBrandLink: null,
      customSettingsToggle: null,
      footerBrandLink: null,
      settingsDrawer: null,
      drawerOverlay: null
    };

    // Footer link koleksiyonu
    this.footerLinks = [];

    // Radio button koleksiyonlari
    this.radioGroups = {
      pipeline: [],
      encoder: [],
      bitrate: [],
      mediaBitrate: [],
      timeslice: [],
      bufferSize: []
    };

    // Nav items ve scenario cards (profil secim disabling icin)
    this.navItems = [];
    this.scenarioCards = [];

    // State getters (dısarıdan set edilir)
    this.getState = {
      currentMode: () => null,
      isPreparing: () => false,
      currentProfileId: () => 'discord',
      isWorkletSupported: () => true
    };

    // ProfileController referansi (locked settings icin)
    this.profileController = null;

    // Timer state
    this.timerInterval = null;
    this.timerStartTime = null;
  }

  /**
   * UI elemanlarini initialize et
   * @param {Object} elements - UI element referanslari
   */
  init(elements) {
    Object.assign(this.elements, elements);
  }

  /**
   * Radio gruplarini set et
   * @param {Object} groups - Radio button koleksiyonlari
   */
  setRadioGroups(groups) {
    Object.assign(this.radioGroups, groups);
  }

  /**
   * State getter'lari set et
   * @param {Object} getters - State getter fonksiyonlari
   */
  setStateGetters(getters) {
    Object.assign(this.getState, getters);
  }

  /**
   * Nav items ve scenario cards'i set et (profil secimi icin)
   * @param {Object} collections - { navItems, scenarioCards }
   */
  setProfileCollections(collections) {
    if (collections.navItems) this.navItems = collections.navItems;
    if (collections.scenarioCards) this.scenarioCards = collections.scenarioCards;
  }

  /**
   * Footer linklerini set et
   * @param {Array} links - Footer link elementleri
   */
  setFooterLinks(links) {
    this.footerLinks = links || [];
  }

  /**
   * ProfileController referansini set et
   * @param {Object} controller - ProfileController instance
   */
  setProfileController(controller) {
    this.profileController = controller;
  }

  /**
   * Button ve control durumlarini guncelle
   * DRY: Tum UI state guncellemeleri tek yerde
   */
  updateButtonStates() {
    const currentMode = this.getState.currentMode();
    const isPreparing = this.getState.isPreparing();
    const WORKLET_SUPPORTED = this.getState.isWorkletSupported();
    const WASM_OPUS_SUPPORTED = this.getState.isWasmOpusSupported?.() ?? false;

    const isIdle = currentMode === null;
    const isRecording = currentMode === 'recording';
    const isMonitoring = currentMode === 'monitoring';
    const isTestRecording = currentMode === 'test-recording';
    const isTestPlayback = currentMode === 'test-playback';
    const isTesting = isTestRecording || isTestPlayback;

    // Global UI state - CSS whitelist yaklaşımı için
    // body[data-app-state="recording/monitoring/testing/preparing"] tüm interactive elementleri disable eder
    // isPreparing önce kontrol edilir - preparing sırasında diğer state'ler henüz set edilmemiş olabilir
    const appState = isPreparing ? 'preparing'
      : isRecording ? 'recording'
      : isMonitoring ? 'monitoring'
      : isTesting ? 'testing'
      : 'idle';
    document.body.dataset.appState = appState;

    const {
      recordToggleBtn,
      monitorToggleBtn,
      testBtn,
      testCountdownEl,
      loopbackToggle,
      ecCheckbox,
      nsCheckbox,
      agcCheckbox,
      pipelineContainer,
      encoderContainer,
      timesliceContainer,
      recordingPlayerCard,
      playBtn,
      progressBar,
      downloadBtn,
      micSelector,
      refreshMicsBtn,
      profileSelector
    } = this.elements;

    // Toggle butonlarin active state'leri
    recordToggleBtn?.classList.toggle('active', isRecording && !isPreparing);
    monitorToggleBtn?.classList.toggle('active', isMonitoring && !isPreparing);

    // Preparing state kontrolü - sadece ilgili buton preparing görünsün
    // Mode artık preparing başında set ediliyor, bu yüzden isPreparing && isX doğru çalışır
    recordToggleBtn?.classList.toggle('preparing', isPreparing && isRecording);
    monitorToggleBtn?.classList.toggle('preparing', isPreparing && isMonitoring);

    // Monitoring/Testing sirasinda kayit butonunu disable et ve tersi
    // Kendi preparing'i sirasinda buton aktif kalmali (iptal edebilsin), baskasinin preparing'inde disabled
    if (recordToggleBtn) recordToggleBtn.disabled = isMonitoring || isTesting || (isPreparing && !isRecording);
    if (monitorToggleBtn) monitorToggleBtn.disabled = isRecording || isTesting || (isPreparing && !isMonitoring);

    // Test butonu state'leri
    if (testBtn) {
      // Test sirasinda aktif, diger islemlerde disabled
      testBtn.classList.toggle('recording', isTestRecording && !isPreparing);
      testBtn.classList.toggle('playback', isTestPlayback);
      testBtn.classList.toggle('preparing', isPreparing && isTesting);
      // Test butonu: recording/monitoring sırasında veya kendi preparing'i dışındaki preparing'lerde disabled
      testBtn.disabled = isRecording || isMonitoring || (isPreparing && !isTesting);

      // Test buton text
      // Skype/Zoom pattern: Recording -> "Done" (erken bitir), Playback -> "Stop"
      const testBtnText = testBtn.querySelector('.btn-text');
      if (testBtnText) {
        if (isPreparing && isTesting) {
          testBtnText.textContent = 'Preparing...';
        } else if (isTestRecording) {
          testBtnText.textContent = 'Done';  // Kullanici konusmayi bitirdi, playback'e gec
        } else if (isTestPlayback) {
          testBtnText.textContent = 'Stop';
        } else {
          testBtnText.textContent = 'Test';
        }
      }
    }

    // Aktif islem sirasinda kayit tarafini tamamen kilitle (recording VEYA monitoring VEYA testing)
    const disableRecordingUi = isMonitoring || isRecording || isTesting;
    pipelineContainer?.classList.toggle('ui-disabled', !isIdle);
    encoderContainer?.classList.toggle('ui-disabled', !isIdle);
    timesliceContainer?.classList.toggle('ui-disabled', disableRecordingUi);
    recordingPlayerCard?.classList.toggle('ui-disabled', disableRecordingUi);

    if (playBtn) {
      playBtn.disabled = disableRecordingUi;
    }

    if (progressBar) {
      progressBar.classList.toggle('no-pointer-events', disableRecordingUi);
    }

    // Download butonu - CSS whitelist yaklaşımı pointer-events'i hallediyor
    // href yönetimi kaldırıldı (Player.js set ediyor, üzerine yazılmasın)
    if (downloadBtn) {
      downloadBtn.setAttribute('aria-disabled', disableRecordingUi ? 'true' : 'false');
    }

    // Profil kilitleri kontrolu - ProfileController'dan al
    const profile = this.profileController?.getCurrentProfile();
    const lockedSettings = profile?.lockedSettings || [];

    // Ayar toggle'lari icin disabled durumu hesapla
    const shouldBeDisabled = (settingKey) => {
      // Aktif islem varsa her zaman disabled
      if (!isIdle) return true;
      // Profil kilidi varsa disabled
      return lockedSettings.includes(settingKey);
    };

    // Ayar toggle'lari - profil kilitleri + aktif mod kontrolu
    if (loopbackToggle) loopbackToggle.disabled = shouldBeDisabled('loopback');
    if (ecCheckbox) ecCheckbox.disabled = shouldBeDisabled('ec');
    if (nsCheckbox) nsCheckbox.disabled = shouldBeDisabled('ns');
    if (agcCheckbox) agcCheckbox.disabled = shouldBeDisabled('agc');

    // Mikrofon secici - aktif islem varken degistirilemez (profil kilidi yok)
    if (micSelector) micSelector.disabled = !isIdle;
    if (refreshMicsBtn) refreshMicsBtn.disabled = !isIdle;

    // Profil butonlari - aktif islem VEYA preparing varken degistirilemez
    const disableProfiles = !isIdle || isPreparing;
    this.navItems.forEach(item => {
      item.classList.toggle('disabled', disableProfiles);
      item.setAttribute('aria-disabled', disableProfiles ? 'true' : 'false');
    });
    this.scenarioCards.forEach(card => {
      card.classList.toggle('disabled', disableProfiles);
      card.setAttribute('aria-disabled', disableProfiles ? 'true' : 'false');
    });
    if (profileSelector) {
      profileSelector.disabled = disableProfiles;
    }

    // Header brand link - aktif islem varken landing page'e donus yapilmasin
    const { headerBrandLink, customSettingsToggle } = this.elements;
    if (headerBrandLink) {
      headerBrandLink.classList.toggle('disabled', !isIdle);
      headerBrandLink.style.pointerEvents = isIdle ? '' : 'none';
      headerBrandLink.setAttribute('aria-disabled', !isIdle ? 'true' : 'false');
    }

    // Custom settings toggle - aktif islem varken ayarlara erisim kapali
    if (customSettingsToggle) {
      customSettingsToggle.classList.toggle('disabled', !isIdle);
      customSettingsToggle.style.pointerEvents = isIdle ? '' : 'none';
      customSettingsToggle.setAttribute('aria-disabled', !isIdle ? 'true' : 'false');
    }

    // Footer brand link ve diger footer linkleri - aktif islem varken disabled
    const { footerBrandLink, settingsDrawer, drawerOverlay } = this.elements;
    if (footerBrandLink) {
      footerBrandLink.classList.toggle('disabled', !isIdle);
      footerBrandLink.style.pointerEvents = isIdle ? '' : 'none';
      footerBrandLink.setAttribute('aria-disabled', !isIdle ? 'true' : 'false');
    }

    this.footerLinks.forEach(link => {
      link.classList.toggle('disabled', !isIdle);
      link.style.pointerEvents = isIdle ? '' : 'none';
      link.setAttribute('aria-disabled', !isIdle ? 'true' : 'false');
    });

    // Settings drawer - aktif islem baslatildiginda drawer'i kapat
    if (!isIdle && settingsDrawer && settingsDrawer.classList.contains('open')) {
      settingsDrawer.classList.remove('open');
      if (drawerOverlay) {
        drawerOverlay.classList.remove('active');
      }
      // Body scroll lock'u kaldir
      document.body.style.overflow = '';
    }

    // Loopback durumu - dinamik kilitleme kurallari icin
    const isLoopbackOn = loopbackToggle?.checked ?? false;

    // Pipeline selector - profil kilidi + aktif session kontrolu
    this.radioGroups.pipeline.forEach(radio => {
      const workletUnsupported = radio.value === 'worklet' && !WORKLET_SUPPORTED;
      radio.disabled = shouldBeDisabled('pipeline') || workletUnsupported;
    });

    // Encoder selector - profil kilidi + WASM destegi kontrolu
    this.radioGroups.encoder.forEach(radio => {
      const wasmOpusUnsupported = radio.value === 'wasm-opus' && !WASM_OPUS_SUPPORTED;
      radio.disabled = shouldBeDisabled('encoder') || wasmOpusUnsupported;
    });

    // Bitrate selector - profil kilidi + loopback OFF ise disabled
    this.radioGroups.bitrate.forEach(r => r.disabled = shouldBeDisabled('bitrate') || !isLoopbackOn);

    // Timeslice selector - profil kilidi + MediaRecorder kullanilmiyorsa disabled (DRY helper)
    const selectedEncoder = document.querySelector('input[name="encoder"]:checked')?.value || ENCODER.DEFAULT;
    this.radioGroups.timeslice.forEach(r => r.disabled = shouldBeDisabled('timeslice') || shouldDisableTimeslice(isLoopbackOn, selectedEncoder));

    // MediaBitrate selector - profil kilidi + loopback ON ise disabled
    this.radioGroups.mediaBitrate.forEach(r => r.disabled = shouldBeDisabled('mediaBitrate') || isLoopbackOn);

    // Buffer size selector - profil kilidi + non-ScriptProcessor pipeline'da disabled
    const selectedPipeline = document.querySelector('input[name="pipeline"]:checked')?.value;
    this.radioGroups.bufferSize.forEach(r => r.disabled = shouldBeDisabled('buffer') || !needsBufferSetting(selectedPipeline));

    // Buton text'lerini guncelle - sadece ilgili buton "Preparing..." göstersin
    const recordBtnText = recordToggleBtn?.querySelector('.btn-text');
    const monitorBtnText = monitorToggleBtn?.querySelector('.btn-text');

    if (recordBtnText) {
      if (isPreparing && isRecording) {
        recordBtnText.textContent = 'Preparing...';
      } else {
        recordBtnText.textContent = isRecording ? 'Stop' : 'Record';
      }
    }
    if (monitorBtnText) {
      if (isPreparing && isMonitoring) {
        monitorBtnText.textContent = 'Preparing...';
      } else {
        monitorBtnText.textContent = isMonitoring ? 'Stop' : 'Monitor';
      }
    }
  }

  /**
   * Kayit timer'ini baslat
   */
  startTimer() {
    const { timerEl } = this.elements;
    if (!timerEl) return;

    this.timerStartTime = Date.now();
    timerEl.textContent = '0:00';
    timerEl.classList.add('visible');

    this.timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.timerStartTime) / 1000);
      timerEl.textContent = formatTime(elapsed);
    }, 1000);
  }

  /**
   * Kayit timer'ini durdur
   */
  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    const { timerEl } = this.elements;
    if (timerEl) {
      timerEl.classList.remove('visible');
    }
  }

  /**
   * Belirli bir ayari disable/enable et
   * @param {string} settingKey - Ayar key'i
   * @param {boolean} isDisabled - Disabled durumu
   */
  setSettingDisabled(settingKey, isDisabled) {
    const setting = SETTINGS[settingKey];
    if (!setting?.ui) return;

    const container = document.querySelector(`[data-setting="${settingKey}"]`);
    if (!container) return;

    // Container icindeki input/select elementlerini bul
    const inputs = container.querySelectorAll('input, select');
    inputs.forEach(input => {
      input.disabled = isDisabled;
    });

    // Locked gorunumu
    container.classList.toggle('locked', isDisabled);
  }
}

// Singleton export
const uiStateManager = new UIStateManager();
export default uiStateManager;
