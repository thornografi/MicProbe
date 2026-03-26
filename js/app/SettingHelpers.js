/**
 * SettingHelpers - Ayar yonetimi helper fonksiyonlari
 */
import { SETTINGS } from '../modules/Config.js';
import { AUDIO, BUFFER, SETTING_NAMES } from '../modules/constants.js';
import { calculateLatencyMs } from '../modules/utils.js';

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

/** DRY: Ortak disabled + label class toggle */
function _toggleDisabledWithLabel(el, disabled, className) {
  el.disabled = disabled;
  el.closest('label')?.classList.toggle(className, disabled);
}

/**
 * Ayar elementlerini enable/disable et
 */
export function setSettingDisabled(settingKey, disabled) {
  getSettingElements(settingKey).forEach(el => _toggleDisabledWithLabel(el, disabled, 'setting-locked'));
}

/**
 * Belirli bir secenek (radio/option) enable/disable et
 */
export function setOptionDisabled(settingKey, optionValue, disabled) {
  const targetEl = getSettingElements(settingKey).find(el => el.value === optionValue);
  if (targetEl) _toggleDisabledWithLabel(targetEl, disabled, 'option-disabled');
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

/**
 * Buffer info metnini guncelle
 */
export function updateBufferInfo(value, bufferInfoText) {
  if (!bufferInfoText) return;

  const latencyMs = calculateLatencyMs(value).toFixed(1);
  bufferInfoText.textContent = `${value} samples @ ${AUDIO.DEFAULT_SAMPLE_RATE / 1000}kHz = ~${latencyMs}ms latency`;

  bufferInfoText.classList.remove('warning', 'danger');
  if (value <= BUFFER.WARNING_THRESHOLD) {
    bufferInfoText.classList.add('warning');
  }
}

/**
 * Timeslice info metnini guncelle
 */
export function updateTimesliceInfo(value, timesliceInfoEl) {
  if (!timesliceInfoEl) return;

  const infoText = timesliceInfoEl.querySelector('.info-text');
  if (!infoText) return;

  infoText.classList.remove('warning', 'danger');

  if (value === 0) {
    infoText.textContent = 'OFF: Single chunk - no timeslice';
  } else {
    const chunksPerSec = 1000 / value;
    infoText.textContent = `${value}ms: ~${chunksPerSec.toFixed(1)} chunks/sec - Listen for glitch frequency!`;

    if (value <= 100) {
      infoText.classList.add('danger');
    } else if (value <= 250) {
      infoText.classList.add('warning');
    }
  }
}
