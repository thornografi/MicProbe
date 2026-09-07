/**
 * Setting lock policy and setting type rendering.
 */
import { needsBufferSetting, shouldDisableTimeslice } from './pipeline.js';
import { MARKUP_CLASSES } from '../constants.js';

/** Profile locks remain effective even when a pipeline makes a setting relevant. */
export function getSettingLockPolicy(profile, { pipeline, loopback, encoder }) {
  const locks = {
    buffer: !needsBufferSetting(pipeline),
    mediaBitrate: !!loopback,
    bitrate: !loopback,
    timeslice: shouldDisableTimeslice(loopback, encoder)
  };
  for (const key of profile?.lockedSettings || []) locks[key] = true;
  return locks;
}

export const SettingTypeHandlers = {
  _handlers: {},

  /**
   * Yeni tip handler kaydet
   * @param {string} type - Setting tipi (boolean, enum, range, vb.)
   * @param {Object} handler - { group, render } metodlari
   */
  register(type, handler) {
    this._handlers[type] = handler;
  },

  /**
   * Tip icin handler dondur
   * @param {string} type
   * @returns {Object|null}
   */
  get(type) {
    return this._handlers[type] || null;
  },

  /**
   * Tum kayitli tipleri dondur
   * @returns {string[]}
   */
  getTypes() {
    return Object.keys(this._handlers);
  }
};

// Boolean handler - checkbox olarak render edilir
SettingTypeHandlers.register('boolean', {
  group: 'booleans',
  render({ key, setting, isLocked, currentValue }) {
    const statusClass = isLocked ? 'locked' : 'editable';
    return `<div class="${MARKUP_CLASSES.CUSTOM_ITEM} ${statusClass}">
      <input id="custom-setting-${key}" type="checkbox" ${currentValue ? 'checked' : ''} ${isLocked ? 'disabled' : ''} data-setting="${key}">
      <label for="custom-setting-${key}" class="${MARKUP_CLASSES.SETTING_NAME}">${setting.label || key}</label>
    </div>`;
  }
});

// Enum handler - select olarak render edilir
SettingTypeHandlers.register('enum', {
  group: 'enums',
  render({ key, setting, isLocked, currentValue, allowedValues, formatValue }) {
    const statusClass = isLocked ? 'locked' : 'editable';
    const values = allowedValues || setting.values;
    let options = '';
    values.forEach(val => {
      const selected = String(val) === String(currentValue) ? 'selected' : '';
      options += `<option value="${val}" ${selected}>${formatValue(val, key)}</option>`;
    });
    return `<div class="${MARKUP_CLASSES.CUSTOM_ITEM} ${statusClass}">
      <select id="custom-setting-${key}" ${isLocked ? 'disabled' : ''} data-setting="${key}">${options}</select>
      <label for="custom-setting-${key}" class="${MARKUP_CLASSES.SETTING_NAME}">${setting.label || key}</label>
    </div>`;
  }
});
