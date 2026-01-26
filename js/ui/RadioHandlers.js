/**
 * Radio Group Handler Kayitlari
 * Tum radio group ve checkbox handler'larini merkezi yonetim
 */

import { RadioGroupHandler } from './RadioGroupHandler.js';
import { toggleDisplay, needsBufferSetting } from '../modules/utils.js';

/**
 * Checkbox logger'larini kaydet
 * @param {Object} checkboxes - {ec, ns, agc} checkbox elementleri
 */
export function registerCheckboxLoggers({ ecCheckbox, nsCheckbox, agcCheckbox }) {
  RadioGroupHandler.attachCheckboxLogger(ecCheckbox, 'echoCancellation', 'Echo Cancellation');
  RadioGroupHandler.attachCheckboxLogger(nsCheckbox, 'noiseSuppression', 'Noise Suppression');
  RadioGroupHandler.attachCheckboxLogger(agcCheckbox, 'autoGainControl', 'Auto Gain Control');
}

/**
 * Radio group'lari kaydet
 * @param {Object} radios - Radio buton koleksiyonlari
 * @param {Object} callbacks - Callback fonksiyonlari
 */
export function registerRadioGroups(radios, callbacks) {
  const {
    pipelineRadios,
    encoderRadios,
    bufferSizeRadios,
    bitrateRadios,
    timesliceRadios,
    mediaBitrateRadios,
    sampleRateRadios,
    channelCountRadios
  } = radios;

  const {
    syncToCustomPanel,
    updateAllStates,
    updateBufferInfo,
    updateTimesliceInfo,
    profileController,
    bufferSizeContainer
  } = callbacks;

  RadioGroupHandler.attachGroups({
    // Pipeline
    Pipeline: {
      radios: pipelineRadios,
      labels: { direct: 'Direct', standard: 'Direct (WebAudio)', scriptprocessor: 'ScriptProcessor (WebAudio)', worklet: 'Worklet (WebAudio)' },
      logCategory: 'log:webaudio',
      onChange: (pipeline) => {
        syncToCustomPanel('pipeline', pipeline);
        // Buffer size gorunurlugu: profil ayarlarina veya pipeline'a bagli
        const profile = profileController.getCurrentProfile();
        const bufferInProfile = profile?.lockedSettings?.includes('buffer') ||
                                profile?.editableSettings?.includes('buffer') ||
                                profile?.allowedSettings === 'all';
        if (!bufferInProfile) {
          toggleDisplay(bufferSizeContainer, needsBufferSetting(pipeline));
        }
        updateAllStates();
      }
    },

    // Encoder
    Encoder: {
      radios: encoderRadios,
      labels: { mediarecorder: 'MediaRecorder', 'wasm-opus': 'WASM Opus' },
      logCategory: 'log:webaudio',
      onChange: (encoder) => {
        syncToCustomPanel('encoder', encoder);
        updateAllStates();
      }
    },

    // Buffer Size
    'Buffer Size': {
      radios: bufferSizeRadios,
      logCategory: 'log:webaudio',
      formatValue: (v) => `${v} samples`,
      onChange: (bufferSize) => {
        syncToCustomPanel('buffer', bufferSize);
        updateBufferInfo(bufferSize);
      }
    },

    // Opus Bitrate
    'Opus Bitrate': {
      radios: bitrateRadios,
      logCategory: 'log:stream',
      formatValue: (v) => `${v / 1000} kbps`,
      onChange: (bitrate) => syncToCustomPanel('bitrate', bitrate)
    },

    // Timeslice
    Timeslice: {
      radios: timesliceRadios,
      logCategory: 'log:recorder',
      formatValue: (v) => v === 0 ? 'OFF' : `${v}ms`,
      onChange: (timeslice) => {
        syncToCustomPanel('timeslice', timeslice);
        updateTimesliceInfo(timeslice);
      }
    },

    // Media Bitrate
    'Media Bitrate': {
      radios: [...mediaBitrateRadios],
      logCategory: 'log:recorder',
      formatValue: (v) => v === 0 ? 'Off' : `${v / 1000}k`,
      onChange: (mediaBitrate) => syncToCustomPanel('mediaBitrate', mediaBitrate)
    },

    // Sample Rate
    'Sample Rate': {
      radios: [...sampleRateRadios],
      logCategory: 'log:audio',
      formatValue: (v) => `${v} Hz`
    },

    // Channel Count
    'Channel Count': {
      radios: [...channelCountRadios],
      logCategory: 'log:audio',
      formatValue: (v) => v === 1 ? 'Mono' : 'Stereo'
    }
  });
}

/**
 * Loopback toggle'i kaydet
 * @param {HTMLElement} loopbackToggle - Loopback toggle elementi
 * @param {Object} callbacks - Callback fonksiyonlari
 */
export function registerLoopbackToggle(loopbackToggle, callbacks) {
  const {
    opusBitrateContainer,
    updateAllStates,
    profileController,
    eventBus
  } = callbacks;

  RadioGroupHandler.attachToggle(loopbackToggle, 'WebRTC Loopback', {
    logCategory: 'log:stream',
    onLabel: 'AKTIF',
    offLabel: 'PASIF',
    onChange: (enabled) => {
      // Bitrate seciciyi goster/gizle
      toggleDisplay(opusBitrateContainer, enabled);
      updateAllStates();

      // DeviceInfo panelini guncelle
      const profile = profileController.getCurrentProfile();
      if (profile) {
        const currentBitrate = parseInt(document.querySelector('input[name="bitrate"]:checked')?.value || '0', 10);
        const currentMediaBitrate = parseInt(document.querySelector('input[name="mediaBitrate"]:checked')?.value || '0', 10);
        eventBus.emit('profile:changed', {
          profile: profileController.getCurrentProfileId(),
          values: { ...profile.values, loopback: enabled, bitrate: currentBitrate, mediaBitrate: currentMediaBitrate },
          category: profile.category
        });
      }
    }
  });
}
