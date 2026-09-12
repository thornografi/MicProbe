/**
 * ProfileUIManager - Profil UI yonetimi
 * OCP: Profil secim, kart/nav guncelleme tek yerde
 * DIP: Bagimliliklar dependency injection ile alinir
 */
import eventBus from '../modules/EventBus.js';
import profileController from '../controllers/ProfileController.js';
import { PROFILES } from '../modules/Config.js';
import { log, setVisible, appPageTitle } from '../modules/utils.js';
import { EVENTS } from '../modules/constants.js';
import { rememberScenario } from '../modules/ScenarioPreference.js';

class ProfileUIManager {
  constructor() {
    // UI element referanslari
    this.elements = {
      navItems: [],
      pageTitle: null,
      pageTitleIcon: null,
      pageSubtitle: null,
      customSettingsPanel: null
    };

    // State getters (disaridan set edilir)
    this.getState = {
      currentMode: () => null,
      isPreparing: () => false
    };

    // Callbacks
    this.callbacks = {
      updateCustomSettingsPanel: () => {}
    };
  }

  /**
   * UI elemanlarini initialize et
   * @param {Object} elements - UI element referanslari
   */
  init(elements) {
    Object.assign(this.elements, elements);
    this._scenarioGroups = Array.from(this.elements.scenarioPicker?.querySelectorAll('.scenario-group-toggle') || [])
      .map(toggle => ({ toggle, panel: document.getElementById(toggle.getAttribute('aria-controls')) }));
    this._sidebarMedia = globalThis.matchMedia?.('(min-width: 1024px)');
    this._renderScenarioChoices();
    this._bindEvents();
  }

  // One catalogue serves first use and later scenario changes at every width.
  _renderScenarioChoices() {
    this.elements.navItems.forEach(item => {
      const icon = item.querySelector('.nav-icon');
      const copy = document.createElement('span');
      copy.className = 'scenario-choice-copy';
      const name = document.createElement('strong');
      name.textContent = item.dataset.navLabel || PROFILES[item.dataset.profile].label;
      const description = document.createElement('span');
      description.textContent = item.dataset.description;
      copy.append(name, description);
      item.replaceChildren(icon, copy);
    });
  }

  _isBusy() {
    return this.getState.currentMode() !== null || this.getState.isPreparing()
      || !!this.getState.isReportPending?.();
  }

  _expandScenarioGroup(toggle) {
    this._scenarioGroups.forEach(group => group.toggle.setAttribute('aria-expanded', String(group.toggle === toggle)));
    this._syncScenarioGroups();
  }

  // Disclosure is desktop navigation only. The same controls stay visible in
  // the full chooser, including after a viewport change, without duplicating it.
  _syncScenarioGroups() {
    const sidebar = this._sidebarMedia?.matches
      && this.elements.scenarioPicker?.classList.contains('scenario-picker--collapsed');
    this._scenarioGroups.forEach(({ toggle, panel }) => {
      setVisible(panel, !sidebar || toggle.getAttribute('aria-expanded') === 'true');
    });
  }

  _showWorkspace(show, focus = false) {
    const { scenarioPicker, scenarioWorkspace } = this.elements;
    // Keep one catalogue: a persistent desktop sidebar, or a mobile chooser.
    scenarioPicker?.classList.toggle('scenario-picker--collapsed', show);
    scenarioPicker?.setAttribute('aria-labelledby', show ? 'scenarioSidebarTitle' : 'scenarioPickerTitle');
    setVisible(scenarioWorkspace, show);
    this._syncScenarioGroups();
    if (document.body.classList.contains('app-mode')) {
      const title = show ? this.elements.pageTitle : scenarioPicker?.querySelector('h1');
      document.title = appPageTitle(title);
    }
    if (focus) {
      const heading = show ? this.elements.pageTitle : scenarioPicker?.querySelector('h1');
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * State getter'lari set et
   */
  setStateGetters(getters) {
    Object.assign(this.getState, getters);
  }

  /**
   * Callback'leri set et
   */
  setCallbacks(callbacks) {
    Object.assign(this.callbacks, callbacks);
  }

  /**
   * Event listener'lari bagla
   * Memory leak fix: Handler referanslari saklanir, destroy()'da kaldirilir
   */
  _bindEvents() {
    const { navItems, changeScenarioBtn } = this.elements;

    // Handler referanslarini sakla (cleanup icin)
    this._navHandlers = [];

    this._scenarioGroups.forEach(({ toggle }) => {
      const handler = () => {
        if (this._isBusy()) return;
        this._expandScenarioGroup(toggle.getAttribute('aria-expanded') === 'true' ? null : toggle);
      };
      toggle.addEventListener('click', handler);
      this._navHandlers.push({ el: toggle, handler });
    });
    if (this._sidebarMedia) {
      const handler = () => this._syncScenarioGroups();
      this._sidebarMedia.addEventListener('change', handler);
      this._navHandlers.push({ el: this._sidebarMedia, handler, type: 'change' });
    }

    navItems.forEach(item => {
      const handler = () => this.handleProfileSelect(item.dataset.profile, true);
      item.addEventListener('click', handler);
      this._navHandlers.push({ el: item, handler });
    });
    if (changeScenarioBtn) {
      const handler = () => {
        if (this._isBusy()) return;
        this.callbacks.pausePlayback?.();
        this._showWorkspace(false, true);
      };
      changeScenarioBtn.addEventListener('click', handler);
      this._navHandlers.push({ el: changeScenarioBtn, handler });
    }
    const syncLocks = () => {
      if (changeScenarioBtn) changeScenarioBtn.disabled = this._isBusy();
      navItems.forEach(item => { item.disabled = this._isBusy(); });
      this._scenarioGroups.forEach(({ toggle }) => { toggle.disabled = this._isBusy(); });
    };
    this._unsubscribers = [EVENTS.UI_STATE_CHANGED, EVENTS.DIAGNOSTIC_REPORT_READY]
      .map(event => eventBus.on(event, syncLocks));
  }

  /**
   * Cleanup - Event listener'larini kaldir (memory leak onleme)
   */
  destroy() {
    this._navHandlers?.forEach(({ el, handler, type = 'click' }) => el.removeEventListener(type, handler));
    this._navHandlers = [];
    this._unsubscribers?.forEach(unsubscribe => unsubscribe());
  }

  /**
   * Profil secim handler
   * @param {string} profileId - Secilen profil ID'si
   */
  async handleProfileSelect(profileId, focus = false) {
    if (!Object.hasOwn(PROFILES, profileId)) return;
    if (this._isBusy()) {
      log.ui('Stop current operation before changing profile', {});
      return;
    }

    try {
      // Returning from the chooser to the same scenario preserves its sample,
      // report and edited settings. Only a different scenario resets the capture.
      if (profileController.getCurrentProfileId() !== profileId) {
        await profileController.applyProfile(profileId);
        this.callbacks.updateCustomSettingsPanel(profileId);
      }
      this.updateAll(profileId, focus);
      rememberScenario(profileId);

      log.ui(`Scenario changed: ${PROFILES[profileId]?.label || profileId}`, {});
    } catch (err) {
      log.error('Profile selection error', { profileId, error: err.message });
    }
  }

  /** DRY: Element listesinde dataset.profile ile secim toggle */
  _updateSelectionState(elements, profileId, className) {
    let activeElement = null;
    elements.forEach(el => {
      const isActive = el.dataset.profile === profileId;
      el.classList.toggle(className, isActive);
      if (isActive) el.setAttribute('aria-current', 'true');
      else el.removeAttribute('aria-current');
      if (isActive) activeElement = el;
    });
    return activeElement;
  }

  /** DRY: Tech string + detection tooltip uygula */
  _applyTechTooltip(element, profileId) {
    element.textContent = `Preset defaults: ${profileController.getTechString(profileId)}`;
    const tooltip = profileController.getDetectionTooltip(profileId);
    if (tooltip) {
      element.title = tooltip;
      element.style.cursor = 'help';
    }
  }

  /**
   * Senaryo secimini ve basligini guncelle
   */
  updateNavItemSelection(profileId) {
    const { navItems, pageTitle, pageTitleIcon } = this.elements;
    const activeItem = this._updateSelectionState(navItems, profileId, 'active');
    this._expandScenarioGroup(activeItem?.closest?.('.scenario-group')?.querySelector('.scenario-group-toggle'));

    // Page header'i guncelle
    const profile = PROFILES[profileId];
    if (profile && pageTitle) {
      pageTitle.textContent = profile.label;
    }
    if (pageTitleIcon) {
      const useEl = activeItem?.querySelector('use');
      const iconHref = useEl?.getAttribute('href') || useEl?.getAttribute('xlink:href');
      const targetUse = pageTitleIcon.querySelector('use');

      if (iconHref && targetUse) {
        targetUse.setAttribute('href', iconHref);
        setVisible(pageTitleIcon, true);
      } else {
        setVisible(pageTitleIcon, false);
      }
    }

    this.updatePageSubtitle(profileId);
  }

  /**
   * Page subtitle guncelle
   */
  updatePageSubtitle(profileId) {
    const { pageSubtitle } = this.elements;
    if (!pageSubtitle) return;
    this._applyTechTooltip(pageSubtitle, profileId);
  }

  /**
   * Tum profil UI'ini guncelle (tek cagri ile)
   * @param {string} profileId - Profil ID'si
   */
  updateAll(profileId, focus = false) {
    this.updateNavItemSelection(profileId);
    const evidence = PROFILES[profileId]?.evidence;
    const basis = document.getElementById('scenarioBasis');
    if (basis) {
      basis.textContent = evidence?.basis === 'observed-web'
        ? 'Web test informed · local approximation' : 'Estimated local preset';
      setVisible(basis, !!evidence);
    }
    const detail = document.getElementById('scenarioEvidence');
    if (detail) detail.textContent = evidence?.summary || PROFILES[profileId]?.desc || '';
    this._showWorkspace(Object.hasOwn(PROFILES, profileId), focus);
  }
}

// Singleton export
const profileUIManager = new ProfileUIManager();
export default profileUIManager;
