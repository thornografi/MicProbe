/**
 * Dependencies - Controller bagimliliklari
 */
import { usesWebAudio } from '../modules/utils.js';
import { SETTINGS } from '../modules/Config.js';
import { AUDIO, BUFFER, ENCODER_TYPES, SETTING_NAMES } from '../modules/constants.js';
import { getStateAccessors } from './AppState.js';
import { getRadioValue } from './SettingHelpers.js';
import { createRunSnapshot } from '../modules/RunSnapshot.js';

/**
 * Controller bagimliliklarini olustur
 * @param {Object} modules - recorder, player, uiStateManager, profileController (run snapshot icin)
 * @param {Object} elements - UI elementleri
 * @param {Object} deviceInfo - DeviceInfo instance
 * @returns {Object} controllerDeps
 */
export function createControllerDeps(modules, elements, deviceInfo) {
  const { recorder, player, uiStateManager, profileController } = modules;
  const stateAccessors = getStateAccessors();

  const deps = {
    getConstraints: () => createConstraints(elements, deviceInfo),
    getPipeline: () => getRadioValue(SETTING_NAMES.PIPELINE, 'standard'),
    getEncoder: () => getRadioValue(SETTING_NAMES.ENCODER, ENCODER_TYPES.DEFAULT),
    isLoopbackEnabled: () => elements.loopbackToggle?.checked ?? false,
    isWebAudioEnabled: () => usesWebAudio(getRadioValue(SETTING_NAMES.PIPELINE, 'standard')),
    getOpusBitrate: () => getRadioValue(SETTING_NAMES.BITRATE, SETTINGS.bitrate.default, true),
    getTimeslice: () => getRadioValue(SETTING_NAMES.TIMESLICE, 0, true),
    getBufferSize: () => getRadioValue(SETTING_NAMES.BUFFER_SIZE, BUFFER.DEFAULT_SIZE, true),
    getMediaBitrate: () => getRadioValue(SETTING_NAMES.MEDIA_BITRATE, 0, true),
    recorder,
    player,
    uiStateManager,
    ...stateAccessors
  };
  deps.createRunSnapshot = () => createRunSnapshot({
    profile: profileController?.getCurrentProfile?.() || {},
    captureGuide: { enabled: true, noiseCheck: true },
    requestedSettings: {
      ...deps.getConstraints(),
      pipeline: deps.getPipeline(),
      encoder: deps.getEncoder(),
      loopback: deps.isLoopbackEnabled(),
      bitrate: deps.isLoopbackEnabled() ? deps.getOpusBitrate() : deps.getMediaBitrate(),
      bufferSize: deps.getBufferSize(),
      timeslice: deps.getTimeslice()
    }
  });
  return deps;
}

/**
 * Constraints objesi olustur
 */
function createConstraints(elements, deviceInfo) {
  const constraints = {
    echoCancellation: elements.ecCheckbox?.checked ?? false,
    noiseSuppression: elements.nsCheckbox?.checked ?? false,
    autoGainControl: elements.agcCheckbox?.checked ?? false,
    sampleRate: getRadioValue(SETTING_NAMES.SAMPLE_RATE, AUDIO.DEFAULT_SAMPLE_RATE, true),
    channelCount: getRadioValue(SETTING_NAMES.CHANNEL_COUNT, 1, true)
  };

  const deviceId = deviceInfo.getSelectedDeviceId();
  if (deviceId) {
    constraints.deviceId = { exact: deviceId };
  }

  return constraints;
}
