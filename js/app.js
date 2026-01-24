/**
 * MicProbe - Ana Uygulama
 * OCP Mimarisi: Moduller arasi EventBus ile iletisim
 *
 * Toggle Ayarlari:
 * - EC/NS/AGC: getUserMedia constraint'leri (mikrofon seviyesi)
 * - WebAudio: Ses islemede AudioContext kullanilsin mi
 * - Loopback: WebRTC simulasyonu (WhatsApp benzeri) aktif mi
 */
import eventBus from './modules/EventBus.js';
import Logger from './modules/Logger.js';
import logManager from './modules/LogManager.js';
import audioEngine from './modules/AudioEngine.js';
import VuMeter from './modules/VuMeter.js';
import Player from './modules/Player.js';
import Recorder from './modules/Recorder.js';
import Monitor from './modules/Monitor.js';
import StatusManager from './modules/StatusManager.js';
import DeviceInfo from './modules/DeviceInfo.js';
import { stopStreamTracks, toggleDisplay, needsBufferSetting, usesWebAudio, wrapAsyncHandler } from './modules/utils.js';
import { isAudioWorkletSupported } from './modules/WorkletHelper.js';
import { isWasmOpusSupported } from './modules/OpusWorkerHelper.js';
import { PROFILES, SETTINGS } from './modules/Config.js';
import { AUDIO, BUFFER, calculateLatencyMs } from './modules/constants.js';
import loopbackManager from './modules/LoopbackManager.js';
import profileController from './modules/ProfileController.js';
import uiStateManager from './modules/UIStateManager.js';
import recordingController from './controllers/RecordingController.js';
import monitoringController from './controllers/MonitoringController.js';
import debugConsole from './ui/DebugConsole.js';
import profileUIManager from './ui/ProfileUIManager.js';
import customSettingsPanelHandler from './ui/CustomSettingsPanelHandler.js';
import { RadioGroupHandler } from './ui/RadioGroupHandler.js';

// ============================================
// ERKEN TANIMLANAN SABITLER (applyProfile oncesi gerekli)
// ============================================
const WORKLET_SUPPORTED = isAudioWorkletSupported();
const WASM_OPUS_SUPPORTED = isWasmOpusSupported();

// ============================================
// UTILITY FONKSIYONLAR
// ============================================
// NOT: stopAllTracks artik stopStreamTracks olarak utils.js'den import ediliyor

// ============================================
// MERKEZI STATE - Erken tanimlama (hoisting icin)
// ============================================
// Modlar: null (idle), 'recording', 'monitoring'
let currentMode = null;
// Hazırlanıyor state (kayıt/monitoring başlatılırken)
let isPreparing = false;
// NOT: currentProfileId artik ProfileController tarafindan yonetiliyor

// Modulleri baslat
const logger = new Logger('log');

const vuMeter = new VuMeter({
  barId: 'vuMeterBar',
  peakId: 'vuMeterPeak',
  dotId: 'signalDot'
});

const player = new Player({
  containerId: 'recordingPlayer',
  playBtnId: 'playBtn',
  progressBarId: 'progressBar',
  progressFillId: 'progressFill',
  timeId: 'playerTime',
  filenameId: 'playerFilename',
  metaId: 'playerMeta',
  downloadBtnId: 'downloadBtn',
  noRecordingId: 'noRecording'
});

const recorder = new Recorder({
  constraints: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
});

const monitor = new Monitor();

const statusManager = new StatusManager('statusBadge');

const deviceInfo = new DeviceInfo();

// ============================================
// UI ELEMENT REFERANSLARI
// ============================================
const recordToggleBtn = document.getElementById('recordToggle');
const monitorToggleBtn = document.getElementById('monitorToggle');
const testBtn = document.getElementById('testBtn');
const testCountdownEl = document.getElementById('testCountdown');
const loopbackToggle = document.getElementById('loopbackToggle');
// NOT: webaudioToggle kaldirildi - artik mode ayari WebAudio durumunu belirliyor

// Ayar checkboxlari
const ecCheckbox = document.getElementById('ec');
const nsCheckbox = document.getElementById('ns');
const agcCheckbox = document.getElementById('agc');

// Opus Bitrate secici
const opusBitrateContainer = document.getElementById('opusBitrateContainer');

// Timeslice Test secici
const timesliceInfoEl = document.getElementById('timesliceInfo');

// Pipeline ve Encoder (kayit + monitor icin ortak)
const pipelineContainer = document.getElementById('pipelineContainer');
const encoderContainer = document.getElementById('encoderContainer');

// Buffer size secici
const bufferSizeContainer = document.getElementById('bufferSizeContainer');
const bufferInfoText = document.getElementById('bufferInfoText');

// Kayit oynatici kontrolleri
const recordingPlayerEl = document.getElementById('recordingPlayer');
const recordingPlayerCardEl = recordingPlayerEl ? recordingPlayerEl.closest('.card') : null;
const recordingPlayerPanelEl = recordingPlayerEl ? recordingPlayerEl.closest('.panel-player') : null;
const playBtnEl = document.getElementById('playBtn');
const downloadBtnEl = document.getElementById('downloadBtn');
const progressBarEl = document.getElementById('progressBar');

// Timeslice container (kayit modu icin)
const timesliceContainerEl = document.querySelector('[data-setting="timeslice"]');

// Profil secici
const profileSelector = document.getElementById('profileSelector');

// Header brand link (landing page donusu)
const headerBrandLink = document.querySelector('.brand-mark');

// Footer linkleri
const footerBrandLink = document.querySelector('.site-footer-brand');
const footerLinks = document.querySelectorAll('.site-footer-links a');

// Ozel Ayarlar Panel (Ana sayfa)
const customSettingsToggle = document.getElementById('customSettingsToggle');
const customSettingsContent = document.getElementById('customSettingsContent');
const customSettingsGrid = document.getElementById('customSettingsGrid');

// Ayar section'lari (profil bazli gorunurluk icin)
const pipelineSection = document.getElementById('pipelineSection');
const webrtcSection = document.getElementById('webrtcSection');
const developerSection = document.getElementById('developerSection');

// data-setting container cache (updateSectionVisibility icin)
const settingContainers = {
  webaudio: document.querySelector('[data-setting="webaudio"]'),
  pipeline: document.querySelector('[data-setting="pipeline"]'),
  encoder: document.querySelector('[data-setting="encoder"]'),
  buffer: document.querySelector('[data-setting="buffer"]'),
  loopback: document.querySelector('[data-setting="loopback"]'),
  bitrate: document.querySelector('[data-setting="bitrate"]'),
  mediaBitrate: document.querySelector('[data-setting="mediaBitrate"]'),
  timeslice: document.querySelector('[data-setting="timeslice"]')
};

// Mikrofon secici
const micSelector = document.getElementById('micSelector');
const refreshMicsBtn = document.getElementById('refreshMics');

// Senaryo kartlari ve sidebar nav (erken tanimlama - applyProfile icin gerekli)
const scenarioCards = document.querySelectorAll('.scenario-card');
const navItems = document.querySelectorAll('.nav-item[data-profile]');

// Radio buton koleksiyonlari (cache - tekrar sorgu onlemi)
const pipelineRadios = document.querySelectorAll('input[name="pipeline"]');
const encoderRadios = document.querySelectorAll('input[name="encoder"]');
const bitrateRadios = document.querySelectorAll('input[name="bitrate"]');
// mediaBitrateRadios - KALDIRILDI: OCP mimarisi ile getSettingElements() dinamik kullaniliyor
const timesliceRadios = document.querySelectorAll('input[name="timeslice"]');
const bufferSizeRadios = document.querySelectorAll('input[name="bufferSize"]');

// ============================================
// MIKROFON LISTESI - DeviceInfo modülüne taşındı
// ============================================
// NOT: Mikrofon yönetimi deviceInfo.initMicSelector() ile başlatılıyor
// getSelectedDeviceId() -> deviceInfo.getSelectedDeviceId()

// ============================================
// SENARYO PROFILLERI - Config.js'den import edildi
// ============================================

// Ayar key'ine gore UI elementlerini dondur (checkbox, radio grubu, toggle)
// OCP: Config.js'deki ui metadata kullanilarak dinamik element bulma
function getSettingElements(settingKey) {
  const setting = SETTINGS[settingKey];
  if (!setting?.ui) return [];

  const { type, id, name } = setting.ui;

  // Checkbox veya Toggle icin tek element
  if (type === 'checkbox' || type === 'toggle') {
    const el = document.getElementById(id);
    return el ? [el] : [];
  }

  // Radio grubu icin tum radiolari dondur
  if (type === 'radio') {
    return [...document.querySelectorAll(`input[name="${name}"]`)];
  }

  return [];
}

// Ayar elementlerini enable/disable et
function setSettingDisabled(settingKey, disabled) {
  const elements = getSettingElements(settingKey);
  elements.forEach(el => {
    el.disabled = disabled;
    // Disabled durumunda visual feedback icin parent label'a class ekle
    const label = el.closest('label');
    if (label) {
      label.classList.toggle('setting-locked', disabled);
    }
  });
}

// Belirli bir secenek (radio/option) enable/disable et
// Ornek: setOptionDisabled('encoder', 'wasm-opus', true) -> sadece wasm-opus secenegi disabled
function setOptionDisabled(settingKey, optionValue, disabled) {
  const elements = getSettingElements(settingKey);
  const targetEl = elements.find(el => el.value === optionValue);
  if (targetEl) {
    targetEl.disabled = disabled;
    const label = targetEl.closest('label');
    if (label) {
      label.classList.toggle('option-disabled', disabled);
    }
  }
}

// NOT: applyProfile, applyProfileConstraints, updateDynamicLocks, updateCustomSettingsPanelDynamicState
// fonksiyonlari ProfileController modülüne taşındı

// ============================================
// YARDIMCI FONKSIYONLAR
// ============================================

// NOT: toggleDisplay utils.js'e tasindi
// NOT: updateSettingVisibility, updateSectionVisibility fonksiyonlari ProfileController modülüne tasindi

/**
 * Kategori bazli UI gorunurlugu
 * OCP: Profil yetenekleri (canMonitor, canRecord) kullanilir
 */
function updateCategoryUI(profileId) {
  const profile = PROFILES[profileId];
  if (!profile) return;

  // OCP: Profil kendi yeteneklerini biliyor
  const { canMonitor, canRecord, category } = profile;
  const loopbackValue = profile.values?.loopback;

  // Buton gorunurlukleri - profil yeteneklerine gore
  toggleDisplay(monitorToggleBtn, canMonitor, 'flex');
  toggleDisplay(recordToggleBtn, canRecord, 'flex');

  // Test butonu - sadece call kategorisinde ve monitor yapabilen profillerde goster
  const isCallCategory = category === 'call';
  toggleDisplay(testBtn, isCallCategory && canMonitor, 'flex');

  // Player paneli - kayit yapabilen profillerde goster
  toggleDisplay(recordingPlayerPanelEl, canRecord);

  // Remote VU container - loopback aktifse goster
  const remoteVuContainer = document.getElementById('remoteVuContainer');
  toggleDisplay(remoteVuContainer, loopbackValue === true);

  eventBus.emit('log:ui', {
    message: `Kategori UI guncellendi: ${category}`,
    details: {
      category,
      canMonitor,
      canRecord,
      remoteVuVisible: loopbackValue === true
    }
  });
}

// Radio value getter - radio butonlarindan deger al
function getRadioValue(name, defaultValue, parseAsInt = false) {
  const selected = document.querySelector(`input[name="${name}"]:checked`);
  if (!selected) return defaultValue;
  return parseAsInt ? parseInt(selected.value, 10) : selected.value;
}

// NOT: attachCheckboxLogger fonksiyonu RadioGroupHandler modülüne taşındı

// ============================================
// AYAR OKUMA FONKSIYONLARI
// ============================================
function getConstraints() {
  const constraints = {
    echoCancellation: ecCheckbox.checked,
    noiseSuppression: nsCheckbox.checked,
    autoGainControl: agcCheckbox.checked,
    sampleRate: getRadioValue('sampleRate', AUDIO.DEFAULT_SAMPLE_RATE, true),
    channelCount: getRadioValue('channelCount', 1, true)
  };

  // Secilen mikrofonu ekle (DeviceInfo modülünden)
  const deviceId = deviceInfo.getSelectedDeviceId();
  if (deviceId) {
    constraints.deviceId = { exact: deviceId };
  }

  return constraints;
}

function isWebAudioEnabled() {
  // Pipeline'a gore WebAudio durumunu belirle
  // direct: WebAudio yok, diger pipeline'lar: WebAudio var
  const pipeline = getRadioValue('pipeline', 'standard');
  return usesWebAudio(pipeline);
}

function getPipeline() {
  return getRadioValue('pipeline', 'standard');
}

function getEncoder() {
  // Custom Settings panelindeki select'ten oku (pcm-wav dahil tum secenekler orada)
  const encoderSelect = document.querySelector('[data-setting="encoder"]');
  if (encoderSelect) {
    return encoderSelect.value;
  }
  // Fallback: drawer radio'dan oku
  return getRadioValue('encoder', 'mediarecorder');
}

// DRY: Drawer radio -> Custom Panel combo senkronizasyonu
function syncToCustomPanel(settingKey, value) {
  const select = document.querySelector(`#customSettingsGrid [data-setting="${settingKey}"]`);
  if (select && select.tagName === 'SELECT') {
    select.value = value;
  }
}

function isLoopbackEnabled() {
  return loopbackToggle.checked;
}

function getOpusBitrate() {
  return getRadioValue('bitrate', SETTINGS.bitrate.default, true);
}

function getTimeslice() {
  // UI'dan oku (profil degeri applyProfile'da set ediliyor)
  return getRadioValue('timeslice', 0, true);
}

function getBufferSize() {
  return getRadioValue('bufferSize', 4096, true);
}

function getMediaBitrate() {
  return getRadioValue('mediaBitrate', 0, true);
}

// Buffer info metnini guncelle
function updateBufferInfo(value) {
  if (!bufferInfoText) return;

  // Latency hesaplama (varsayilan sample rate)
  const latencyMs = calculateLatencyMs(value).toFixed(1);

  bufferInfoText.textContent = `${value} samples @ ${AUDIO.DEFAULT_SAMPLE_RATE / 1000}kHz = ~${latencyMs}ms latency`;

  // Kucuk buffer = dusuk latency ama yuksek CPU
  bufferInfoText.classList.remove('warning', 'danger');
  if (value <= BUFFER.WARNING_THRESHOLD) {
    bufferInfoText.classList.add('warning');
  }
}

// Timeslice info metnini guncelle
function updateTimesliceInfo(value) {
  if (!timesliceInfoEl) return;

  const infoText = timesliceInfoEl.querySelector('.info-text');
  if (!infoText) return;

  // Temizle
  infoText.classList.remove('warning', 'danger');

  if (value === 0) {
    infoText.textContent = 'OFF: Single chunk - no timeslice';
  } else {
    const chunksPerSec = 1000 / value;
    infoText.textContent = `${value}ms: ~${chunksPerSec.toFixed(1)} chunks/sec - Listen for glitch frequency!`;

    if (value <= 100) {
      infoText.classList.add('danger');
    } else if (value <= 250) {
      infoText.classList.add('warning');
    }
  }
}

// ============================================
// AYAR DEGISIKLIK LOGLARI (DRY - RadioGroupHandler ile)
// ============================================

// Checkbox'lar icin logger
RadioGroupHandler.attachCheckboxLogger(ecCheckbox, 'echoCancellation', 'Echo Cancellation');
RadioGroupHandler.attachCheckboxLogger(nsCheckbox, 'noiseSuppression', 'Noise Suppression');
RadioGroupHandler.attachCheckboxLogger(agcCheckbox, 'autoGainControl', 'Auto Gain Control');

// Helper: State guncelleme (tekrar eden pattern)
function updateAllStates() {
  profileController.updateDynamicLocks();
  uiStateManager.updateButtonStates();
}

// Radio gruplari toplu kayit - DRY prensibi
RadioGroupHandler.attachGroups({
  // Pipeline
  Pipeline: {
    radios: pipelineRadios,
    labels: { direct: 'Direct', standard: 'Direct (WebAudio)', scriptprocessor: 'ScriptProcessor (WebAudio)', worklet: 'Worklet (WebAudio)' },
    logCategory: 'log:webaudio',
    onChange: (pipeline) => {
      syncToCustomPanel('pipeline', pipeline);  // DRY: Custom Panel sync
      // Buffer size gorunurlugu: profil ayarlarina veya pipeline'a bagli
      const profile = profileController.getCurrentProfile();
      const bufferInProfile = profile?.lockedSettings?.includes('buffer') ||
                              profile?.editableSettings?.includes('buffer') ||
                              profile?.allowedSettings === 'all';
      if (!bufferInProfile) {
        toggleDisplay(bufferSizeContainer, needsBufferSetting(pipeline));
      }
      updateAllStates();
    }
  },

  // Encoder
  Encoder: {
    radios: encoderRadios,
    labels: { mediarecorder: 'MediaRecorder', 'wasm-opus': 'WASM Opus' },
    logCategory: 'log:webaudio',
    onChange: (encoder) => {
      syncToCustomPanel('encoder', encoder);  // DRY: Custom Panel sync
      updateAllStates();  // Encoder degisince timeslice durumunu guncelle (MediaRecorder bagimliligi)
    }
  },

  // Buffer Size
  'Buffer Size': {
    radios: bufferSizeRadios,
    logCategory: 'log:webaudio',
    formatValue: (v) => `${v} samples`,
    onChange: (bufferSize) => {
      syncToCustomPanel('buffer', bufferSize);  // DRY: Custom Panel sync
      updateBufferInfo(bufferSize);
    }
  },

  // Opus Bitrate
  'Opus Bitrate': {
    radios: bitrateRadios,
    logCategory: 'log:stream',
    formatValue: (v) => `${v / 1000} kbps`,
    onChange: (bitrate) => syncToCustomPanel('bitrate', bitrate)  // DRY: Custom Panel sync
  },

  // Timeslice
  Timeslice: {
    radios: timesliceRadios,
    logCategory: 'log:recorder',
    formatValue: (v) => v === 0 ? 'OFF' : `${v}ms`,
    onChange: (timeslice) => {
      syncToCustomPanel('timeslice', timeslice);  // DRY: Custom Panel sync
      updateTimesliceInfo(timeslice);
    }
  },

  // Media Bitrate
  'Media Bitrate': {
    radios: [...document.querySelectorAll('input[name="mediaBitrate"]')],
    logCategory: 'log:recorder',
    formatValue: (v) => v === 0 ? 'Off' : `${v / 1000}k`,
    onChange: (mediaBitrate) => syncToCustomPanel('mediaBitrate', mediaBitrate)  // DRY: Custom Panel sync
  },

  // Sample Rate
  'Sample Rate': {
    radios: [...document.querySelectorAll('input[name="sampleRate"]')],
    logCategory: 'log:audio',
    formatValue: (v) => `${v} Hz`
  },

  // Channel Count
  'Channel Count': {
    radios: [...document.querySelectorAll('input[name="channelCount"]')],
    logCategory: 'log:audio',
    formatValue: (v) => v === 1 ? 'Mono' : 'Stereo'
  }
});

// Loopback Toggle - ozel mantik iceriyor, ayri kalmali
RadioGroupHandler.attachToggle(loopbackToggle, 'WebRTC Loopback', {
  logCategory: 'log:stream',
  onLabel: 'AKTIF',
  offLabel: 'PASIF',
  onChange: (enabled) => {
    // Bitrate seciciyi goster/gizle
    toggleDisplay(opusBitrateContainer, enabled);
    updateAllStates();

    // DeviceInfo panelini guncelle
    const profile = profileController.getCurrentProfile();
    if (profile) {
      const currentBitrate = parseInt(document.querySelector('input[name="bitrate"]:checked')?.value || '0', 10);
      const currentMediaBitrate = parseInt(document.querySelector('input[name="mediaBitrate"]:checked')?.value || '0', 10);
      eventBus.emit('profile:changed', {
        profile: profileController.getCurrentProfileId(),
        values: { ...profile.values, loopback: enabled, bitrate: currentBitrate, mediaBitrate: currentMediaBitrate },
        category: profile.category
      });
    }
  }
});

// Profil degisikligi (hidden select - backward compatibility)
// Named function - memory leak onleme (cleanup icin referans tutulabilir)
async function handleProfileChange(e) {
  try {
    await profileController.applyProfile(e.target.value);
    // updateScenarioCardSelection ProfileUIManager tarafindan yapiliyor
  } catch (err) {
    eventBus.emit('log:error', {
      message: 'Profil degisikligi hatasi',
      details: { profileId: e.target.value, error: err.message }
    });
  }
}

if (profileSelector) {
  profileSelector.addEventListener('change', handleProfileChange);
  // NOT: Baslangic profili uygulama, callbacks set edildikten sonra yapiliyor (line ~912)
}

// ============================================
// SENARYO KARTLARI & SIDEBAR NAV
// ============================================
// NOT: scenarioCards ve navItems yukarida tanimlandi (applyProfile hoisting icin)
const scenarioBadge = document.getElementById('scenarioBadge');
const scenarioTech = document.getElementById('scenarioTech');

// Sidebar elementleri
const pageTitle = document.getElementById('pageTitle');
const pageTitleIcon = document.getElementById('pageTitleIcon');
const pageSubtitle = document.getElementById('pageSubtitle');
const settingsDrawer = document.getElementById('settingsDrawer');
const drawerOverlay = document.getElementById('drawerOverlay');
const closeDrawerBtn = document.getElementById('closeDrawer');

// Dev Console Drawer
const devConsoleDrawer = document.getElementById('devConsoleDrawer');
const devConsoleToggle = document.getElementById('devConsoleToggle');
const closeConsoleBtn = document.getElementById('closeConsole');
// sidebarStatus - KALDIRILDI: Kullanilmiyordu

// NOT: buildTechParts ProfileController'a tasindi
// NOT: updateScenarioTechInfo, updateScenarioCardSelection, updateNavItemSelection, updatePageSubtitle
//      ProfileUIManager modülüne tasindi

// ============================================
// DRAWER CONTROLLER FACTORY (DRY)
// ============================================
function createDrawerController(drawerEl, options = {}) {
  const { overlay = null, lockBody = false } = options;

  return {
    isOpen: () => drawerEl?.classList.contains('open'),
    open() {
      drawerEl?.classList.add('open');
      overlay?.classList.add('open');
      if (lockBody) document.body.style.overflow = 'hidden';
    },
    close() {
      drawerEl?.classList.remove('open');
      overlay?.classList.remove('open');
      if (lockBody) document.body.style.overflow = '';
    },
    toggle() {
      this.isOpen() ? this.close() : this.open();
    },
    bindButtons(...buttons) {
      buttons.filter(Boolean).forEach(btn => btn.addEventListener('click', () => this.toggle()));
    },
    bindCloseButtons(...buttons) {
      buttons.filter(Boolean).forEach(btn => btn.addEventListener('click', () => this.close()));
    }
  };
}

// Drawer controller'lar olustur
const settingsDrawerCtrl = createDrawerController(settingsDrawer, { overlay: drawerOverlay, lockBody: true });
const devConsoleCtrl = createDrawerController(devConsoleDrawer);

// Event listener'lari bagla
settingsDrawerCtrl.bindCloseButtons(closeDrawerBtn, drawerOverlay);
devConsoleCtrl.bindButtons(devConsoleToggle);
devConsoleCtrl.bindCloseButtons(closeConsoleBtn);

// ESC ile drawer/console kapat
// Named function - memory leak onleme (cleanup icin referans tutulabilir)
function handleEscapeKey(e) {
  if (e.key === 'Escape') {
    settingsDrawerCtrl.close();
    devConsoleCtrl.close();
  }
}
document.addEventListener('keydown', handleEscapeKey);

// NOT: handleProfileSelect ve scenarioCards/navItems event listener'lari ProfileUIManager modülüne tasindi

// NOT: Ozel Ayarlar Panel Toggle CustomSettingsPanelHandler modülüne taşındı

// NOT: updateCustomSettingsPanel fonksiyonu ve customSettingsGrid event listener'i
// CustomSettingsPanelHandler modülüne taşındı

// Baslangic profil ID'si (initialization icin)
const initialProfile = profileSelector?.value || 'discord';
// NOT: Profil UI guncellemeleri, callbacks set edildikten sonra yapiliyor (line ~905+)

// ============================================
// MERKEZI STATE YONETIMI
// ============================================
// NOT: currentMode dosya basinda tanimlandi (hoisting icin)

// Timer - UIStateManager modülüne taşındı
const timerEl = document.getElementById('recordingTimer');

// NOT: updateButtonStates fonksiyonu UIStateManager modülüne taşındı
// NOT: showPreparingState, hidePreparingState fonksiyonlari UIStateManager modülüne taşındı

// ============================================
// MODUL INITIALIZATION
// ============================================

// ProfileController init
profileController.init({
  loopbackToggle,
  profileSelector,
  customSettingsGrid,
  pipelineSection,
  webrtcSection,
  developerSection
});

profileController.setSettingContainers(settingContainers);

profileController.setCallbacks({
  stopMonitoring,
  stopRecording,
  startMonitoring: () => monitoringController.start(),
  startRecording: () => recordingController.start(),
  updateButtonStates: () => uiStateManager.updateButtonStates(),
  updateBufferInfo,
  updateTimesliceInfo,
  updateCategoryUI,
  getRadioValue,
  setSettingDisabled,
  setOptionDisabled,
  getSettingElements,
  resetPlayer: () => player.reset()
});

profileController.setStateGetters({
  currentMode: () => currentMode
});

// UIStateManager init (tum UI state yonetimi icin)
uiStateManager.init({
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
  timesliceContainer: timesliceContainerEl,
  recordingPlayerCard: recordingPlayerCardEl,
  playBtn: playBtnEl,
  progressBar: progressBarEl,
  downloadBtn: downloadBtnEl,
  micSelector,
  refreshMicsBtn,
  profileSelector,
  timerEl,
  headerBrandLink,
  customSettingsToggle,
  footerBrandLink,
  settingsDrawer,
  drawerOverlay
});

uiStateManager.setRadioGroups({
  pipeline: [...pipelineRadios],
  encoder: [...encoderRadios],
  bitrate: [...bitrateRadios],
  mediaBitrate: [...document.querySelectorAll('input[name="mediaBitrate"]')],
  timeslice: [...timesliceRadios],
  bufferSize: [...bufferSizeRadios]
});

uiStateManager.setStateGetters({
  currentMode: () => currentMode,
  isPreparing: () => isPreparing,
  currentProfileId: () => profileController.getCurrentProfileId(),
  isWorkletSupported: () => WORKLET_SUPPORTED,
  isWasmOpusSupported: () => WASM_OPUS_SUPPORTED
});

uiStateManager.setProfileCollections({
  navItems: [...navItems],
  scenarioCards: [...scenarioCards]
});

uiStateManager.setFooterLinks([...footerLinks]);

uiStateManager.setProfileController(profileController);

// CustomSettingsPanelHandler init
customSettingsPanelHandler.init({
  customSettingsToggle,
  customSettingsContent,
  customSettingsGrid
});

customSettingsPanelHandler.setCallbacks({
  getSettingElements,
  setSettingDisabled
});

customSettingsPanelHandler.setDependencies({
  profileController
});

// DeviceInfo init - mikrofon secici
deviceInfo.initMicSelector({
  micSelector,
  refreshMicsBtn
});

// Baslangicta buton durumlarini ayarla
uiStateManager.updateButtonStates();

// Baslangic profilini uygula (loopback, mode vb. degerler set edilsin)
profileController.applyProfile(initialProfile);

// Baslangic profil UI guncellemeleri (applyProfile sonrasi)
profileUIManager.updateAll(initialProfile);
customSettingsPanelHandler.updatePanel(initialProfile);
// NOT: updateCategoryUI zaten applyProfile icinde cagiriliyor

// UI state sync (refresh/persisted checkbox senaryolari icin)
toggleDisplay(pipelineContainer, isWebAudioEnabled());
toggleDisplay(encoderContainer, true); // Encoder her zaman gorunur

if (!WORKLET_SUPPORTED) {
  eventBus.emit('log:system', {
    message: 'AudioWorklet desteklenmiyor - Worklet secenekleri devre disi',
    details: {}
  });
}

if (!WASM_OPUS_SUPPORTED) {
  eventBus.emit('log:system', {
    message: 'WASM Opus desteklenmiyor - WASM Opus secenegi devre disi',
    details: {}
  });

  // WASM Opus secenegini devre disi birak
  const wasmOpusOption = document.querySelector('[data-requires-wasm="true"]');
  if (wasmOpusOption) {
    wasmOpusOption.disabled = true;
    const label = wasmOpusOption.nextElementSibling;
    if (label) {
      label.classList.add('option-disabled');
    }
  }
} else {
  eventBus.emit('log:system', {
    message: 'WASM Opus destegi aktif',
    details: {}
  });
}

// LoopbackManager'a worklet support bilgisini ver
loopbackManager.workletSupported = WORKLET_SUPPORTED;

// Controller'lara bagimliliklari ver
const controllerDeps = {
  getConstraints,
  getPipeline,
  getEncoder,
  isLoopbackEnabled,
  isWebAudioEnabled,
  getOpusBitrate,
  getTimeslice,
  getBufferSize,
  getMediaBitrate,
  recorder,
  monitor,
  player,
  uiStateManager,
  setCurrentMode: (mode) => { currentMode = mode; },
  getCurrentMode: () => currentMode,
  setIsPreparing: (val) => { isPreparing = val; }
};

recordingController.setDependencies(controllerDeps);
monitoringController.setDependencies(controllerDeps);

// DebugConsole init
debugConsole.init({
  eventBus,
  logger,
  logManager,
  monitor,
  audioEngine
});
debugConsole.registerGlobals();

// ProfileUIManager init
profileUIManager.init({
  scenarioCards,
  navItems,
  pageTitle,
  pageTitleIcon,
  pageSubtitle,
  scenarioBadge,
  scenarioTech,
  profileSelector
});
profileUIManager.setStateGetters({
  currentMode: () => currentMode,
  isPreparing: () => isPreparing
});
profileUIManager.setCallbacks({
  updateCustomSettingsPanel: (profileId) => customSettingsPanelHandler.updatePanel(profileId)
});

// ============================================
// RECORDING (Toggle)
// ============================================
recordToggleBtn.onclick = wrapAsyncHandler(
  () => recordingController.toggle(),
  'Kayit toggle hatasi'
);

// stopRecording - artik RecordingController tarafindan yonetiliyor
async function stopRecording() {
  await recordingController.stop();
}

// ============================================
// MONITORING (Toggle)
// ============================================
monitorToggleBtn.onclick = wrapAsyncHandler(
  () => monitoringController.toggle(),
  'Monitor toggle hatasi'
);

// stopMonitoring - artik MonitoringController tarafindan yonetiliyor
async function stopMonitoring() {
  await monitoringController.stop();
}

// ============================================
// TEST (Loopback Test Ozelligi)
// ============================================
if (testBtn) {
  testBtn.onclick = wrapAsyncHandler(
    () => monitoringController.toggleTest(),
    'Test toggle hatasi'
  );
}

// Test countdown event listener
eventBus.on('test:countdown', ({ remainingSec }) => {
  if (testCountdownEl) {
    testCountdownEl.textContent = remainingSec > 0 ? `${remainingSec}s` : '';
  }
});

// Test tamamlandiginda/iptal edildiginde countdown temizle
eventBus.on('test:completed', () => {
  if (testCountdownEl) testCountdownEl.textContent = '';
});
eventBus.on('test:cancelled', () => {
  if (testCountdownEl) testCountdownEl.textContent = '';
});
eventBus.on('test:playback-stopped', () => {
  if (testCountdownEl) testCountdownEl.textContent = '';
});

// ============================================
// BASLANGIC - PRE-INITIALIZATION
// ============================================

// Recorder'i onceden isit (Start butonunda hiz kazanimi)
// NOT: AudioEngine warmup lazy - sadece Loopback/Monitor modlarinda gerektiginde yapilir
async function initializeAudio() {
  // Recorder warmup (Recording modu icin)
  try {
    await recorder.warmup();
  } catch (err) {
    eventBus.emit('log:error', {
      message: 'Recorder warmup hatasi (kritik degil)',
      details: { error: err.message, step: 'recorder.warmup' }
    });
  }

  eventBus.emit('log:system', {
    message: 'Audio pre-initialization tamamlandi (AudioEngine lazy)',
    details: { recorderWarmedUp: recorder.isWarmedUp }
  });
}

// Sayfa yuklenince warmup baslat
initializeAudio();

eventBus.emit('log', 'Mic Probe hazir. Bir test modu secin.');
eventBus.emit('log:system', {
  message: 'Uygulama baslatildi',
  details: {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    audioContextSupported: !!(window.AudioContext || window.webkitAudioContext),
    mediaDevicesSupported: !!navigator.mediaDevices?.getUserMedia,
    rtcPeerConnectionSupported: !!window.RTCPeerConnection
  }
});
