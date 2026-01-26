/**
 * UI Element Referanslari
 * Tum DOM element referanslarini merkezi yonetim
 */

// ============================================
// BUTON ELEMENTLERI
// ============================================
export const recordToggleBtn = document.getElementById('recordToggle');
export const monitorToggleBtn = document.getElementById('monitorToggle');
export const testBtn = document.getElementById('testBtn');
export const testCountdownEl = document.getElementById('testCountdown');
export const playBtnEl = document.getElementById('playBtn');
export const downloadBtnEl = document.getElementById('downloadBtn');
export const closeDrawerBtn = document.getElementById('closeDrawer');
export const closeConsoleBtn = document.getElementById('closeConsole');
export const devConsoleToggle = document.getElementById('devConsoleToggle');
export const refreshMicsBtn = document.getElementById('refreshMics');

// ============================================
// TOGGLE & CHECKBOX ELEMENTLERI
// ============================================
export const loopbackToggle = document.getElementById('loopbackToggle');
export const ecCheckbox = document.getElementById('ec');
export const nsCheckbox = document.getElementById('ns');
export const agcCheckbox = document.getElementById('agc');

// ============================================
// SELECTOR & INPUT ELEMENTLERI
// ============================================
export const profileSelector = document.getElementById('profileSelector');
export const micSelector = document.getElementById('micSelector');

// ============================================
// CONTAINER ELEMENTLERI
// ============================================
export const opusBitrateContainer = document.getElementById('opusBitrateContainer');
export const pipelineContainer = document.getElementById('pipelineContainer');
export const encoderContainer = document.getElementById('encoderContainer');
export const bufferSizeContainer = document.getElementById('bufferSizeContainer');
export const bufferInfoText = document.getElementById('bufferInfoText');
export const timesliceInfoEl = document.getElementById('timesliceInfo');

// ============================================
// PLAYER ELEMENTLERI
// ============================================
export const recordingPlayerEl = document.getElementById('recordingPlayer');
export const recordingPlayerCardEl = recordingPlayerEl ? recordingPlayerEl.closest('.card') : null;
export const recordingPlayerPanelEl = recordingPlayerEl ? recordingPlayerEl.closest('.panel-player') : null;
export const progressBarEl = document.getElementById('progressBar');

// ============================================
// DRAWER ELEMENTLERI
// ============================================
export const settingsDrawer = document.getElementById('settingsDrawer');
export const drawerOverlay = document.getElementById('drawerOverlay');
export const devConsoleDrawer = document.getElementById('devConsoleDrawer');

// ============================================
// SECTION ELEMENTLERI
// ============================================
export const pipelineSection = document.getElementById('pipelineSection');
export const webrtcSection = document.getElementById('webrtcSection');
export const developerSection = document.getElementById('developerSection');

// ============================================
// CUSTOM SETTINGS PANEL
// ============================================
export const customSettingsToggle = document.getElementById('customSettingsToggle');
export const customSettingsContent = document.getElementById('customSettingsContent');
export const customSettingsGrid = document.getElementById('customSettingsGrid');

// ============================================
// SIDEBAR & HEADER ELEMENTLERI
// ============================================
export const pageTitle = document.getElementById('pageTitle');
export const pageTitleIcon = document.getElementById('pageTitleIcon');
export const pageSubtitle = document.getElementById('pageSubtitle');
export const scenarioBadge = document.getElementById('scenarioBadge');
export const scenarioTech = document.getElementById('scenarioTech');
export const headerBrandLink = document.querySelector('.brand-mark');
export const footerBrandLink = document.querySelector('.site-footer-brand');
export const footerLinks = document.querySelectorAll('.site-footer-links a');

// ============================================
// TIMER ELEMENTLERI
// ============================================
export const timerEl = document.getElementById('recordingTimer');

// ============================================
// DATA-SETTING CONTAINER CACHE
// ============================================
export const settingContainers = {
  webaudio: document.querySelector('[data-setting="webaudio"]'),
  pipeline: document.querySelector('[data-setting="pipeline"]'),
  encoder: document.querySelector('[data-setting="encoder"]'),
  buffer: document.querySelector('[data-setting="buffer"]'),
  loopback: document.querySelector('[data-setting="loopback"]'),
  bitrate: document.querySelector('[data-setting="bitrate"]'),
  mediaBitrate: document.querySelector('[data-setting="mediaBitrate"]'),
  timeslice: document.querySelector('[data-setting="timeslice"]')
};

export const timesliceContainerEl = settingContainers.timeslice;

// ============================================
// RADIO BUTON KOLEKSIYONLARI
// ============================================
export const pipelineRadios = document.querySelectorAll('input[name="pipeline"]');
export const encoderRadios = document.querySelectorAll('input[name="encoder"]');
export const bitrateRadios = document.querySelectorAll('input[name="bitrate"]');
export const timesliceRadios = document.querySelectorAll('input[name="timeslice"]');
export const bufferSizeRadios = document.querySelectorAll('input[name="bufferSize"]');
export const mediaBitrateRadios = document.querySelectorAll('input[name="mediaBitrate"]');
export const sampleRateRadios = document.querySelectorAll('input[name="sampleRate"]');
export const channelCountRadios = document.querySelectorAll('input[name="channelCount"]');

// ============================================
// SENARYO & NAV KOLEKSIYONLARI
// ============================================
export const scenarioCards = document.querySelectorAll('.scenario-card');
export const navItems = document.querySelectorAll('.nav-item[data-profile]');
