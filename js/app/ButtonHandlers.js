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
  const { overlay = null, lockBody = false, triggerEl = null } = options;
  const setExpanded = (expanded) => {
    triggerEl?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  };

  return {
    isOpen: () => drawerEl?.classList.contains('open'),
    open() {
      drawerEl?.classList.add('open');
      overlay?.classList.add('open');
      setExpanded(true);
      if (lockBody) document.body.style.overflow = 'hidden';
    },
    close() {
      drawerEl?.classList.remove('open');
      overlay?.classList.remove('open');
      setExpanded(false);
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
    closeConsoleBtn,
    profileSidebar,
    profileMenuBtn,
    navItems = []
  } = elements;

  // Drawer controller'lar olustur
  const settingsDrawerCtrl = createDrawerController(settingsDrawer, { overlay: drawerOverlay, lockBody: true });
  const profileDrawerCtrl = createDrawerController(profileSidebar, { overlay: drawerOverlay, lockBody: true, triggerEl: profileMenuBtn });
  const devConsoleCtrl = createDrawerController(devConsoleDrawer);

  // Event listener'lari bagla
  settingsDrawerCtrl.bindCloseButtons(closeDrawerBtn);
  profileDrawerCtrl.bindButtons(profileMenuBtn);
  profileDrawerCtrl.bindCloseButtons(...navItems);
  drawerOverlay?.addEventListener('click', () => {
    settingsDrawerCtrl.close();
    profileDrawerCtrl.close();
  });
  devConsoleCtrl.bindButtons(devConsoleToggle);
  devConsoleCtrl.bindCloseButtons(closeConsoleBtn);

  return { settingsDrawerCtrl, profileDrawerCtrl, devConsoleCtrl };
}

/**
 * Keyboard handler kaydet (ESC ile drawer kapat)
 * @param {Object} drawerControllers - { settingsDrawerCtrl, devConsoleCtrl }
 * @returns {Function} - Event handler referansi (cleanup icin)
 */
export function setupKeyboardHandlers(drawerControllers) {
  const { settingsDrawerCtrl, profileDrawerCtrl, devConsoleCtrl } = drawerControllers;

  function handleEscapeKey(e) {
    if (e.key === 'Escape') {
      settingsDrawerCtrl.close();
      profileDrawerCtrl?.close();
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
  [EVENTS.TEST_COMPLETED, EVENTS.TEST_CANCELLED, EVENTS.TEST_PLAYBACK_STOPPED, EVENTS.TEST_RECORDING_STOPPED]
    .forEach(event => unsubscribers.push(eventBus.on(event, clearCountdown)));

  // Cleanup fonksiyonu dondur
  return () => unsubscribers.forEach(unsub => typeof unsub === 'function' && unsub());
}
