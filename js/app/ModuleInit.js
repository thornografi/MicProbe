/**
 * ModuleInit - Modul initialization fonksiyonlari
 */
import { toggleDisplay, log, usesWebAudio } from '../modules/utils.js';
import { PROFILES } from '../modules/Config.js';

/**
 * ProfileController initialization
 */
export function initProfileController(profileController, callbacks, elements, stateGetters) {
  profileController.init({
    loopbackToggle: elements.loopbackToggle,
    profileSelector: elements.profileSelector,
    customSettingsGrid: elements.customSettingsGrid,
    pipelineSection: elements.pipelineSection,
    webrtcSection: elements.webrtcSection,
    developerSection: elements.developerSection
  });

  profileController.setSettingContainers(elements.settingContainers);
  profileController.setCallbacks(callbacks);
  profileController.setStateGetters(stateGetters);
}

/**
 * UIStateManager initialization
 */
export function initUIStateManager(uiStateManager, elements, stateGetters, profileController, radioGroups) {
  uiStateManager.init({
    recordToggleBtn: elements.recordToggleBtn,
    monitorToggleBtn: elements.monitorToggleBtn,
    testBtn: elements.testBtn,
    testCountdownEl: elements.testCountdownEl,
    loopbackToggle: elements.loopbackToggle,
    ecCheckbox: elements.ecCheckbox,
    nsCheckbox: elements.nsCheckbox,
    agcCheckbox: elements.agcCheckbox,
    pipelineContainer: elements.pipelineContainer,
    encoderContainer: elements.encoderContainer,
    timesliceContainer: elements.timesliceContainerEl,
    recordingPlayerCard: elements.recordingPlayerCardEl,
    playBtn: elements.playBtnEl,
    progressBar: elements.progressBarEl,
    downloadBtn: elements.downloadBtnEl,
    micSelector: elements.micSelector,
    refreshMicsBtn: elements.refreshMicsBtn,
    profileSelector: elements.profileSelector,
    timerEl: elements.timerEl,
    headerBrandLink: elements.headerBrandLink,
    customSettingsToggle: elements.customSettingsToggle,
    footerBrandLink: elements.footerBrandLink,
    settingsDrawer: elements.settingsDrawer,
    drawerOverlay: elements.drawerOverlay
  });

  uiStateManager.setRadioGroups(radioGroups);
  uiStateManager.setStateGetters(stateGetters);
  uiStateManager.setProfileCollections({
    navItems: [...elements.navItems],
    scenarioCards: [...elements.scenarioCards]
  });
  uiStateManager.setFooterLinks([...elements.footerLinks]);
  uiStateManager.setProfileController(profileController);
}

/**
 * CustomSettingsPanelHandler initialization
 */
export function initCustomSettingsPanel(handler, elements, callbacks, profileController) {
  handler.init({
    customSettingsToggle: elements.customSettingsToggle,
    customSettingsContent: elements.customSettingsContent,
    customSettingsGrid: elements.customSettingsGrid
  });

  handler.setCallbacks(callbacks);
  handler.setDependencies({ profileController });
}

/**
 * DeviceInfo initialization
 */
export function initDeviceInfo(deviceInfo, elements) {
  deviceInfo.initMicSelector({
    micSelector: elements.micSelector,
    refreshMicsBtn: elements.refreshMicsBtn
  });
}

/**
 * DebugConsole initialization
 */
export function initDebugConsole(debugConsole, deps) {
  debugConsole.init(deps);
  debugConsole.registerGlobals();
}

/**
 * ProfileUIManager initialization
 */
export function initProfileUIManager(profileUIManager, elements, stateGetters, callbacks) {
  profileUIManager.init({
    scenarioCards: elements.scenarioCards,
    navItems: elements.navItems,
    pageTitle: elements.pageTitle,
    pageTitleIcon: elements.pageTitleIcon,
    pageSubtitle: elements.pageSubtitle,
    scenarioBadge: elements.scenarioBadge,
    scenarioTech: elements.scenarioTech,
    profileSelector: elements.profileSelector
  });
  profileUIManager.setStateGetters(stateGetters);
  profileUIManager.setCallbacks(callbacks);
}

/**
 * Kategori bazli UI gorunurlugu
 */
export function updateCategoryUI(profileId, elements) {
  const profile = PROFILES[profileId];
  if (!profile) return;

  const { canMonitor, canRecord, category } = profile;
  const loopbackValue = profile.values?.loopback;

  toggleDisplay(elements.monitorToggleBtn, canMonitor, 'flex');
  toggleDisplay(elements.recordToggleBtn, canRecord, 'flex');

  const isCallCategory = category === 'call';
  toggleDisplay(elements.testBtn, isCallCategory && canMonitor, 'flex');
  toggleDisplay(elements.recordingPlayerPanelEl, canRecord);

  const remoteVuContainer = document.getElementById('remoteVuContainer');
  toggleDisplay(remoteVuContainer, loopbackValue === true);

  log.ui(`Kategori UI guncellendi: ${category}`, {
    category,
    canMonitor,
    canRecord,
    remoteVuVisible: loopbackValue === true
  });
}

/**
 * Baslangic UI senkronizasyonu
 */
export function syncInitialUI(elements, isWebAudioEnabled, workletSupported, wasmOpusSupported) {
  toggleDisplay(elements.pipelineContainer, isWebAudioEnabled);
  toggleDisplay(elements.encoderContainer, true);

  if (!workletSupported) {
    log.system('AudioWorklet desteklenmiyor - Worklet secenekleri devre disi', {});
  }

  if (!wasmOpusSupported) {
    log.system('WASM Opus desteklenmiyor - WASM Opus secenegi devre disi', {});
    const wasmOpusOption = document.querySelector('[data-requires-wasm="true"]');
    if (wasmOpusOption) {
      wasmOpusOption.disabled = true;
      const label = wasmOpusOption.nextElementSibling;
      if (label) {
        label.classList.add('option-disabled');
      }
    }
  } else {
    log.system('WASM Opus destegi aktif', {});
  }
}
