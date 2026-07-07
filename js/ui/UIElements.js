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
export const monitorToggleBtn = getEl('monitorToggle');
export const testBtn = getEl('testBtn');
export const profileMenuBtn = getEl('profileMenuBtn');
export const testCountdownEl = getEl('testCountdown');
export const playBtnEl = getEl('playBtn');
export const downloadBtnEl = getEl('downloadBtn');
export const closeDrawerBtn = getEl('closeDrawer');
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
// CONTAINER ELEMENTLERI
// ============================================
export const opusBitrateContainer = getEl('opusBitrateContainer');
export const pipelineContainer = getEl('pipelineContainer');
export const encoderContainer = getEl('encoderContainer');
export const bufferSizeContainer = getEl('bufferSizeContainer');
export const bufferInfoText = getEl('bufferInfoText');
export const timesliceInfoEl = getEl('timesliceInfo');

// ============================================
// VU METER ELEMENTLERI
// ============================================
export const remoteVuContainerEl = getEl('remoteVuContainer');

// ============================================
// RAPOR PANEL ELEMENTLERI
// ============================================
export const reportPopupBackdropEl = getEl('reportPopupBackdrop');
export const reportPanelEl = getEl('reportPanel');
export const reportPopupCloseEl = getEl('reportPopupClose');
export const reportScoreBadgeEl = getEl('reportScoreBadge');
export const reportOverallEl = getEl('reportOverall');
export const reportFindingsEl = getEl('reportFindings');
export const reportMetricsGridEl = getEl('reportMetricsGrid');
export const reportRecommendationsEl = getEl('reportRecommendations');
export const reportDetailedEl = getEl('reportDetailed');
export const premiumOverlayEl = getEl('premiumOverlay');
export const premiumCtaEl = getEl('premiumCta');
export const premiumStatusEl = getEl('premiumStatus');
export const showReportBtnEl = getEl('showReportBtn');

// ============================================
// PLAYER ELEMENTLERI
// ============================================
export const recordingPlayerEl = getEl('recordingPlayer');
export const recordingPlayerRowEl = recordingPlayerEl ? recordingPlayerEl.closest('.unified-row-player') : null;
export const recordingPlayerCardEl = recordingPlayerRowEl;
export const recordingPlayerPanelEl = recordingPlayerRowEl;
export const progressBarEl = getEl('progressBar');

// ============================================
// DRAWER ELEMENTLERI
// ============================================
export const settingsDrawer = getEl('settingsDrawer');
export const drawerOverlay = getEl('drawerOverlay');
export const devConsoleDrawer = getEl('devConsole');
export const profileSidebar = getEl('profileSidebar');

// ============================================
// SECTION ELEMENTLERI
// ============================================
export const pipelineSection = getEl('pipelineSection');
export const webrtcSection = getEl('webrtcSection');
export const developerSection = getEl('developerSection');

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
export const userMessageEl = getEl('userMessage');
export const scenarioBadge = getEl('scenarioBadge');
export const scenarioTech = getEl('scenarioTech');
export const headerBrandLink = getEl('appHeaderBrand');
export const footerBrandLink = queryEl('.site-footer-brand');
export const footerLinks = queryAll('.site-footer-links a');

// ============================================
// TIMER ELEMENTLERI
// ============================================
export const timerEl = getEl('recordingTimer');

// ============================================
// DATA-SETTING CONTAINER CACHE
// ============================================
export const settingContainers = {
  webaudio: document.querySelector('[data-setting="webaudio"]'),
  pipeline: document.querySelector(`[data-setting="${SETTING_NAMES.PIPELINE}"]`),
  encoder: document.querySelector(`[data-setting="${SETTING_NAMES.ENCODER}"]`),
  buffer: document.querySelector('[data-setting="buffer"]'),
  loopback: document.querySelector('[data-setting="loopback"]'),
  bitrate: document.querySelector(`[data-setting="${SETTING_NAMES.BITRATE}"]`),
  mediaBitrate: document.querySelector(`[data-setting="${SETTING_NAMES.MEDIA_BITRATE}"]`),
  timeslice: document.querySelector(`[data-setting="${SETTING_NAMES.TIMESLICE}"]`)
};

export const timesliceContainerEl = settingContainers.timeslice;

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
export const scenarioCards = document.querySelectorAll('.scenario-card');
export const navItems = queryAll('.nav-item[data-profile]');
