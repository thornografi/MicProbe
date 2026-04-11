/**
 * CustomSettingsPanelHandler - Ozel Ayarlar paneli yonetimi
 * OCP: Panel rendering ve event handling tek yerde
 * DRY: updateCustomSettingsPanel mantigi merkezi
 */

import eventBus from '../modules/EventBus.js';
import { PROFILES, SETTINGS } from '../modules/Config.js';
import { SettingTypeHandlers, log } from '../modules/utils.js';

/**
 * CustomSettingsPanelHandler class
 */
class CustomSettingsPanelHandler {
  constructor() {
    // UI element referanslari
    this.elements = {
      customSettingsToggle: null,
      customSettingsContent: null,
      customSettingsGrid: null
    };

    // Callbacks - app.js'den enjekte edilir
    this.callbacks = {
      getSettingElements: () => [],
      setSettingDisabled: () => {}
    };

    // Dependencies
    this.dependencies = {
      profileController: null
    };
  }

  /**
   * Initialize with UI elements
   */
  init(elements) {
    Object.assign(this.elements, elements);
    this._bindToggleEvent();
    this._bindChangeEvent();
  }

  /**
   * Set callbacks
   */
  setCallbacks(callbacks) {
    Object.assign(this.callbacks, callbacks);
  }

  /**
   * Set dependencies
   */
  setDependencies(deps) {
    Object.assign(this.dependencies, deps);
  }

  /**
   * Toggle butonu event'i
   */
  _bindToggleEvent() {
    const { customSettingsToggle, customSettingsContent } = this.elements;
    if (!customSettingsToggle || !customSettingsContent) return;

    customSettingsToggle.addEventListener('click', () => {
      const isCollapsed = customSettingsContent.classList.contains('collapsed');

      customSettingsContent.classList.toggle('collapsed');
      customSettingsToggle.classList.toggle('expanded');

      log.ui(isCollapsed ? 'Custom settings opened' : 'Custom settings closed', {});
    });
  }

  /**
   * Panel ici change event'i - event delegation
   */
  _bindChangeEvent() {
    const { customSettingsGrid } = this.elements;
    if (!customSettingsGrid) return;

    customSettingsGrid.addEventListener('change', (e) => {
      const target = e.target;
      const key = target.dataset.setting;
      if (!key) return;

      let value;
      if (target.type === 'checkbox') {
        value = target.checked;
      } else if (target.tagName === 'SELECT') {
        // Enum degerler - sayi ise number'a cevir
        value = isNaN(target.value) ? target.value : Number(target.value);
      } else {
        return;
      }

      // OCP: Drawer'daki ilgili kontrolu dinamik olarak guncelle
      const setting = SETTINGS[key];
      if (setting?.ui) {
        const elements = this.callbacks.getSettingElements(key);
        if (setting.type === 'boolean') {
          // Checkbox veya Toggle
          elements.forEach(el => el.checked = value);
        } else if (setting.type === 'enum') {
          // Radio grubu - degere gore sec
          const radio = elements.find(el => el.value == value);
          if (radio) radio.checked = true;
        }
      }

      // Dinamik bagimliliklari guncelle (mode -> buffer, loopback -> timeslice vb.)
      // updateDynamicLocks: Radio button'lari gunceller (encoder otomatik degisimi dahil)
      // updateCustomSettingsPanelDynamicState: Custom panel combo'larini gunceller
      this.dependencies.profileController?.updateDynamicLocks();
      this.dependencies.profileController?.updateCustomSettingsPanelDynamicState();

      log.ui(`Ayar degistirildi: ${key} = ${value}`, {});
    });
  }

  /**
   * Deger formatlama - bitrate icin "64k" gibi, pipeline/encoder icin labels
   */
  _formatEnumValue(val, key) {
    if (key === 'bitrate' || key === 'mediaBitrate') {
      return val === 0 ? 'Off' : (val / 1000) + 'k';
    }
    if (key === 'buffer') {
      return val.toString();
    }
    if (key === 'timeslice') {
      return val === 0 ? 'Single chunk' : val + 'ms';
    }
    // Config'deki labels objesini kullan (pipeline, encoder icin)
    const setting = SETTINGS[key];
    if (setting?.labels?.[val]) {
      return setting.labels[val];
    }
    return val;
  }

  /**
   * Kategori label formatlama
   */
  _formatCategoryLabel(category) {
    const categoryLabels = {
      constraints: 'Audio Processing',
      loopback: 'WebRTC Loopback',
      pipeline: 'Audio Pipeline',
      recording: 'Recording',
      other: 'Other'
    };

    if (categoryLabels[category]) return categoryLabels[category];
    return category
      .replace(/[_-]+/g, ' ')
      .replace(/\b[a-z]/g, (char) => char.toUpperCase());
  }

  /**
   * Panel icerigini guncelle
   * @param {string} profileId - Profil ID
   */
  updatePanel(profileId) {
    const { customSettingsGrid } = this.elements;
    if (!customSettingsGrid) return;

    const profile = PROFILES[profileId];
    if (!profile) return;

    const lockedSettings = profile.lockedSettings || [];
    const editableSettings = profile.editableSettings || [];
    const isCustomProfile = profileId === 'custom' || profile.allowedSettings === 'all';

    let html = '';

    const categoryOrder = ['constraints', 'loopback', 'pipeline', 'recording'];
    const groupedSettings = {};

    // OCP: Dinamik grup yapisi - registry'deki tum tipler icin grup olustur
    const ensureGroup = (category) => {
      if (!groupedSettings[category]) {
        groupedSettings[category] = {};
        // Registry'deki her tip icin bos array olustur
        SettingTypeHandlers.getTypes().forEach(type => {
          const handler = SettingTypeHandlers.get(type);
          if (handler?.group) {
            groupedSettings[category][handler.group] = [];
          }
        });
        if (!categoryOrder.includes(category)) {
          categoryOrder.push(category);
        }
      }
    };

    Object.keys(SETTINGS).forEach(key => {
      const setting = SETTINGS[key];
      if (!setting) return;

      const isLocked = lockedSettings.includes(key);
      const isEditable = isCustomProfile || editableSettings.includes(key);

      // Sadece locked veya editable olanlari goster
      if (!isLocked && !isEditable) return;

      const settingData = {
        key,
        setting,
        isLocked,
        currentValue: profile.values?.[key] ?? setting.default
      };

      const category = setting.category || 'other';
      ensureGroup(category);

      // OCP: Registry-based type handling - yeni tip eklemek icin sadece register() cagir
      const handler = SettingTypeHandlers.get(setting.type);
      if (handler?.group && groupedSettings[category][handler.group]) {
        groupedSettings[category][handler.group].push(settingData);
      }
    });

    categoryOrder.forEach(category => {
      const group = groupedSettings[category];
      if (!group) return;

      // OCP: Grup bos mu kontrol et - tum handler gruplari icin
      const hasContent = SettingTypeHandlers.getTypes().some(type => {
        const handler = SettingTypeHandlers.get(type);
        return handler?.group && group[handler.group]?.length > 0;
      });
      if (!hasContent) return;

      html += '<div class="custom-settings-section">';
      html += `<div class="custom-settings-section-label">${this._formatCategoryLabel(category)}</div>`;
      html += '<div class="custom-settings-section-body">';

      // OCP: Registry-based rendering - her tip kendi render metodunu kullanir
      SettingTypeHandlers.getTypes().forEach(type => {
        const handler = SettingTypeHandlers.get(type);
        if (!handler?.group || !group[handler.group]?.length) return;

        // Boolean tipi icin ozel wrapper (checkbox-row)
        if (type === 'boolean') {
          html += '<div class="custom-settings-checkbox-row">';
        }

        group[handler.group].forEach(settingData => {
          html += handler.render({
            ...settingData,
            allowedValues: profile.allowedValues?.[settingData.key],
            formatValue: (val, key) => this._formatEnumValue(val, key)
          });
        });

        if (type === 'boolean') {
          html += '</div>';
        }
      });

      html += '</div>';
      html += '</div>';
    });

    if (html === '') {
      html = '<p class="custom-settings-hint">No custom settings available for this profile.</p>';
    }

    customSettingsGrid.innerHTML = html;

    // Dinamik kilitleri uygula (mode -> buffer, loopback -> timeslice vb.)
    this.dependencies.profileController?.updateCustomSettingsPanelDynamicState();
  }
}

// Singleton export
const customSettingsPanelHandler = new CustomSettingsPanelHandler();
export default customSettingsPanelHandler;
