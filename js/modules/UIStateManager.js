/**
 * UIStateManager - UI durumu yonetimi
 * OCP: Button states, preparing overlay, control locking tek yerde
 * DRY: Tekrarlanan UI state guncellemeleri merkezi
 */

import { PROFILES } from './Config.js';
import { ENCODER_TYPES, PIPELINE_TYPES, EVENTS, APP_STATE } from './constants.js';
import eventBus from './EventBus.js';
import { getSettingLockPolicy } from './utils/settings.js';

/**
 * UIStateManager class - UI durumlarini yonetir
 */
class UIStateManager {
  constructor() {
    // UI element referanslari
    this.elements = {
      recordToggleBtn: null,
      testBtn: null,
      loopbackToggle: null,
      ecCheckbox: null,
      nsCheckbox: null,
      agcCheckbox: null,
      playBtn: null,
      progressBar: null,
      downloadBtn: null,
      downloadMenuBtn: null,
      downloadMp3Btn: null,
      micSelector: null,
      refreshMicsBtn: null,
      headerBrandLink: null,
      customSettingsToggle: null,
      accountMenuBtn: null,
      sharedFooter: null
    };

    // Radio button koleksiyonlari
    this.radioGroups = {
      pipeline: [],
      encoder: [],
      bitrate: [],
      mediaBitrate: [],
      timeslice: [],
      bufferSize: []
    };

    // State getters (dısarıdan set edilir)
    this.getState = {
      currentMode: () => null,
      isPreparing: () => false,
      currentProfileId: () => null,
      isWorkletSupported: () => true
    };

    // ProfileController referansi (locked settings icin)
    this.profileController = null;

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
      isTestRecording: currentMode === 'test-recording',
      isTestAnalysing: currentMode === 'test-analysing',
      isPreparing
    };
    flags.isFinalizing = (flags.isRecording && !!this.getState.isRecordingFinalizing?.())
      || (flags.isTestRecording && !!this.getState.isTestFinalizing?.());
    flags.isTesting = flags.isTestRecording || flags.isTestAnalysing;

    // Tek makine-fazi kaynagi: body[data-app-state] (APP_STATE). CSS buton gorunumlerini ve
    // capture kilidini (helpers.css) bundan turetir; buton uzerinde ayri durum class'i yoktur.
    // Not: bu yol Node testlerinde { body: { dataset } } stub'iyla kosulur - baska DOM erisimi ekleme.
    const appState = isPreparing ? APP_STATE.PREPARING
      : flags.isRecording ? APP_STATE.RECORDING
      : flags.isTestAnalysing ? APP_STATE.ANALYSING
      : flags.isTestRecording ? APP_STATE.TESTING
      : APP_STATE.IDLE;
    document.body.dataset.appState = appState;

    this._updateActionButtons(flags);
    this._updateControlLocks(flags);
    this._updateRadioGroups(flags);
    this._updateButtonTexts(flags);
    if (this._lastAppState !== appState) {
      this._lastAppState = appState;
      eventBus.emit(EVENTS.APP_STATE_CHANGED, { state: appState });
    }
    eventBus.emit(EVENTS.UI_STATE_CHANGED);
  }

  /**
   * Ana aksiyon butonlarini guncelle (Record, Test)
   * @private
   */
  _updateActionButtons(flags) {
    const { isRecording, isTesting, isPreparing, isFinalizing } = flags;
    const { recordToggleBtn, testBtn } = this.elements;
    const hasProfile = !!PROFILES[this.getState.currentProfileId()];

    // Gorunum body[data-app-state] + aria-pressed'den turer (controls.css); burada yalniz
    // disabled ve aria-pressed yazilir.
    if (recordToggleBtn) {
      recordToggleBtn.disabled = !hasProfile || isTesting || isFinalizing || (isPreparing && !isRecording);
      recordToggleBtn.setAttribute('aria-pressed', isRecording ? 'true' : 'false');
    }

    if (testBtn) {
      testBtn.disabled = !hasProfile || isRecording || isFinalizing || flags.isTestAnalysing || (isPreparing && !isTesting);
      testBtn.setAttribute('aria-pressed', isTesting ? 'true' : 'false');
    }
  }

  /**
   * Control kilitleme durumlarini guncelle (ayarlar, linkler)
   * @private
   */
  _updateControlLocks(flags) {
    const { isIdle, isRecording, isTesting } = flags;
    const {
      loopbackToggle, ecCheckbox, nsCheckbox, agcCheckbox,
      playBtn, progressBar, downloadBtn, downloadMp3Btn, downloadMenuBtn,
      micSelector, refreshMicsBtn
    } = this.elements;

    // Aktif islem sirasinda kayit tarafini kilitle.
    // Kural: buton/form kontrolu -> native disabled; <a> -> aria-disabled + tabindex=-1; bolge -> inert.
    const disableRecordingUi = isRecording || isTesting;
    if (playBtn) playBtn.disabled = disableRecordingUi;
    if (progressBar) progressBar.inert = disableRecordingUi;
    for (const link of [downloadBtn, downloadMp3Btn]) this._setLinkDisabled(link, disableRecordingUi);
    if (downloadMenuBtn) downloadMenuBtn.disabled = disableRecordingUi;

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

    // Header linki, ayar akordeonu, hesap butonu ve footer bolgesi
    const { headerBrandLink, customSettingsToggle, accountMenuBtn, sharedFooter } = this.elements;
    this._setLinkDisabled(headerBrandLink, !isIdle);
    if (customSettingsToggle) customSettingsToggle.disabled = !isIdle;
    if (accountMenuBtn) accountMenuBtn.disabled = !isIdle;
    if (sharedFooter) sharedFooter.inert = !isIdle;
  }

  /**
   * Radio gruplarinin disable durumlarini guncelle
   * @private
   */
  _updateRadioGroups(flags) {
    const { isIdle, isPreparing } = flags;
    const { loopbackToggle } = this.elements;
    const WORKLET_SUPPORTED = this.getState.isWorkletSupported();
    const WASM_OPUS_SUPPORTED = this.getState.isWasmOpusSupported?.() ?? false;

    const profile = this.profileController?.getCurrentProfile();
    const isLoopbackOn = loopbackToggle?.checked ?? false;
    const selectedEncoder = [...this.radioGroups.encoder].find(r => r.checked)?.value || ENCODER_TYPES.DEFAULT;
    const selectedPipeline = [...this.radioGroups.pipeline].find(r => r.checked)?.value;
    const locks = getSettingLockPolicy(profile, {
      pipeline: selectedPipeline, loopback: isLoopbackOn, encoder: selectedEncoder
    });
    const shouldBeDisabled = (key) => !isIdle || isPreparing || !!locks[key];

    const disableRadioGroup = (radios, settingKey, extraCondition = false) => {
      radios.forEach(radio => {
        const extra = typeof extraCondition === 'function' ? extraCondition(radio) : extraCondition;
        radio.disabled = shouldBeDisabled(settingKey) || extra;
      });
    };

    disableRadioGroup(this.radioGroups.pipeline, 'pipeline',
      radio => radio.value === PIPELINE_TYPES.WORKLET && !WORKLET_SUPPORTED);
    disableRadioGroup(this.radioGroups.encoder, 'encoder',
      radio => radio.value === ENCODER_TYPES.WASM_OPUS && !WASM_OPUS_SUPPORTED);
    disableRadioGroup(this.radioGroups.bitrate, 'bitrate');
    disableRadioGroup(this.radioGroups.timeslice, 'timeslice');
    disableRadioGroup(this.radioGroups.mediaBitrate, 'mediaBitrate');
    disableRadioGroup(this.radioGroups.bufferSize, 'buffer');
  }

  /**
   * Buton text'lerini guncelle
   * @private
   */
  _updateButtonTexts(flags) {
    const { isRecording, isTestRecording, isTestAnalysing, isTesting, isPreparing, isFinalizing } = flags;
    const { recordToggleBtn, testBtn } = this.elements;

    // Test buton text
    if (testBtn) {
      const testBtnText = testBtn.querySelector('.btn-text');
      let testLabel = 'Start microphone test';
      if (testBtnText) {
        if (isFinalizing && isTesting) {
          testBtnText.textContent = 'Finishing...';
          testLabel = 'Finishing recording';
        } else if (isPreparing && isTesting) {
          testBtnText.textContent = 'Cancel';
          testLabel = 'Cancel test preparation';
        } else if (isTestRecording) {
          testBtnText.textContent = 'Stop early';
          testLabel = 'Finish test recording and analyse';
        } else if (isTestAnalysing) {
          testBtnText.textContent = 'Analysing...';
          testLabel = 'Analysing recording';
        } else {
          testBtnText.textContent = 'Start test';
        }
      }
      testBtn.setAttribute('aria-label', testLabel);
      testBtn.title = testLabel;
    }

    // Record buton text
    const recordBtnText = recordToggleBtn?.querySelector('.btn-text');

    if (recordBtnText) {
      let recordLabel = 'Start microphone test';
      if (isFinalizing) {
        recordBtnText.textContent = 'Finishing...';
        recordLabel = 'Finishing recording';
      } else if (isPreparing && isRecording) {
        recordBtnText.textContent = 'Cancel';
        recordLabel = 'Cancel recording preparation';
      } else {
        recordBtnText.textContent = isRecording ? 'Stop early' : 'Start test';
        if (isRecording) recordLabel = 'Finish test recording and analyse';
      }
      recordToggleBtn?.setAttribute('aria-label', recordLabel);
      if (recordToggleBtn) recordToggleBtn.title = recordLabel;
    }
  }

  /**
   * <a> elemanini devre disi birakir: aria-disabled + tabindex=-1 (klavye), CSS a[aria-disabled] pointer-events:none.
   * @param {HTMLElement} element - Link elementi
   * @param {boolean} disabled - Disabled durumu
   */
  _setLinkDisabled(element, disabled) {
    if (!element) return;
    element.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    if (disabled) element.setAttribute('tabindex', '-1');
    else element.removeAttribute('tabindex');
  }
}

// Singleton export
const uiStateManager = new UIStateManager();
export default uiStateManager;
