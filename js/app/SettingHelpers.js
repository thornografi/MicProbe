/**
 * SettingHelpers - Ayar yonetimi helper fonksiyonlari
 */
import { SETTINGS } from '../modules/Config.js';

/**
 * Ayar key'ine gore UI elementlerini dondur (checkbox, radio grubu, toggle)
 */
export function getSettingElements(settingKey) {
  const setting = SETTINGS[settingKey];
  if (!setting?.ui) return [];

  const { type, id, name } = setting.ui;

  if (type === 'checkbox' || type === 'toggle') {
    const el = document.getElementById(id);
    return el ? [el] : [];
  }

  if (type === 'radio') {
    return [...document.querySelectorAll(`input[name="${name}"]`)];
  }

  return [];
}

/**
 * Ayar elementlerini enable/disable et
 */
export function setSettingDisabled(settingKey, disabled) {
  getSettingElements(settingKey).forEach(el => {
    el.disabled = disabled;
    el.closest('label')?.classList.toggle('setting-locked', disabled);
  });
}

/**
 * Radio value getter - radio butonlarindan deger al
 */
export function getRadioValue(name, defaultValue, parseAsInt = false) {
  const selected = document.querySelector(`input[name="${name}"]:checked`);
  if (!selected) return defaultValue;
  return parseAsInt ? parseInt(selected.value, 10) : selected.value;
}

/**
 * Drawer radio -> Custom Panel combo senkronizasyonu
 */
export function syncToCustomPanel(settingKey, value) {
  const select = document.querySelector(`#customSettingsGrid [data-setting="${settingKey}"]`);
  if (select && select.tagName === 'SELECT') {
    select.value = value;
  }
}
