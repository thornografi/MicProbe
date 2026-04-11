/**
 * Button Handler Kayitlari
 * Tum buton click handler'larini merkezi yonetim
 */

import { wrapAsyncHandler } from '../modules/utils.js';
import { EVENTS } from '../modules/constants.js';

/**
 * Ana buton handler'larini kaydet
 * @param {Object} elements - Buton elementleri
 * @param {Object} controllers - Controller referanslari
 */
export function setupButtonHandlers(elements, controllers) {
  const { recordToggleBtn, monitorToggleBtn, testBtn } = elements;
  const { recordingController, monitoringController } = controllers;

  // Recording toggle
  recordToggleBtn.onclick = wrapAsyncHandler(
    () => recordingController.toggle(),
    'Recording toggle error'
  );

  // Monitoring toggle
  monitorToggleBtn.onclick = wrapAsyncHandler(
    () => monitoringController.toggle(),
    'Monitor toggle error'
  );

  // Test toggle (sadece varsa)
  if (testBtn) {
    testBtn.onclick = wrapAsyncHandler(
      () => monitoringController.toggleTest(),
      'Test toggle error'
    );
  }
}

/**
 * Drawer controller factory (DRY)
 * @param {HTMLElement} drawerEl - Drawer elementi
 * @param {Object} options - { overlay, lockBody }
 * @returns {Object} Drawer controller
 */
export function createDrawerController(drawerEl, options = {}) {
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

/**
 * Drawer handler'larini kaydet
 * @param {Object} elements - Drawer elementleri
 * @returns {Object} - { settingsDrawerCtrl, devConsoleCtrl }
 */
export function setupDrawerHandlers(elements) {
  const {
    settingsDrawer,
    drawerOverlay,
    closeDrawerBtn,
    devConsoleDrawer,
    devConsoleToggle,
    closeConsoleBtn
  } = elements;

  // Drawer controller'lar olustur
  const settingsDrawerCtrl = createDrawerController(settingsDrawer, { overlay: drawerOverlay, lockBody: true });
  const devConsoleCtrl = createDrawerController(devConsoleDrawer);

  // Event listener'lari bagla
  settingsDrawerCtrl.bindCloseButtons(closeDrawerBtn, drawerOverlay);
  devConsoleCtrl.bindButtons(devConsoleToggle);
  devConsoleCtrl.bindCloseButtons(closeConsoleBtn);

  return { settingsDrawerCtrl, devConsoleCtrl };
}

/**
 * Keyboard handler kaydet (ESC ile drawer kapat)
 * @param {Object} drawerControllers - { settingsDrawerCtrl, devConsoleCtrl }
 * @returns {Function} - Event handler referansi (cleanup icin)
 */
export function setupKeyboardHandlers(drawerControllers) {
  const { settingsDrawerCtrl, devConsoleCtrl } = drawerControllers;

  function handleEscapeKey(e) {
    if (e.key === 'Escape') {
      settingsDrawerCtrl.close();
      devConsoleCtrl.close();
    }
  }

  document.addEventListener('keydown', handleEscapeKey);
  return handleEscapeKey;
}

/**
 * Test countdown event handler'larini kaydet
 * @param {HTMLElement} testCountdownEl - Countdown elementi
 * @param {Object} eventBus - EventBus referansi
 * @returns {Function} - Cleanup fonksiyonu (unsubscribe icin)
 */
export function setupTestCountdownHandlers(testCountdownEl, eventBus) {
  const unsubscribers = [];

  // Test countdown event listener
  const onCountdown = ({ remainingSec }) => {
    if (testCountdownEl) {
      testCountdownEl.textContent = remainingSec > 0 ? `${remainingSec}s` : '';
    }
  };
  unsubscribers.push(eventBus.on(EVENTS.TEST_COUNTDOWN, onCountdown));

  // Test tamamlandiginda/iptal edildiginde countdown temizle
  const clearCountdown = () => { if (testCountdownEl) testCountdownEl.textContent = ''; };
  [EVENTS.TEST_COMPLETED, EVENTS.TEST_CANCELLED, EVENTS.TEST_PLAYBACK_STOPPED]
    .forEach(event => unsubscribers.push(eventBus.on(event, clearCountdown)));

  // Cleanup fonksiyonu dondur
  return () => unsubscribers.forEach(unsub => typeof unsub === 'function' && unsub());
}

/**
 * Profil selector handler kaydet
 * @param {HTMLElement} profileSelector - Profil selector elementi
 * @param {Object} profileController - ProfileController referansi
 * @param {Object} log - Log fonksiyonu
 * @returns {Function} - Event handler referansi (cleanup icin)
 */
export function setupProfileSelectorHandler(profileSelector, profileController, log) {
  async function handleProfileChange(e) {
    try {
      await profileController.applyProfile(e.target.value);
    } catch (err) {
      log.error('Profile change error', { profileId: e.target.value, error: err.message });
    }
  }

  if (profileSelector) {
    profileSelector.addEventListener('change', handleProfileChange);
  }

  return handleProfileChange;
}
