/**
 * CustomSettingsPanelHandler - Ozel Ayarlar paneli yonetimi
 * OCP: Panel rendering ve event handling tek yerde
 * DRY: updateCustomSettingsPanel mantigi merkezi
 */

import { PROFILES, SETTINGS } from '../modules/Config.js';
import { SettingTypeHandlers, log } from '../modules/utils.js';
import eventBus from '../modules/EventBus.js';
import { EVENTS, MARKUP_CLASSES } from '../modules/constants.js';

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
    this._onSettingsChanged = () => this.syncModifiedState();
    document.addEventListener('change', this._onSettingsChanged);
    this._unsubscribeState = eventBus.on(EVENTS.UI_STATE_CHANGED, this._onSettingsChanged);
    this._unsubscribeReport = eventBus.on(EVENTS.DIAGNOSTIC_REPORT_READY, this._onSettingsChanged);
    this.resetButton = document.getElementById('resetSettingsBtn');
    this.modifiedIndicator = document.getElementById('settingsModified');
    this._onReset = () => this.restoreDefaults();
    this.resetButton?.addEventListener('click', this._onReset);
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
      customSettingsToggle.setAttribute('aria-expanded', String(isCollapsed));
      customSettingsContent.inert = !isCollapsed;

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
      if (!key || target.disabled || this.callbacks.getIsBusy?.()) return;

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
      if (!this._applyValue(key, value)) {
        target.value = this._readValue(key) ?? '';
        return;
      }

      // Drawer ve panelde ayar bagimliliklarini profil kilitlerini koruyarak guncelle.
      this.dependencies.profileController?.updateDynamicLocks();
      this.dependencies.profileController?.updateCustomSettingsPanelDynamicState();
      this.syncModifiedState();

      log.ui(`Ayar degistirildi: ${key} = ${value}`, {});
    });
  }

  _readValue(key) {
    const elements = this.callbacks.getSettingElements(key);
    return SETTINGS[key]?.type === 'boolean' ? elements[0]?.checked : elements.find(el => el.checked)?.value;
  }

  _applyValue(key, value) {
    const elements = this.callbacks.getSettingElements(key);
    const input = SETTINGS[key]?.type === 'boolean' ? elements[0] : elements.find(el => String(el.value) === String(value));
    if (!input) return false;
    input.checked = SETTINGS[key].type === 'boolean' ? value : true;
    // Reset and manual edits both use the existing capture/settings event path.
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  syncModifiedState() {
    const profile = this.dependencies.profileController?.getCurrentProfile();
    if (!profile) return;
    const busy = !!this.callbacks.getIsBusy?.();
    const keys = this._editableKeys(profile);
    const changed = keys.filter(key => String(this._readValue(key)) !== String(profile.values?.[key] ?? SETTINGS[key].default));
    if (this.modifiedIndicator) this.modifiedIndicator.hidden = changed.length === 0;
    if (this.resetButton) this.resetButton.disabled = busy || changed.length === 0;
    for (const control of this.elements.customSettingsGrid?.querySelectorAll('[data-setting]') || []) {
      const key = control.dataset.setting;
      const backing = this.callbacks.getSettingElements(key);
      control.disabled = busy || backing.length === 0 || backing.every(input => input.disabled);
      control.closest('.custom-setting-item')?.classList.toggle('setting-modified', changed.includes(key));
    }
  }

  _editableKeys(profile) {
    return Object.keys(SETTINGS).filter(key => !profile.lockedSettings?.includes(key)
      && (profile.allowedSettings === 'all' || profile.editableSettings?.includes(key)));
  }

  restoreDefaults() {
    if (this.callbacks.getIsBusy?.()) return;
    const profile = this.dependencies.profileController?.getCurrentProfile();
    if (!profile) return;
    this._editableKeys(profile).forEach(key => this._applyValue(key, profile.values?.[key] ?? SETTINGS[key].default));
    this.updatePanel(this.dependencies.profileController.getCurrentProfileId());
  }

  destroy() {
    document.removeEventListener('change', this._onSettingsChanged);
    this._unsubscribeState?.();
    this._unsubscribeReport?.();
    this.resetButton?.removeEventListener('click', this._onReset);
  }

  /**
   * Deger formatlama - bitrate icin "64k" gibi, pipeline/encoder icin labels
   */
  _formatEnumValue(val, key) {
    if (key === 'bitrate' || key === 'mediaBitrate') {
      return val === 0 ? 'Auto' : (val / 1000) + 'k';
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
    if (setting?.unit) return `${val} ${setting.unit}`;
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
    const specifications = [];

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

      if (isLocked) {
        const value = profile.values?.[key] ?? setting.default;
        specifications.push(`<div><dt>${setting.label || key}</dt><dd>${setting.type === 'boolean'
          ? (value ? 'On' : 'Off') : this._formatEnumValue(value, key)}</dd></div>`);
        return;
      }

      const settingData = {
        key,
        setting,
        isLocked,
        currentValue: this._readValue(key) ?? profile.values?.[key] ?? setting.default
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

      html += `<div class="${MARKUP_CLASSES.CUSTOM_SECTION}">`;
      html += `<div class="${MARKUP_CLASSES.CUSTOM_SECTION_LABEL}">${this._formatCategoryLabel(category)}</div>`;
      html += `<div class="${MARKUP_CLASSES.CUSTOM_SECTION_BODY}">`;

      // OCP: Registry-based rendering - her tip kendi render metodunu kullanir
      SettingTypeHandlers.getTypes().forEach(type => {
        const handler = SettingTypeHandlers.get(type);
        if (!handler?.group || !group[handler.group]?.length) return;

        // Boolean tipi icin ozel wrapper (checkbox-row)
        if (type === 'boolean') {
          html += `<div class="${MARKUP_CLASSES.CUSTOM_CHECKBOX_ROW}">`;
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

    if (specifications.length) html += `<details class="profile-specifications"><summary>Fixed scenario settings</summary><p>These values define this scenario and stay the same between tests.</p><dl>${specifications.join('')}</dl></details>`;
    if (html === '') {
      html = `<p class="${MARKUP_CLASSES.CUSTOM_HINT}">No custom settings available for this profile.</p>`;
    }

    customSettingsGrid.innerHTML = html;
    // Dinamik kilitleri uygula (mode -> buffer, loopback -> timeslice vb.)
    this.dependencies.profileController?.updateCustomSettingsPanelDynamicState();
    this.syncModifiedState();
  }
}

// Singleton export
const customSettingsPanelHandler = new CustomSettingsPanelHandler();
export default customSettingsPanelHandler;
