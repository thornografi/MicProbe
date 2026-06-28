/**
 * ProfileUIManager - Profil UI yonetimi
 * OCP: Profil secim, kart/nav guncelleme tek yerde
 * DIP: Bagimliliklar dependency injection ile alinir
 */
import eventBus from '../modules/EventBus.js';
import profileController from '../controllers/ProfileController.js';
import { PROFILES } from '../modules/Config.js';
import { log } from '../modules/utils.js';

class ProfileUIManager {
  constructor() {
    // UI element referanslari
    this.elements = {
      scenarioCards: [],
      navItems: [],
      pageTitle: null,
      pageTitleIcon: null,
      pageSubtitle: null,
      scenarioBadge: null,
      scenarioTech: null,
      profileSelector: null,
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
    this._bindEvents();
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
    const { scenarioCards, navItems } = this.elements;

    // Handler referanslarini sakla (cleanup icin)
    this._cardHandlers = [];
    this._navHandlers = [];

    // Senaryo kartlarina tiklama
    scenarioCards.forEach(card => {
      const handler = () => this.handleProfileSelect(card.dataset.profile);
      card.addEventListener('click', handler);
      this._cardHandlers.push({ el: card, handler });
    });

    // Sidebar nav-item tiklama
    navItems.forEach(item => {
      const handler = () => this.handleProfileSelect(item.dataset.profile);
      item.addEventListener('click', handler);
      this._navHandlers.push({ el: item, handler });
    });
  }

  /**
   * Cleanup - Event listener'larini kaldir (memory leak onleme)
   */
  destroy() {
    this._cardHandlers?.forEach(({ el, handler }) => el.removeEventListener('click', handler));
    this._navHandlers?.forEach(({ el, handler }) => el.removeEventListener('click', handler));
    this._cardHandlers = [];
    this._navHandlers = [];
  }

  /**
   * Profil secim handler - DRY: scenarioCards ve navItems icin ortak
   * @param {string} profileId - Secilen profil ID'si
   */
  async handleProfileSelect(profileId) {
    const currentMode = this.getState.currentMode();
    const isPreparing = this.getState.isPreparing();

    // Aktif islem VEYA preparing varken profil degisikligine izin verme
    if (currentMode !== null || isPreparing) {
      log.ui('Stop current operation before changing profile', {});
      return;
    }

    try {
      const { profileSelector } = this.elements;
      if (profileSelector) {
        profileSelector.value = profileId;
      }

      await profileController.applyProfile(profileId);
      this.updateScenarioCardSelection(profileId);
      this.updateNavItemSelection(profileId);
      this.callbacks.updateCustomSettingsPanel(profileId);

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
   * Senaryo kart secimini guncelle
   */
  updateScenarioCardSelection(profileId) {
    this._updateSelectionState(this.elements.scenarioCards, profileId, 'selected');
    this.updateScenarioTechInfo(profileId);
  }

  /**
   * Senaryo teknik bilgisini guncelle (badge ve tech text)
   */
  updateScenarioTechInfo(profileId) {
    const { scenarioTech, scenarioBadge } = this.elements;
    if (!scenarioTech || !scenarioBadge) return;

    const profile = PROFILES[profileId];
    if (!profile) return;

    scenarioBadge.textContent = profile.label;
    this._applyTechTooltip(scenarioTech, profileId);
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
        pageTitleIcon.classList.remove('hidden');
      } else {
        pageTitleIcon.classList.add('hidden');
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
  updateAll(profileId) {
    this.updateScenarioCardSelection(profileId);
    this.updateNavItemSelection(profileId);
  }
}

// Singleton export
const profileUIManager = new ProfileUIManager();
export default profileUIManager;
