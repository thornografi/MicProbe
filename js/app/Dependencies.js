/**
 * Dependencies - Controller bagimliliklari
 */
import { usesWebAudio } from '../modules/utils.js';
import { SETTINGS } from '../modules/Config.js';
import { AUDIO, BUFFER, ENCODER_TYPES, SETTING_NAMES } from '../modules/constants.js';
import { getStateAccessors } from './AppState.js';
import { getRadioValue } from './SettingHelpers.js';

/**
 * Controller bagimliliklarini olustur
 * @param {Object} modules - recorder, monitor, player, uiStateManager
 * @param {Object} elements - UI elementleri
 * @param {Object} deviceInfo - DeviceInfo instance
 * @returns {Object} controllerDeps
 */
export function createControllerDeps(modules, elements, deviceInfo) {
  const { recorder, monitor, player, uiStateManager } = modules;
  const stateAccessors = getStateAccessors();

  return {
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
    monitor,
    player,
    uiStateManager,
    ...stateAccessors
  };
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
