/**
 * ProfileUIManager - Profil UI yonetimi
 * OCP: Profil secim, kart/nav guncelleme tek yerde
 * DIP: Bagimliliklar dependency injection ile alinir
 */
import eventBus from '../modules/EventBus.js';
import profileController from '../controllers/ProfileController.js';
import { PROFILES } from '../modules/Config.js';
import { log, setVisible } from '../modules/utils.js';
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
    this._renderScenarioChoices();
    this._bindEvents();
  }

  // The rail owns scenario names, grouping, icons and descriptions. The first-use
  // view renders that same catalogue, so the two entry points cannot drift.
  _renderScenarioChoices() {
    const { profileSidebar, scenarioChoices } = this.elements;
    if (!profileSidebar || !scenarioChoices) return;
    scenarioChoices.replaceChildren();
    profileSidebar.querySelectorAll('.nav-section').forEach(group => {
      const section = document.createElement('section');
      section.className = 'scenario-group';
      const heading = document.createElement('h2');
      heading.textContent = group.querySelector('.nav-section-title').textContent;
      section.append(heading);
      group.querySelectorAll('[data-profile]').forEach(item => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'scenario-choice';
        button.dataset.profile = item.dataset.profile;
        button.append(item.querySelector('.nav-icon').cloneNode(true));
        const copy = document.createElement('span');
        copy.className = 'scenario-choice-copy';
        const name = document.createElement('strong');
        name.textContent = item.textContent.trim();
        const description = document.createElement('span');
        description.textContent = item.dataset.description;
        copy.append(name, description);
        button.append(copy);
        section.append(button);
      });
      scenarioChoices.append(section);
    });
  }

  _isBusy() {
    return this.getState.currentMode() !== null || this.getState.isPreparing()
      || !!this.getState.isReportPending?.();
  }

  _showWorkspace(show, focus = false) {
    const { scenarioPicker, scenarioWorkspace, profileSidebar, profileMenuBtn, devConsoleToggle } = this.elements;
    setVisible(scenarioPicker, !show);
    [scenarioWorkspace, profileSidebar, profileMenuBtn, devConsoleToggle].forEach(el => setVisible(el, show));
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
    const { navItems, scenarioChoices, changeScenarioBtn } = this.elements;

    // Handler referanslarini sakla (cleanup icin)
    this._navHandlers = [];

    // Sidebar nav-item tiklama
    const choices = [...(scenarioChoices?.querySelectorAll('[data-profile]') || [])];
    this._choiceItems = choices;
    [...navItems, ...choices].forEach(item => {
      const handler = () => this.handleProfileSelect(item.dataset.profile, choices.includes(item));
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
      choices.forEach(item => { item.disabled = this._isBusy(); });
    };
    this._unsubscribers = [EVENTS.UI_STATE_CHANGED, EVENTS.DIAGNOSTIC_REPORT_READY]
      .map(event => eventBus.on(event, syncLocks));
  }

  /**
   * Cleanup - Event listener'larini kaldir (memory leak onleme)
   */
  destroy() {
    this._navHandlers?.forEach(({ el, handler }) => el.removeEventListener('click', handler));
    this._navHandlers = [];
    this._unsubscribers?.forEach(unsubscribe => unsubscribe());
  }

  /**
   * Profil secim handler (sidebar nav-item)
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
    element.textContent = profileController.getTechString(profileId);
    const tooltip = profileController.getDetectionTooltip(profileId);
    if (tooltip) {
      element.title = tooltip;
      element.style.cursor = 'help';
    }
  }

  /**
   * Sidebar nav item secimini guncelle
   */
  updateNavItemSelection(profileId) {
    const { navItems, pageTitle, pageTitleIcon } = this.elements;
    const activeItem = this._updateSelectionState(navItems, profileId, 'active');

    // Page header'i guncelle
    const profile = PROFILES[profileId];
    if (profile && pageTitle) {
      pageTitle.textContent = profile.label + ' Test';
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
    this._updateSelectionState(this._choiceItems || [], profileId, 'active');
    this._showWorkspace(Object.hasOwn(PROFILES, profileId), focus);
  }
}

// Singleton export
const profileUIManager = new ProfileUIManager();
export default profileUIManager;
