/**
 * Button Handler Kayitlari
 * Tum buton click handler'larini merkezi yonetim
 */

import { wrapAsyncHandler } from '../modules/utils.js';

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
    'Kayit toggle hatasi'
  );

  // Monitoring toggle
  monitorToggleBtn.onclick = wrapAsyncHandler(
    () => monitoringController.toggle(),
    'Monitor toggle hatasi'
  );

  // Test toggle (sadece varsa)
  if (testBtn) {
    testBtn.onclick = wrapAsyncHandler(
      () => monitoringController.toggleTest(),
      'Test toggle hatasi'
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
 */
export function setupTestCountdownHandlers(testCountdownEl, eventBus) {
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
      log.error('Profil degisikligi hatasi', { profileId: e.target.value, error: err.message });
    }
  }

  if (profileSelector) {
    profileSelector.addEventListener('change', handleProfileChange);
  }

  return handleProfileChange;
}
