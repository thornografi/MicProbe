/**
 * ProfileUIManager - Profil UI yonetimi
 * OCP: Profil secim, kart/nav guncelleme tek yerde
 * DIP: Bagimliliklar dependency injection ile alinir
 */
import eventBus from '../modules/EventBus.js';
import profileController from '../modules/ProfileController.js';
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
   */
  _bindEvents() {
    const { scenarioCards, navItems } = this.elements;

    // Senaryo kartlarina tiklama
    scenarioCards.forEach(card => {
      card.addEventListener('click', () => this.handleProfileSelect(card.dataset.profile));
    });

    // Sidebar nav-item tiklama
    navItems.forEach(item => {
      item.addEventListener('click', () => this.handleProfileSelect(item.dataset.profile));
    });
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

      log.ui(`Senaryo degistirildi: ${PROFILES[profileId]?.label || profileId}`, {});
    } catch (err) {
      log.error('Profil secimi hatasi', { profileId, error: err.message });
    }
  }

  /**
   * Senaryo kart secimini guncelle
   * @param {string} profileId - Aktif profil ID'si
   */
  updateScenarioCardSelection(profileId) {
    const { scenarioCards } = this.elements;

    scenarioCards.forEach(card => {
      const cardProfile = card.dataset.profile;
      card.classList.toggle('selected', cardProfile === profileId);
    });

    this.updateScenarioTechInfo(profileId);
  }

  /**
   * Senaryo teknik bilgisini guncelle (badge ve tech text)
   * @param {string} profileId - Profil ID'si
   */
  updateScenarioTechInfo(profileId) {
    const { scenarioTech, scenarioBadge } = this.elements;
    if (!scenarioTech || !scenarioBadge) return;

    const profile = PROFILES[profileId];
    if (!profile) return;

    scenarioBadge.textContent = profile.label;

    // DRY: ProfileController'daki buildTechParts kullan
    scenarioTech.textContent = profileController.getTechString(profileId);

    // Detection tooltip ekle
    const detectionTooltip = profileController.getDetectionTooltip(profileId);
    if (detectionTooltip) {
      scenarioTech.title = detectionTooltip;
      scenarioTech.style.cursor = 'help';
    }
  }

  /**
   * Sidebar nav item secimini guncelle
   * @param {string} profileId - Aktif profil ID'si
   */
  updateNavItemSelection(profileId) {
    const { navItems, pageTitle, pageTitleIcon } = this.elements;
    let activeItem = null;

    navItems.forEach(item => {
      const itemProfile = item.dataset.profile;
      const isActive = itemProfile === profileId;
      item.classList.toggle('active', isActive);
      if (isActive) {
        activeItem = item;
      }
    });

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
        targetUse.setAttribute('xlink:href', iconHref);
        pageTitleIcon.classList.remove('hidden');
      } else {
        pageTitleIcon.classList.add('hidden');
      }
    }

    // Tech info'yu subtitle olarak goster
    this.updatePageSubtitle(profileId);
  }

  /**
   * Page subtitle guncelle - DRY: ProfileController.getTechString() kullanir
   * Detection bilgisi tooltip olarak eklenir
   * @param {string} profileId - Profil ID'si
   */
  updatePageSubtitle(profileId) {
    const { pageSubtitle } = this.elements;
    if (!pageSubtitle) return;

    pageSubtitle.textContent = profileController.getTechString(profileId);

    // Detection tooltip ekle
    const detectionTooltip = profileController.getDetectionTooltip(profileId);
    if (detectionTooltip) {
      pageSubtitle.title = detectionTooltip;
      pageSubtitle.style.cursor = 'help';
    }
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
