/**
 * MicProbe - Ana Uygulama
 * OCP Mimarisi: Moduller arasi EventBus ile iletisim
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
import { log } from './modules/utils.js';
import { IS_DEV } from './modules/constants.js';
import { isAudioWorkletSupported } from './modules/WorkletHelper.js';
import { isWasmOpusSupported } from './modules/OpusWorkerHelper.js';
import loopbackManager from './modules/LoopbackManager.js';
import audioMetricsCollector from './modules/AudioMetricsCollector.js';
import diagnosticReportBuilder from './modules/DiagnosticReportBuilder.js';
import reportPanelUI from './ui/ReportPanelUI.js';
import profileController from './controllers/ProfileController.js';
import uiStateManager from './modules/UIStateManager.js';
import recordingController from './controllers/RecordingController.js';
import monitoringController from './controllers/MonitoringController.js';
import debugConsole from './ui/DebugConsole.js';
import profileUIManager from './ui/ProfileUIManager.js';
import customSettingsPanelHandler from './ui/CustomSettingsPanelHandler.js';

// UI Modulleri
import * as UIElements from './ui/UIElements.js';
import { registerCheckboxLoggers, registerRadioGroups, registerLoopbackToggle } from './ui/RadioHandlers.js';
import {
  setupButtonHandlers,
  setupDrawerHandlers,
  setupKeyboardHandlers,
  setupTestCountdownHandlers
} from './app/ButtonHandlers.js';

// App Modulleri
import { getCurrentMode, getIsPreparing } from './app/AppState.js';
import {
  getSettingElements,
  setSettingDisabled,
  setOptionDisabled,
  getRadioValue,
  syncToCustomPanel,
  updateBufferInfo,
  updateTimesliceInfo
} from './app/SettingHelpers.js';
import {
  initProfileController,
  initUIStateManager,
  initCustomSettingsPanel,
  initDeviceInfo,
  initDebugConsole,
  initProfileUIManager,
  updateCategoryUI,
  syncInitialUI
} from './app/ModuleInit.js';
import { createControllerDeps } from './app/Dependencies.js';

// ============================================
// ENVIRONMENT
// ============================================
if (!IS_DEV) document.body.classList.add('production');

// ============================================
// ERKEN TANIMLANAN SABITLER
// ============================================
const WORKLET_SUPPORTED = isAudioWorkletSupported();
const WASM_OPUS_SUPPORTED = isWasmOpusSupported();

// ============================================
// MODUL INSTANCES
// ============================================
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
const statusManager = new StatusManager('statusBadge', 'userMessage');
const deviceInfo = new DeviceInfo();

// ============================================
// YARDIMCI FONKSIYONLAR
// ============================================
function updateAllStates() {
  profileController.updateDynamicLocks();
  uiStateManager.updateButtonStates();
}

// ============================================
// HANDLER KAYITLARI
// ============================================
registerCheckboxLoggers({
  ecCheckbox: UIElements.ecCheckbox,
  nsCheckbox: UIElements.nsCheckbox,
  agcCheckbox: UIElements.agcCheckbox
});

registerRadioGroups(
  {
    pipelineRadios: UIElements.pipelineRadios,
    encoderRadios: UIElements.encoderRadios,
    bufferSizeRadios: UIElements.bufferSizeRadios,
    bitrateRadios: UIElements.bitrateRadios,
    timesliceRadios: UIElements.timesliceRadios,
    mediaBitrateRadios: UIElements.mediaBitrateRadios,
    sampleRateRadios: UIElements.sampleRateRadios,
    channelCountRadios: UIElements.channelCountRadios
  },
  {
    syncToCustomPanel,
    updateAllStates,
    updateBufferInfo: (val) => updateBufferInfo(val, UIElements.bufferInfoText),
    updateTimesliceInfo: (val) => updateTimesliceInfo(val, UIElements.timesliceInfoEl),
    profileController,
    bufferSizeContainer: UIElements.bufferSizeContainer
  }
);

registerLoopbackToggle(UIElements.loopbackToggle, {
  opusBitrateContainer: UIElements.opusBitrateContainer,
  updateAllStates,
  profileController,
  eventBus
});

const { settingsDrawerCtrl, profileDrawerCtrl, devConsoleCtrl } = setupDrawerHandlers({
  settingsDrawer: UIElements.settingsDrawer,
  drawerOverlay: UIElements.drawerOverlay,
  closeDrawerBtn: UIElements.closeDrawerBtn,
  devConsoleDrawer: UIElements.devConsoleDrawer,
  devConsoleToggle: UIElements.devConsoleToggle,
  closeConsoleBtn: UIElements.closeConsoleBtn,
  profileSidebar: UIElements.profileSidebar,
  profileMenuBtn: UIElements.profileMenuBtn,
  navItems: [...UIElements.navItems]
});

const escKeyHandler = setupKeyboardHandlers({ settingsDrawerCtrl, profileDrawerCtrl, devConsoleCtrl });

const initialProfile = 'discord';

// ============================================
// STOP FONKSIYONLARI
// ============================================
async function stopRecording() {
  await recordingController.stop();
}

async function stopMonitoring() {
  await monitoringController.stop();
}

// ============================================
// MODUL INITIALIZATION
// ============================================
initProfileController(
  profileController,
  {
    stopMonitoring,
    stopRecording,
    startMonitoring: () => monitoringController.start(),
    startRecording: () => recordingController.start(),
    updateButtonStates: () => uiStateManager.updateButtonStates(),
    updateBufferInfo: (val) => updateBufferInfo(val, UIElements.bufferInfoText),
    updateTimesliceInfo: (val) => updateTimesliceInfo(val, UIElements.timesliceInfoEl),
    updateCategoryUI: (profileId) => updateCategoryUI(profileId, UIElements),
    getRadioValue,
    setSettingDisabled,
    setOptionDisabled,
    getSettingElements,
    resetPlayer: () => player.reset()
  },
  {
    loopbackToggle: UIElements.loopbackToggle,
    customSettingsGrid: UIElements.customSettingsGrid,
    pipelineSection: UIElements.pipelineSection,
    webrtcSection: UIElements.webrtcSection,
    developerSection: UIElements.developerSection,
    settingContainers: UIElements.settingContainers
  },
  { currentMode: getCurrentMode }
);

initUIStateManager(
  uiStateManager,
  {
    ...UIElements,
    timesliceContainerEl: UIElements.timesliceContainerEl,
    recordingPlayerCardEl: UIElements.recordingPlayerCardEl,
    playBtnEl: UIElements.playBtnEl,
    progressBarEl: UIElements.progressBarEl,
    downloadBtnEl: UIElements.downloadBtnEl
  },
  {
    currentMode: getCurrentMode,
    isPreparing: getIsPreparing,
    currentProfileId: () => profileController.getCurrentProfileId(),
    isWorkletSupported: () => WORKLET_SUPPORTED,
    isWasmOpusSupported: () => WASM_OPUS_SUPPORTED
  },
  profileController,
  {
    pipeline: [...UIElements.pipelineRadios],
    encoder: [...UIElements.encoderRadios],
    bitrate: [...UIElements.bitrateRadios],
    mediaBitrate: [...UIElements.mediaBitrateRadios],
    timeslice: [...UIElements.timesliceRadios],
    bufferSize: [...UIElements.bufferSizeRadios]
  }
);

initCustomSettingsPanel(
  customSettingsPanelHandler,
  {
    customSettingsToggle: UIElements.customSettingsToggle,
    customSettingsContent: UIElements.customSettingsContent,
    customSettingsGrid: UIElements.customSettingsGrid
  },
  { getSettingElements, setSettingDisabled },
  profileController
);

initDeviceInfo(deviceInfo, {
  micSelector: UIElements.micSelector,
  refreshMicsBtn: UIElements.refreshMicsBtn
});

uiStateManager.updateButtonStates();

// BUG-3 fix: Controller dependency'leri applyProfile'dan ONCE set et
// (applyProfile event emit eder → listener'lar controller'lara erisir)
const controllerDeps = createControllerDeps(
  { recorder, monitor, player, uiStateManager },
  UIElements,
  deviceInfo
);

recordingController.setDependencies(controllerDeps);
monitoringController.setDependencies(controllerDeps);

profileController.applyProfile(initialProfile);
profileUIManager.updateAll(initialProfile);
customSettingsPanelHandler.updatePanel(initialProfile);

syncInitialUI(UIElements, WORKLET_SUPPORTED, WASM_OPUS_SUPPORTED);

loopbackManager.workletSupported = WORKLET_SUPPORTED;

initDebugConsole(debugConsole, {
  eventBus,
  logger,
  logManager,
  monitor,
  audioEngine,
  diagnosticReportBuilder
});

// Diagnostik rapor sistemi
diagnosticReportBuilder.init({
  metricsCollector: audioMetricsCollector,
  profileController,
  logManager
});

initProfileUIManager(
  profileUIManager,
  {
    scenarioCards: UIElements.scenarioCards,
    navItems: UIElements.navItems,
    pageTitle: UIElements.pageTitle,
    pageTitleIcon: UIElements.pageTitleIcon,
    pageSubtitle: UIElements.pageSubtitle,
    scenarioBadge: UIElements.scenarioBadge,
    scenarioTech: UIElements.scenarioTech
  },
  { currentMode: getCurrentMode, isPreparing: getIsPreparing },
  { updateCustomSettingsPanel: (profileId) => customSettingsPanelHandler.updatePanel(profileId) }
);

// ============================================
// BUTTON HANDLERS
// ============================================
setupButtonHandlers(
  {
    recordToggleBtn: UIElements.recordToggleBtn,
    monitorToggleBtn: UIElements.monitorToggleBtn,
    testBtn: UIElements.testBtn
  },
  { recordingController, monitoringController }
);

const cleanupCountdownHandlers = setupTestCountdownHandlers(UIElements.testCountdownEl, eventBus);

// ============================================
// BASLANGIC - PRE-INITIALIZATION
// ============================================
async function initializeAudio() {
  try {
    await recorder.warmup();
  } catch (err) {
    log.error('Recorder warmup error (non-critical)', { error: err.message, step: 'recorder.warmup' });
  }
  log.system('Audio pre-initialization complete (AudioEngine lazy)', { recorderWarmedUp: recorder.isWarmedUp });
}

let audioWarmupPromise = null;
function warmupAudioOnce() {
  if (!audioWarmupPromise) {
    audioWarmupPromise = initializeAudio();
  }
  return audioWarmupPromise;
}

function registerAudioWarmupTriggers() {
  const options = { once: true, passive: true };
  window.addEventListener('pointerdown', warmupAudioOnce, options);
  window.addEventListener('touchstart', warmupAudioOnce, options);
  window.addEventListener('keydown', warmupAudioOnce, { once: true });
}

registerAudioWarmupTriggers();

log.system('Mic Probe ready. Select a test mode.');
log.system('Application started', {
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  audioContextSupported: !!(window.AudioContext || window.webkitAudioContext),
  mediaDevicesSupported: !!navigator.mediaDevices?.getUserMedia,
  rtcPeerConnectionSupported: !!window.RTCPeerConnection
});

// ============================================
// CLEANUP - PAGE UNLOAD
// ============================================
window.addEventListener('beforeunload', () => {
  vuMeter.destroy();
  deviceInfo.destroy();
  player.destroy();
  audioMetricsCollector.destroy();
  diagnosticReportBuilder.destroy();
  reportPanelUI.destroy();
  profileUIManager.destroy();
  debugConsole.destroy();
  statusManager.destroy();
  document.removeEventListener('keydown', escKeyHandler);
  cleanupCountdownHandlers();
});

// ============================================
// MICRO-INTERACTIONS - BUTTON RIPPLE
// ============================================
document.querySelectorAll('.btn-action').forEach(btn => {
  btn.addEventListener('pointerdown', (e) => {
    const rect = btn.getBoundingClientRect();
    btn.style.setProperty('--ripple-x', `${((e.clientX - rect.left) / rect.width) * 100}%`);
    btn.style.setProperty('--ripple-y', `${((e.clientY - rect.top) / rect.height) * 100}%`);
  });
});
