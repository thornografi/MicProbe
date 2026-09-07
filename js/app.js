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
import StatusManager from './modules/StatusManager.js';
import DeviceInfo from './modules/DeviceInfo.js';
import { log } from './modules/utils.js';
import { IS_DEV, EVENTS } from './modules/constants.js';
import { isAudioWorkletSupported } from './modules/WorkletHelper.js';
import { isWasmOpusSupported } from './modules/OpusWorkerHelper.js';
import premiumAccess from './modules/PremiumAccess.js';
import accountAccess from './modules/AccountAccess.js';
import { ReportHistory } from './modules/ReportHistory.js';
import AccountPanelUI from './ui/AccountPanelUI.js';
import checkoutStateSnapshot from './modules/CheckoutStateSnapshot.js';
import systemProbeCollector from './modules/SystemProbeCollector.js';
import diagnosticReportBuilder from './modules/DiagnosticReportBuilder.js';
import deepAnalysisEngine from './modules/DeepAnalysisEngine.js';
import reportPanelUI from './ui/ReportPanelUI.js';
import profileController from './controllers/ProfileController.js';
import { readScenarioPreference } from './modules/ScenarioPreference.js';
import uiStateManager from './modules/UIStateManager.js';
import recordingController from './controllers/RecordingController.js';
import TestRecordingFlow from './controllers/TestRecordingFlow.js';
import debugConsole from './ui/DebugConsole.js';
import profileUIManager from './ui/ProfileUIManager.js';
import customSettingsPanelHandler from './ui/CustomSettingsPanelHandler.js';
import CaptureGuideUI from './ui/CaptureGuideUI.js';
import {
  exposeStartupDiagnostics,
  getStartupDiagnosticLogLines,
  getStartupDiagnostics,
  markStartupDiag
} from './modules/StartupDiagnostics.js';

// UI Modulleri
import * as UIElements from './ui/UIElements.js';
import { registerCheckboxLoggers, registerRadioGroups, registerLoopbackToggle } from './ui/RadioHandlers.js';
import {
  setupButtonHandlers,
  setupOverlays,
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

markStartupDiag('app.module.evaluating', {
  path: window.location.pathname,
  readyState: document.readyState
});

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
markStartupDiag('app.logger.ready');

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
  mp3DownloadBtnId: 'downloadMp3Btn',
  noRecordingId: 'noRecording',
  // Call kategorisinde gizli baslayan playback kartinin test sonrasi acilabilmesi icin
  panelEl: UIElements.recordingPlayerPanelEl
});

const recorder = new Recorder({
  constraints: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
});

const deviceInfo = new DeviceInfo();
const statusManager = new StatusManager({
  messageEl: UIElements.userMessageEl,
  captureHintEl: UIElements.captureHintEl,
  micHintEl: UIElements.microphoneHintEl
}, () => ({
  mode: getCurrentMode(), preparing: getIsPreparing(),
  pending: diagnosticReportBuilder.isReportPending(),
  category: profileController.getCurrentProfile()?.category,
  access: deviceInfo.accessState,
  hasResult: !!reportPanelUI.inlineReport
}));

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

const { profileDrawerCtrl, devConsoleCtrl } = setupOverlays({
  drawerOverlay: UIElements.drawerOverlay,
  devConsoleDrawer: UIElements.devConsoleDrawer,
  devConsoleToggle: UIElements.devConsoleToggle,
  closeConsoleBtn: UIElements.closeConsoleBtn,
  profileSidebar: UIElements.profileSidebar,
  profileMenuBtn: UIElements.profileMenuBtn,
  navItems: [...UIElements.navItems],
  inertTargets: [UIElements.mainContentEl, UIElements.sharedFooterEl]
});

// Only an explicit remembered choice can skip the first-use chooser.
const initialProfile = readScenarioPreference();
const captureGuideUI = new CaptureGuideUI();

// ============================================
// STOP FONKSIYONLARI
// ============================================
async function stopRecording() {
  await recordingController.stop();
}

// ============================================
// MODUL INITIALIZATION
// ============================================
initProfileController(
  profileController,
  {
    stopRecording,
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
  { getSettingElements, setSettingDisabled, getIsBusy: isWorkflowBusy },
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
  { recorder, player, uiStateManager, profileController },
  UIElements,
  deviceInfo
);
const createRunSnapshot = controllerDeps.createRunSnapshot;
// Capture identity with the same pre-permission snapshot as the requested settings.
// A later sign-in/logout cannot transfer an in-flight recording to another account.
controllerDeps.createRunSnapshot = () => Object.freeze({
  ...createRunSnapshot(), accountOwnerId: accountAccess.getState().user?.id || null
});

recordingController.setDependencies(controllerDeps);
const testRecordingFlow = new TestRecordingFlow(controllerDeps);

if (initialProfile) profileController.applyProfile(initialProfile);
// NOT: profileUIManager.updateAll BURADA CAGRILMAZ - elements henuz bagli degil
// (initProfileUIManager asagida). Init oncesi cagri sessiz no-op olur ve
// restore edilen profil nav/baslikta gorunmezdi.
if (initialProfile) customSettingsPanelHandler.updatePanel(initialProfile);

syncInitialUI(UIElements, WORKLET_SUPPORTED, WASM_OPUS_SUPPORTED);

initDebugConsole(debugConsole, {
  eventBus,
  logger,
  logManager,
  audioEngine,
  diagnosticReportBuilder,
  elements: {
    clearLogBtn: UIElements.clearLogBtn,
    copyLogsBtn: UIElements.copyLogsBtn,
    exportLogsBtn: UIElements.exportLogsBtn,
    logStatsBtn: UIElements.logStatsBtn,
    sanityCheckBtn: UIElements.sanityCheckBtn,
    logFilterButtonsEl: UIElements.logFilterButtonsEl
  }
});
markStartupDiag('app.debugConsole.ready');
exposeStartupDiagnostics();

let startupDiagnosticsFlushCount = 0;
window.__micprobeFlushStartupDiagnosticsToLog = (reason = 'manual') => {
  startupDiagnosticsFlushCount += 1;
  markStartupDiag('diag.flush.requested', { reason, count: startupDiagnosticsFlushCount });
  const startupDiagnosticsSnapshot = getStartupDiagnostics();
  getStartupDiagnosticLogLines().forEach((line, index) => {
    log.webaudio(line, index === 0 ? startupDiagnosticsSnapshot : { startupDiagId: startupDiagnosticsSnapshot.id });
  });
  return startupDiagnosticsSnapshot;
};

// Diagnostik rapor sistemi
diagnosticReportBuilder.init({
  systemProbeCollector,
  deepAnalysisEngine,
  logManager
});

const reportHistory = new ReportHistory({ account: accountAccess });
const unsubscribeHistoryCapture = eventBus.on(EVENTS.DIAGNOSTIC_REPORT_READY, report => reportHistory.capture(report));
function isWorkflowBusy() { return !!(getIsPreparing() || getCurrentMode() || diagnosticReportBuilder.isReportPending()); }
const openSavedReport = report => {
  diagnosticReportBuilder.restoreReport(report);
  reportPanelUI.open();
};
const accountPanelUI = new AccountPanelUI({
  elements: {
    dialog: UIElements.accountDialogEl,
    menuButton: UIElements.accountMenuBtnEl,
    historyButton: UIElements.reportHistoryBtnEl,
    identity: UIElements.accountIdentityEl,
    historyList: UIElements.accountHistoryListEl,
    status: UIElements.accountStatusEl,
    comparison: UIElements.accountComparisonEl,
    historyActions: UIElements.accountHistoryActionsEl
  },
  premiumAccess,
  history: reportHistory,
  getIsBusy: isWorkflowBusy,
  onBeforeOpen: () => reportPanelUI.close(),
  onRestoreLegacyPurchase: key => premiumAccess.restoreLegacyPurchase(key),
  onOpenReport: openSavedReport,
  onAccountChanged: () => reportPanelUI.clearReport(),
  onCheckout: () => {
    checkoutStateSnapshot.save({ report: reportPanelUI.currentReport, ownerId: accountAccess.getState().user?.id || null,
      profileId: profileController.getCurrentProfileId() });
    return premiumAccess.startCheckout();
  }
});
reportPanelUI.setWorkflowActions({
  getIsBusy: isWorkflowBusy,
  canCompare: report => accountPanelUI.comparisonPair(report).length === 2,
  onCompare: report => accountPanelUI.compareWithPrevious(report),
  onRetest: report => {
    if (isWorkflowBusy() || report?.profile?.id !== profileController.getCurrentProfileId()) return;
    reportPanelUI.close();
    const action = profileController.getCurrentProfile()?.canTest ? UIElements.testBtn : UIElements.recordToggleBtn;
    action?.scrollIntoView({ block: 'center' });
    action?.focus();
    action?.click();
  }
});
const unsubscribeWorkflowHistory = reportHistory.subscribe(() => reportPanelUI.syncWorkflowActions());
// Error status can precede a synchronous controller reset. Read the settled
// state without rebuilding history cards and discarding unsaved note drafts.
const unsubscribeHistoryBusy = [EVENTS.STATUS_CHANGED, EVENTS.TEST_CANCELLED, EVENTS.DIAGNOSTIC_REPORT_READY]
  .map(event => eventBus.on(event, () => queueMicrotask(() => accountPanelUI.syncBusyState())));

const restoreOwnedCheckout = state => {
  if (!state.ready || state.error) return;
  const restored = checkoutStateSnapshot.consume({ ownerId: state.user?.id || null });
  if (!restored?.report) return;
  if (restored.profileId) {
    profileController.applyProfile(restored.profileId);
    profileUIManager.updateAll(restored.profileId);
    customSettingsPanelHandler.updatePanel(restored.profileId);
  }
  // A restored snapshot already belongs to history; it is never a fresh capture.
  reportHistory.open(restored, openSavedReport);
};
const unsubscribeCheckoutRestore = accountAccess.subscribe(restoreOwnedCheckout);
premiumAccess.bootstrap().then(() => restoreOwnedCheckout(accountAccess.getState()));
const refreshVisibleAccount = () => {
  if (document.visibilityState === 'visible' && accountAccess.getState().ready
    && accountAccess.getState().configured) accountAccess.refresh({ sessionOnly: true });
};
window.addEventListener('focus', refreshVisibleAccount);
document.addEventListener('visibilitychange', refreshVisibleAccount);

initProfileUIManager(
  profileUIManager,
  {
    navItems: UIElements.navItems,
    pageTitle: UIElements.pageTitle,
    pageTitleIcon: UIElements.pageTitleIcon,
    pageSubtitle: UIElements.pageSubtitle,
    scenarioPicker: UIElements.scenarioPicker,
    scenarioChoices: UIElements.scenarioChoices,
    scenarioWorkspace: UIElements.scenarioWorkspace,
    changeScenarioBtn: UIElements.changeScenarioBtn,
    profileSidebar: UIElements.profileSidebar,
    profileMenuBtn: UIElements.profileMenuBtn,
    devConsoleToggle: UIElements.devConsoleToggle
  },
  { currentMode: getCurrentMode, isPreparing: getIsPreparing,
    isReportPending: () => diagnosticReportBuilder.isReportPending() },
  { updateCustomSettingsPanel: (profileId) => customSettingsPanelHandler.updatePanel(profileId),
    pausePlayback: () => player.pause() }
);

// Read the controller after binding: an owned checkout may have restored a
// different scenario. First use has no profile and keeps capture out of view.
profileUIManager.updateAll(profileController.getCurrentProfileId());

// ============================================
// BUTTON HANDLERS
// ============================================
setupButtonHandlers(
  {
    recordToggleBtn: UIElements.recordToggleBtn,
    testBtn: UIElements.testBtn
  },
  { recordingController, testRecordingFlow }
);

const cleanupCountdownHandlers = setupTestCountdownHandlers(UIElements.testCountdownEl, UIElements.testProgressFillEl, eventBus);

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
markStartupDiag('app.ready', {
  currentProfileId: profileController.getCurrentProfileId(),
  workletSupported: WORKLET_SUPPORTED,
  wasmOpusSupported: WASM_OPUS_SUPPORTED
});

// ============================================
// CLEANUP - PAGE UNLOAD
// ============================================
window.addEventListener('beforeunload', () => {
  vuMeter.destroy();
  captureGuideUI.destroy();
  deviceInfo.destroy();
  player.destroy();
  systemProbeCollector.destroy();
  deepAnalysisEngine.destroy();
  diagnosticReportBuilder.destroy();
  reportPanelUI.destroy();
  unsubscribeHistoryCapture();
  unsubscribeHistoryBusy.forEach(unsubscribe => unsubscribe());
  unsubscribeCheckoutRestore();
  window.removeEventListener('focus', refreshVisibleAccount);
  document.removeEventListener('visibilitychange', refreshVisibleAccount);
  reportHistory.destroy();
  accountPanelUI.destroy();
  customSettingsPanelHandler.destroy();
  unsubscribeWorkflowHistory();
  profileUIManager.destroy();
  debugConsole.destroy();
  statusManager.destroy();
  profileDrawerCtrl.destroy();
  devConsoleCtrl.destroy();
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
