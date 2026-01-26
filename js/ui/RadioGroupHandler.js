/**
 * RadioGroupHandler - Radio ve checkbox event handler'lari
 * OCP: Yeni radio grubu eklemek icin mevcut kodu degistirmek gerekmiyor
 * DRY: Tekrarlayan event listener pattern'i merkezi
 */

import eventBus from '../modules/EventBus.js';
import { log } from '../modules/utils.js';

/**
 * RadioGroupHandler - Static utility class
 */
export class RadioGroupHandler {
  /**
   * Checkbox logger factory - checkbox degisikliklerini logla
   * @param {HTMLElement} checkbox - Checkbox elementi
   * @param {string} settingName - Ayar adi (log icin)
   * @param {string} displayName - Gosterilecek ad
   */
  static attachCheckboxLogger(checkbox, settingName, displayName) {
    if (!checkbox) return;

    checkbox.addEventListener('change', (e) => {
      log.stream(`${displayName}: ${e.target.checked ? 'ACIK' : 'KAPALI'}`, { setting: settingName, value: e.target.checked });
    });
  }

  /**
   * Radio grup event listener'i ekle
   * @param {string} name - Radio grubu adi
   * @param {NodeList|Array} radios - Radio elementleri
   * @param {Object} options - Ayarlar
   * @param {Object} options.labels - Deger -> Label map
   * @param {string} options.logCategory - Log kategorisi (default: 'log:ui')
   * @param {Function} options.onChange - Degisiklik callback'i
   * @param {Function} options.formatValue - Deger formatlama fonksiyonu
   */
  static attachGroup(name, radios, options = {}) {
    const {
      labels = {},
      logCategory = 'log:ui',
      onChange = null,
      formatValue = null
    } = options;

    if (!radios || radios.length === 0) return;

    radios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        const rawValue = e.target.value;

        // Sayi ise parse et
        const value = !isNaN(rawValue) && rawValue !== '' ? Number(rawValue) : rawValue;

        // Deger formatlama
        let displayValue = labels[rawValue] || labels[value];
        if (!displayValue && formatValue) {
          displayValue = formatValue(value);
        }
        if (!displayValue) {
          displayValue = String(value);
        }

        // Custom callback
        if (onChange) {
          onChange(value, e);
        }

        // Log emit
        eventBus.emit(logCategory, {
          message: `${name}: ${displayValue}`,
          details: { setting: name, value }
        });

        // Generic event emit - dinleyiciler icin
        eventBus.emit(`setting:${name}:changed`, { value, raw: rawValue });
      });
    });
  }

  /**
   * Birden fazla radio grubunu toplu olarak kaydet
   * @param {Object} config - Radio grubu konfigurasyonu
   *
   * Ornek:
   * {
   *   pipeline: {
   *     radios: [...pipelineRadios],
   *     labels: { direct: 'Direct', standard: 'Standard' },
   *     logCategory: 'log:webaudio',
   *     onChange: (value) => { ... }
   *   },
   *   encoder: { ... }
   * }
   */
  static attachGroups(config) {
    Object.entries(config).forEach(([name, groupConfig]) => {
      const { radios, ...options } = groupConfig;
      RadioGroupHandler.attachGroup(name, radios, options);
    });
  }

  /**
   * Toggle (checkbox) event listener'i ekle
   * @param {HTMLElement} toggle - Toggle elementi
   * @param {string} name - Toggle adi
   * @param {Object} options - Ayarlar
   */
  static attachToggle(toggle, name, options = {}) {
    const {
      logCategory = 'log:stream',
      onChange = null,
      onLabel = 'AKTIF',
      offLabel = 'PASIF'
    } = options;

    if (!toggle) return;

    toggle.addEventListener('change', (e) => {
      const value = e.target.checked;

      // Custom callback
      if (onChange) {
        onChange(value, e);
      }

      // Log emit
      eventBus.emit(logCategory, {
        message: `${name}: ${value ? onLabel : offLabel}`,
        details: { setting: name, value }
      });

      // Generic event emit
      eventBus.emit(`setting:${name}:changed`, { value });
    });
  }
}

export default RadioGroupHandler;
