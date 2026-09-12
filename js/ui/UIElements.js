/**
 * UI Element Referanslari
 * Tum DOM element referanslarini merkezi yonetim
 *
 * Null Guard: Her querySelector/getElementById sonrasi null check yapilir.
 * Eksik element bulunursa console.warn ile bildirilir (silent failure onleme).
 */
import { SETTING_NAMES, IS_DEV } from '../modules/constants.js';

// ============================================
// NULL GUARD HELPER
// ============================================
function getEl(id) {
  const el = document.getElementById(id);
  if (!el && IS_DEV) console.warn(`[UIElements] Element not found: #${id}`);
  return el;
}

function queryEl(selector) {
  const el = document.querySelector(selector);
  if (!el && IS_DEV) console.warn(`[UIElements] Element not found: ${selector}`);
  return el;
}

function queryAll(selector) {
  const els = document.querySelectorAll(selector);
  if (els.length === 0 && IS_DEV) console.warn(`[UIElements] Collection empty: ${selector}`);
  return els;
}

// ============================================
// BUTON ELEMENTLERI
// ============================================
export const recordToggleBtn = getEl('recordToggle');
export const testBtn = getEl('testBtn');
export const testProgressFillEl = getEl('testProgressFill');
export const playBtnEl = getEl('playBtn');
export const downloadBtnEl = getEl('downloadBtn');
export const downloadMp3BtnEl = getEl('downloadMp3Btn');
export const downloadMenuBtnEl = getEl('downloadMenuBtn');
export const closeConsoleBtn = getEl('closeConsole');
export const devConsoleToggle = getEl('devConsoleToggle');
export const refreshMicsBtn = getEl('refreshMics');

// ============================================
// TOGGLE & CHECKBOX ELEMENTLERI
// ============================================
export const loopbackToggle = getEl('loopbackToggle');
export const ecCheckbox = getEl('ec');
export const nsCheckbox = getEl('ns');
export const agcCheckbox = getEl('agc');

// ============================================
// SELECTOR & INPUT ELEMENTLERI
// ============================================
export const micSelector = getEl('micSelector');

// ============================================
// VU METER ELEMENTLERI
// ============================================
export const remoteVuContainerEl = getEl('remoteVuContainer');

// ============================================
// RAPOR PANEL ELEMENTLERI
// ============================================
export const reportPanelEl = getEl('reportPanel');
export const reportPopupCloseEl = getEl('reportPopupClose');
export const reportDownloadBtnEl = getEl('reportDownloadBtn');
export const reportScoreBadgeEl = getEl('reportScoreBadge');
export const reportOverallEl = getEl('reportOverall');
export const reportFindingsEl = getEl('reportFindings');
export const reportMetricsGridEl = getEl('reportMetricsGrid');
export const reportRecommendationsEl = getEl('reportRecommendations');
export const reportDetailedEl = getEl('reportDetailed');
export const reportDetailedWrapperEl = getEl('reportDetailedWrapper');
export const premiumOverlayEl = getEl('premiumOverlay');
export const premiumCtaEl = getEl('premiumCta');
export const premiumStatusEl = getEl('premiumStatus');
export const showReportBtnEl = getEl('showReportBtn');

// ============================================
// PLAYER ELEMENTLERI
// ============================================
export const recordingPlayerEl = getEl('recordingPlayer');
export const recordingPlayerRowEl = recordingPlayerEl ? recordingPlayerEl.closest('.unified-row-player') : null;
export const recordingPlayerPanelEl = recordingPlayerRowEl;
export const progressBarEl = getEl('progressBar');

// ============================================
// DRAWER ELEMENTLERI
// ============================================
export const devConsoleDrawer = getEl('devConsole');

// ============================================
// CUSTOM SETTINGS PANEL
// ============================================
export const customSettingsToggle = getEl('customSettingsToggle');
export const customSettingsContent = getEl('customSettingsContent');
export const customSettingsGrid = getEl('customSettingsGrid');

// ============================================
// SIDEBAR & HEADER ELEMENTLERI
// ============================================
export const pageTitle = getEl('pageTitle');
export const pageTitleIcon = getEl('pageTitleIcon');
export const pageSubtitle = getEl('pageSubtitle');
export const scenarioPicker = getEl('scenarioPicker');
export const scenarioChoices = getEl('scenarioChoices');
export const scenarioWorkspace = getEl('scenarioWorkspace');
export const changeScenarioBtn = getEl('changeScenarioBtn');
export const userMessageEl = getEl('userMessage');
export const captureHintEl = getEl('captureHint');
export const microphoneHintEl = getEl('microphoneHint');

// ============================================
// DEV CONSOLE
// ============================================
export const clearLogBtn = getEl('clearLogBtn');
export const copyLogsBtn = getEl('copyLogsBtn');
export const exportLogsBtn = getEl('exportLogsBtn');
export const logStatsBtn = getEl('logStatsBtn');
export const sanityCheckBtn = getEl('sanityCheckBtn');
export const logFilterButtonsEl = queryEl('.filter-buttons');

// ============================================
// ACCOUNT / HISTORY DIALOG
// ============================================
export const accountDialogEl = getEl('accountDialog');
export const accountMenuBtnEl = getEl('accountMenuBtn');
export const reportHistoryBtnEl = getEl('reportHistoryBtn');
export const accountIdentityEl = getEl('accountIdentity');
export const accountHistoryListEl = getEl('accountHistoryList');
export const accountStatusEl = getEl('accountStatus');
export const accountHistoryActionsEl = getEl('accountHistoryActions');

// ============================================
// OVERLAY INERT HEDEFLERI (mobil profil cekmecesi acikken arka plan)
// ============================================
export const mainContentEl = document.querySelector('.main-content');
export const sharedFooterEl = getEl('sharedFooter');
export const reportTroubleshootingContextEl = getEl('reportTroubleshootingContext');
export const headerBrandLink = getEl('appHeaderBrand');

// ============================================
// TIMER ELEMENTLERI
// ============================================

// ============================================
// RADIO BUTON KOLEKSIYONLARI
// ============================================
export const pipelineRadios = queryAll(`input[name="${SETTING_NAMES.PIPELINE}"]`);
export const encoderRadios = queryAll(`input[name="${SETTING_NAMES.ENCODER}"]`);
export const bitrateRadios = queryAll(`input[name="${SETTING_NAMES.BITRATE}"]`);
export const timesliceRadios = queryAll(`input[name="${SETTING_NAMES.TIMESLICE}"]`);
export const bufferSizeRadios = queryAll(`input[name="${SETTING_NAMES.BUFFER_SIZE}"]`);
export const mediaBitrateRadios = queryAll(`input[name="${SETTING_NAMES.MEDIA_BITRATE}"]`);
export const sampleRateRadios = queryAll(`input[name="${SETTING_NAMES.SAMPLE_RATE}"]`);
export const channelCountRadios = queryAll(`input[name="${SETTING_NAMES.CHANNEL_COUNT}"]`);

// ============================================
// SENARYO & NAV KOLEKSIYONLARI
// ============================================
export const navItems = queryAll('.nav-item[data-profile]');
