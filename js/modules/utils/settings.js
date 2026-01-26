/**
 * SettingTypeHandlers - OCP uyumlu setting type registry
 */

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
    return `<div class="custom-setting-item ${statusClass}">
      <input type="checkbox" ${currentValue ? 'checked' : ''} ${isLocked ? 'disabled' : ''} data-setting="${key}">
      <span class="setting-name">${setting.label || key}</span>
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
      const selected = val === currentValue ? 'selected' : '';
      options += `<option value="${val}" ${selected}>${formatValue(val, key)}</option>`;
    });
    return `<div class="custom-setting-item ${statusClass}">
      <select ${isLocked ? 'disabled' : ''} data-setting="${key}">${options}</select>
      <span class="setting-name">${setting.label || key}</span>
    </div>`;
  }
});
