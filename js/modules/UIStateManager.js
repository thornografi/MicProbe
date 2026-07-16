/**
 * UIStateManager - UI durumu yonetimi
 * OCP: Button states, preparing overlay, control locking tek yerde
 * DRY: Tekrarlanan UI state guncellemeleri merkezi
 */

import { PROFILES, SETTINGS } from './Config.js';
import { ENCODER_TYPES, PIPELINE_TYPES, SETTING_NAMES, UI_CLASSES } from './constants.js';
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

    const flags = {
      isIdle: currentMode === null,
      isRecording: currentMode === 'recording',
      isMonitoring: currentMode === 'monitoring',
      isTestRecording: currentMode === 'test-recording',
      isTestAnalysing: currentMode === 'test-analysing',
      isPreparing
    };
    flags.isTesting = flags.isTestRecording || flags.isTestAnalysing;

    // Global UI state - CSS whitelist yaklaşımı için
    const appState = isPreparing ? 'preparing'
      : flags.isRecording ? 'recording'
      : flags.isMonitoring ? 'monitoring'
      : flags.isTesting ? 'testing'
      : 'idle';
    document.body.dataset.appState = appState;

    this._updateActionButtons(flags);
    this._updateControlLocks(flags);
    this._updateRadioGroups(flags);
    this._updateButtonTexts(flags);
  }

  /**
   * Ana aksiyon butonlarini guncelle (Record, Monitor, Test)
   * @private
   */
  _updateActionButtons(flags) {
    const { isRecording, isMonitoring, isTestRecording, isTestAnalysing, isTesting, isPreparing } = flags;
    const { recordToggleBtn, monitorToggleBtn, testBtn } = this.elements;

    // Toggle butonlarin active state'leri
    recordToggleBtn?.classList.toggle(UI_CLASSES.ACTIVE, isRecording && !isPreparing);
    monitorToggleBtn?.classList.toggle(UI_CLASSES.ACTIVE, isMonitoring && !isPreparing);

    // Preparing state kontrolü
    recordToggleBtn?.classList.toggle(UI_CLASSES.PREPARING, isPreparing && isRecording);
    monitorToggleBtn?.classList.toggle(UI_CLASSES.PREPARING, isPreparing && isMonitoring);

    // Disable kontrolu
    if (recordToggleBtn) {
      recordToggleBtn.disabled = isMonitoring || isTesting || (isPreparing && !isRecording);
      recordToggleBtn.setAttribute('aria-pressed', isRecording ? 'true' : 'false');
    }
    if (monitorToggleBtn) {
      monitorToggleBtn.disabled = isRecording || isTesting || (isPreparing && !isMonitoring);
      monitorToggleBtn.setAttribute('aria-pressed', isMonitoring ? 'true' : 'false');
    }

    // Test butonu
    if (testBtn) {
      testBtn.classList.toggle(UI_CLASSES.RECORDING, isTestRecording && !isPreparing);
      testBtn.classList.toggle(UI_CLASSES.ANALYSING, isTestAnalysing);
      testBtn.classList.toggle(UI_CLASSES.PREPARING, isPreparing && isTesting);
      testBtn.disabled = isRecording || isMonitoring || (isPreparing && !isTesting);
      testBtn.setAttribute('aria-pressed', isTesting ? 'true' : 'false');
    }
  }

  /**
   * Control kilitleme durumlarini guncelle (ayarlar, profiller, linkler)
   * @private
   */
  _updateControlLocks(flags) {
    const { isIdle, isRecording, isMonitoring, isTesting, isPreparing } = flags;
    const {
      loopbackToggle, ecCheckbox, nsCheckbox, agcCheckbox,
      pipelineContainer, encoderContainer, timesliceContainer,
      recordingPlayerCard, playBtn, progressBar, downloadBtn,
      micSelector, refreshMicsBtn
    } = this.elements;

    // Aktif islem sirasinda kayit tarafini kilitle
    const disableRecordingUi = isMonitoring || isRecording || isTesting;
    pipelineContainer?.classList.toggle(UI_CLASSES.DISABLED, !isIdle);
    encoderContainer?.classList.toggle(UI_CLASSES.DISABLED, !isIdle);
    timesliceContainer?.classList.toggle(UI_CLASSES.DISABLED, disableRecordingUi);
    recordingPlayerCard?.classList.toggle(UI_CLASSES.DISABLED, disableRecordingUi);

    if (playBtn) playBtn.disabled = disableRecordingUi;
    if (progressBar) progressBar.classList.toggle(UI_CLASSES.NO_POINTER, disableRecordingUi);
    if (downloadBtn) downloadBtn.setAttribute('aria-disabled', disableRecordingUi ? 'true' : 'false');

    // Profil kilitleri
    const profile = this.profileController?.getCurrentProfile();
    const lockedSettings = profile?.lockedSettings || [];
    const shouldBeDisabled = (key) => !isIdle || lockedSettings.includes(key);

    // Ayar toggle'lari
    if (loopbackToggle) loopbackToggle.disabled = shouldBeDisabled('loopback');
    if (ecCheckbox) ecCheckbox.disabled = shouldBeDisabled('ec');
    if (nsCheckbox) nsCheckbox.disabled = shouldBeDisabled('ns');
    if (agcCheckbox) agcCheckbox.disabled = shouldBeDisabled('agc');

    // Mikrofon secici
    if (micSelector) micSelector.disabled = !isIdle;
    if (refreshMicsBtn) refreshMicsBtn.disabled = !isIdle;

    // Profil butonlari
    const disableProfiles = !isIdle || isPreparing;
    this.navItems.forEach(item => {
      item.classList.toggle(UI_CLASSES.DISABLED, disableProfiles);
      item.setAttribute('aria-disabled', disableProfiles ? 'true' : 'false');
    });
    this.scenarioCards.forEach(card => {
      card.classList.toggle(UI_CLASSES.DISABLED, disableProfiles);
      card.setAttribute('aria-disabled', disableProfiles ? 'true' : 'false');
    });

    // Header/Footer linkler
    const { headerBrandLink, customSettingsToggle, footerBrandLink, settingsDrawer, drawerOverlay } = this.elements;
    this._setLinkDisabled(headerBrandLink, !isIdle);
    this._setLinkDisabled(customSettingsToggle, !isIdle);
    this._setLinkDisabled(footerBrandLink, !isIdle);
    this.footerLinks.forEach(link => this._setLinkDisabled(link, !isIdle));

    // Settings drawer - aktif islem baslatildiginda kapat
    if (!isIdle && settingsDrawer && settingsDrawer.classList.contains(UI_CLASSES.OPEN)) {
      settingsDrawer.classList.remove(UI_CLASSES.OPEN);
      if (drawerOverlay) drawerOverlay.classList.remove(UI_CLASSES.ACTIVE);
      document.body.style.overflow = '';
    }
  }

  /**
   * Radio gruplarinin disable durumlarini guncelle
   * @private
   */
  _updateRadioGroups(flags) {
    const { isIdle } = flags;
    const { loopbackToggle } = this.elements;
    const WORKLET_SUPPORTED = this.getState.isWorkletSupported();
    const WASM_OPUS_SUPPORTED = this.getState.isWasmOpusSupported?.() ?? false;

    const profile = this.profileController?.getCurrentProfile();
    const lockedSettings = profile?.lockedSettings || [];
    const shouldBeDisabled = (key) => !isIdle || lockedSettings.includes(key);

    const isLoopbackOn = loopbackToggle?.checked ?? false;

    const disableRadioGroup = (radios, settingKey, extraCondition = false) => {
      radios.forEach(radio => {
        const extra = typeof extraCondition === 'function' ? extraCondition(radio) : extraCondition;
        radio.disabled = shouldBeDisabled(settingKey) || extra;
      });
    };

    const selectedEncoder = [...this.radioGroups.encoder].find(r => r.checked)?.value || ENCODER_TYPES.DEFAULT;
    const selectedPipeline = [...this.radioGroups.pipeline].find(r => r.checked)?.value;

    disableRadioGroup(this.radioGroups.pipeline, 'pipeline',
      radio => radio.value === PIPELINE_TYPES.WORKLET && !WORKLET_SUPPORTED);
    disableRadioGroup(this.radioGroups.encoder, 'encoder',
      radio => radio.value === ENCODER_TYPES.WASM_OPUS && !WASM_OPUS_SUPPORTED);
    disableRadioGroup(this.radioGroups.bitrate, 'bitrate', !isLoopbackOn);
    disableRadioGroup(this.radioGroups.timeslice, 'timeslice', shouldDisableTimeslice(isLoopbackOn, selectedEncoder));
    disableRadioGroup(this.radioGroups.mediaBitrate, 'mediaBitrate', isLoopbackOn);
    disableRadioGroup(this.radioGroups.bufferSize, 'buffer', !needsBufferSetting(selectedPipeline));
  }

  /**
   * Buton text'lerini guncelle
   * @private
   */
  _updateButtonTexts(flags) {
    const { isRecording, isMonitoring, isTestRecording, isTestAnalysing, isTesting, isPreparing } = flags;
    const { recordToggleBtn, monitorToggleBtn, testBtn } = this.elements;

    // Test buton text
    if (testBtn) {
      const testBtnText = testBtn.querySelector('.btn-text');
      let testLabel = 'Run 7-second scenario test';
      if (testBtnText) {
        if (isPreparing && isTesting) {
          testBtnText.textContent = 'Preparing...';
          testLabel = 'Preparing scenario test';
        } else if (isTestRecording) {
          testBtnText.textContent = 'Finish';
          testLabel = 'Finish test recording and analyse';
        } else if (isTestAnalysing) {
          testBtnText.textContent = 'Analysing...';
          testLabel = 'Analysing recording';
        } else {
          testBtnText.textContent = 'Run Test';
        }
      }
      testBtn.setAttribute('aria-label', testLabel);
      testBtn.title = testLabel;
    }

    // Record/Monitor buton text
    const recordBtnText = recordToggleBtn?.querySelector('.btn-text');
    const monitorBtnText = monitorToggleBtn?.querySelector('.btn-text');

    if (recordBtnText) {
      let recordLabel = 'Record test sample';
      if (isPreparing && isRecording) {
        recordBtnText.textContent = 'Preparing...';
        recordLabel = 'Preparing recording';
      } else {
        recordBtnText.textContent = isRecording ? 'Stop' : 'Record';
        if (isRecording) recordLabel = 'Stop recording';
      }
      recordToggleBtn?.setAttribute('aria-label', recordLabel);
      if (recordToggleBtn) recordToggleBtn.title = recordLabel;
    }
    if (monitorBtnText) {
      let monitorLabel = 'Start advanced live monitor';
      if (isPreparing && isMonitoring) {
        monitorBtnText.textContent = 'Preparing...';
        monitorLabel = 'Preparing live monitor';
      } else {
        monitorBtnText.textContent = isMonitoring ? 'Stop' : 'Monitor';
        if (isMonitoring) monitorLabel = 'Stop live monitor';
      }
      monitorToggleBtn?.setAttribute('aria-label', monitorLabel);
      if (monitorToggleBtn) monitorToggleBtn.title = isMonitoring ? monitorLabel : 'Advanced live monitor';
    }
  }

  /**
   * Kayit timer'ini baslat
   */
  startTimer() {
    const { timerEl } = this.elements;
    if (!timerEl) return;

    // Mevcut interval varsa temizle - double-start leak onleme
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    this.timerStartTime = Date.now();
    timerEl.textContent = '0:00';
    timerEl.classList.add(UI_CLASSES.VISIBLE);

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
      timerEl.classList.remove(UI_CLASSES.VISIBLE);
    }
  }

  /**
   * Link elementini disabled/enabled yapar (DRY: 3 satirlik pattern)
   * @param {HTMLElement} element - Link elementi
   * @param {boolean} disabled - Disabled durumu
   */
  _setLinkDisabled(element, disabled) {
    if (!element) return;
    element.classList.toggle(UI_CLASSES.DISABLED, disabled);
    element.style.pointerEvents = disabled ? 'none' : '';
    element.setAttribute('aria-disabled', disabled ? 'true' : 'false');
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
    container.classList.toggle(UI_CLASSES.LOCKED, isDisabled);
  }
}

// Singleton export
const uiStateManager = new UIStateManager();
export default uiStateManager;
