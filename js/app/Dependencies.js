/**
 * Dependencies - Controller bagimliliklari
 */
import { usesWebAudio } from '../modules/utils.js';
import { SETTINGS } from '../modules/Config.js';
import { AUDIO } from '../modules/constants.js';
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
    getPipeline: () => getRadioValue('pipeline', 'standard'),
    getEncoder: () => getEncoderValue(elements),
    isLoopbackEnabled: () => elements.loopbackToggle.checked,
    isWebAudioEnabled: () => usesWebAudio(getRadioValue('pipeline', 'standard')),
    getOpusBitrate: () => getRadioValue('bitrate', SETTINGS.bitrate.default, true),
    getTimeslice: () => getRadioValue('timeslice', 0, true),
    getBufferSize: () => getRadioValue('bufferSize', 4096, true),
    getMediaBitrate: () => getRadioValue('mediaBitrate', 0, true),
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
    echoCancellation: elements.ecCheckbox.checked,
    noiseSuppression: elements.nsCheckbox.checked,
    autoGainControl: elements.agcCheckbox.checked,
    sampleRate: getRadioValue('sampleRate', AUDIO.DEFAULT_SAMPLE_RATE, true),
    channelCount: getRadioValue('channelCount', 1, true)
  };

  const deviceId = deviceInfo.getSelectedDeviceId();
  if (deviceId) {
    constraints.deviceId = { exact: deviceId };
  }

  return constraints;
}

/**
 * Encoder degerini al
 */
function getEncoderValue(elements) {
  const encoderSelect = document.querySelector('[data-setting="encoder"]');
  if (encoderSelect) {
    return encoderSelect.value;
  }
  return getRadioValue('encoder', 'mediarecorder');
}
