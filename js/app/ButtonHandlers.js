/**
 * Button Handler Kayitlari
 * Tum buton click handler'larini merkezi yonetim
 */

import { wrapAsyncHandler } from '../modules/utils.js';
import { EVENTS } from '../modules/constants.js';
import { createOverlayController } from '../ui/OverlayController.js';

/**
 * Ana buton handler'larini kaydet
 * @param {Object} elements - Buton elementleri
 * @param {Object} controllers - Controller referanslari
 */
export function setupButtonHandlers(elements, controllers) {
  const { recordToggleBtn, testBtn } = elements;
  const { recordingController, testRecordingFlow } = controllers;

  // Recording toggle (sadece varsa - getEl null donebilir, guard'siz atama tum init'i cokertir)
  if (recordToggleBtn) {
    recordToggleBtn.onclick = wrapAsyncHandler(
      () => recordingController.toggle(),
      'Recording toggle error'
    );
  }

  // Test toggle (sadece varsa)
  if (testBtn) {
    testBtn.onclick = wrapAsyncHandler(
      () => testRecordingFlow.toggle(),
      'Test toggle error'
    );
  }
}

/**
 * Overlay'leri OverlayController sozlesmesine baglar:
 * - mobil profil cekmecesi: modal (backdrop, inert arka plan, scroll-lock)
 * - dev console: modal olmayan yan panel (ESC + kapat butonu)
 * Tek ESC dinleyicisi ve odak yonetimi controller icindedir (bkz. js/ui/OverlayController.js).
 * @param {Object} elements
 * @returns {Object} - { profileDrawerCtrl, devConsoleCtrl }
 */
export function setupOverlays(elements) {
  const {
    drawerOverlay,
    devConsoleDrawer,
    devConsoleToggle,
    closeConsoleBtn,
    profileSidebar,
    profileMenuBtn,
    navItems = [],
    inertTargets = []
  } = elements;

  const profileDrawerCtrl = createOverlayController(profileSidebar, {
    modal: true,
    backdropEl: drawerOverlay,
    triggerEl: profileMenuBtn,
    closeEls: navItems,
    inertTargets: () => inertTargets,
    initialFocus: () => profileSidebar?.querySelector('.nav-item.active') || null
  });
  profileMenuBtn?.addEventListener('click', () => profileDrawerCtrl.toggle());

  // Masaustune genisleyince cekmece halini birak (inert/scroll-lock askida kalmasin)
  const mobileQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 767px)') : null;
  mobileQuery?.addEventListener?.('change', (event) => { if (!event.matches) profileDrawerCtrl.close('viewport'); });

  const devConsoleCtrl = createOverlayController(devConsoleDrawer, {
    modal: false,
    triggerEl: devConsoleToggle,
    closeEls: [closeConsoleBtn],
    initialFocus: () => closeConsoleBtn
  });
  devConsoleToggle?.addEventListener('click', () => devConsoleCtrl.toggle());

  return { profileDrawerCtrl, devConsoleCtrl };
}

/**
 * Test countdown + analysing progress bar event handler'larini kaydet
 * @param {HTMLElement} testCountdownEl - Countdown badge elementi (kayit fazi)
 * @param {HTMLElement} testProgressFillEl - Analysing progress fill elementi (analiz fazi)
 * @param {Object} eventBus - EventBus referansi
 * @returns {Function} - Cleanup fonksiyonu (unsubscribe icin)
 */
export function setupTestCountdownHandlers(testCountdownEl, testProgressFillEl, eventBus) {
  const unsubscribers = [];

  // Analysing progress bar (deep analiz ilerlemesini yansitir — 0..1)
  const setProgress = (ratio) => {
    if (!testProgressFillEl) return;
    const r = Math.min(1, Math.max(0, ratio || 0));
    testProgressFillEl.style.transform = `scaleX(${r})`;
  };

  // Test countdown (kayit fazi)
  const onCountdown = ({ remainingSec }) => {
    if (testCountdownEl) {
      testCountdownEl.textContent = remainingSec > 0 ? `${remainingSec}s` : '';
    }
  };
  unsubscribers.push(eventBus.on(EVENTS.TEST_COUNTDOWN, onCountdown));

  // Analiz fazi: gercek progress bar
  unsubscribers.push(eventBus.on(EVENTS.TEST_ANALYSING_STARTED, () => setProgress(0)));
  unsubscribers.push(eventBus.on(EVENTS.TEST_ANALYSING_PROGRESS, ({ ratio }) => setProgress(ratio)));

  // Test tamamlandiginda/iptal edildiginde countdown + progress temizle
  const clearTestUi = () => {
    if (testCountdownEl) testCountdownEl.textContent = '';
    setProgress(0);
  };
  [EVENTS.TEST_COMPLETED, EVENTS.TEST_CANCELLED, EVENTS.TEST_RECORDING_STOPPED]
    .forEach(event => unsubscribers.push(eventBus.on(event, clearTestUi)));

  // Cleanup fonksiyonu dondur
  return () => unsubscribers.forEach(unsub => typeof unsub === 'function' && unsub());
}
