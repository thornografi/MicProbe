import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES, SETTINGS } from '../modules/Config.js';
import { PIPELINE_TYPES, ENCODER_TYPES } from '../modules/constants.js';
import { getSettingLockPolicy } from '../modules/utils/settings.js';
import profileController from '../controllers/ProfileController.js';
import uiStateManager from '../modules/UIStateManager.js';

const radioKeys = {
  pipeline: 'pipeline', encoder: 'encoder', bitrate: 'bitrate',
  mediaBitrate: 'mediaBitrate', timeslice: 'timeslice', bufferSize: 'buffer'
};

function prepareRadios(profile, values, supported = true) {
  uiStateManager.profileController = { getCurrentProfile: () => profile };
  uiStateManager.elements.loopbackToggle = { checked: values.loopback };
  uiStateManager.setStateGetters({
    isWorkletSupported: () => supported,
    isWasmOpusSupported: () => supported
  });
  uiStateManager.radioGroups = Object.fromEntries(Object.entries(radioKeys).map(([group, key]) => [
    group,
    SETTINGS[key].values.map(value => ({ value: String(value), checked: value === values[key], disabled: false }))
  ]));
  return uiStateManager.radioGroups;
}

function preparePanel(profile) {
  const controls = Object.fromEntries(Object.keys(SETTINGS).map(key => {
    const classes = new Set(profile.lockedSettings.includes(key) ? ['locked'] : []);
    return [key, {
      disabled: profile.lockedSettings.includes(key),
      classes,
      closest: () => ({ classList: { toggle: (name, active) => active ? classes.add(name) : classes.delete(name) } })
    }];
  }));
  profileController.currentProfileId = profile.id;
  profileController.elements.loopbackToggle = { checked: profile.values.loopback };
  profileController.elements.customSettingsGrid = {
    querySelector: selector => controls[selector.match(/data-setting="([^"]+)"/)[1]]
  };
  profileController.callbacks.getRadioValue = key => profile.values[key];
  return controls;
}

// Relevance differs from a profile's permission to change an otherwise useful setting.
const relevantDynamicSettings = {
  discord: ['bitrate'],
  'meeting-call': ['bitrate'],
  'zoom-hifi': ['bitrate'],
  'whatsapp-telegram-call': ['bitrate'],
  'whatsapp-voice': ['mediaBitrate'],
  'telegram-voice': ['mediaBitrate'],
  raw: ['mediaBitrate']
};

test('WhatsApp voice messages use the existing Worklet Opus path without a ScriptProcessor buffer control', () => {
  const profile = PROFILES['whatsapp-voice'];
  assert.equal(profile.values.pipeline, PIPELINE_TYPES.WORKLET);
  assert.equal(profile.values.encoder, ENCODER_TYPES.WASM_OPUS);
  assert.equal(profile.values.loopback, false);
  assert.equal(profile.values.mediaBitrate, 16000);
  assert.deepEqual(profile.allowedValues.mediaBitrate, [16000, 24000, 32000]);
  assert.equal(profile.canRecord, true);
  assert.equal(profile.canTest, false);
  const policy = getSettingLockPolicy(profile, profile.values);
  assert.equal(policy.buffer, true, 'Worklet makes the ScriptProcessor buffer irrelevant');
  assert.equal(policy.mediaBitrate, false, 'the existing local bitrate choices remain editable');
  assert.equal(policy.pipeline, true);
  assert.equal(policy.encoder, true);
  assert.match(profile.detection.method, /AudioWorklet/);
  assert.doesNotMatch(profile.detection.details, /ScriptProcessor/);
});

for (const [profileId, relevant] of Object.entries(relevantDynamicSettings)) {
  test(`${profileId}: panel and radios preserve profile locks while applying dynamic relevance`, () => {
    const profile = PROFILES[profileId];
    const panel = preparePanel(profile);
    const radios = prepareRadios(profile, profile.values);
    profileController.updateCustomSettingsPanelDynamicState();
    uiStateManager._updateRadioGroups({ isIdle: true, isPreparing: false });

    const dynamicKeys = ['buffer', 'mediaBitrate', 'bitrate', 'timeslice'];
    for (const [key, control] of Object.entries(panel)) {
      const expected = profile.lockedSettings.includes(key)
        || (dynamicKeys.includes(key) && !relevant.includes(key));
      assert.equal(control.disabled, expected, `${profileId} panel ${key}`);
      if (profile.lockedSettings.includes(key)) {
        assert.ok(control.classes.has('locked'), 'the static profile lock remains visible');
      }
    }
    for (const [group, key] of Object.entries(radioKeys)) {
      for (const radio of radios[group]) {
        assert.equal(radio.disabled, panel[key].disabled, `${profileId} ${key} radio ${radio.value}`);
      }
    }
  });
}

test('an empty-lock profile retains dynamic settings without treating it as a legacy input format', () => {
  const profile = { lockedSettings: [] };
  const cases = [
    [{ pipeline: 'standard', encoder: 'mediarecorder', loopback: false },
      { buffer: true, mediaBitrate: false, bitrate: true, timeslice: false }],
    [{ pipeline: 'scriptprocessor', encoder: 'wasm-opus', loopback: false },
      { buffer: false, mediaBitrate: false, bitrate: true, timeslice: true }],
    [{ pipeline: 'worklet', encoder: 'pcm-wav', loopback: false },
      { buffer: true, mediaBitrate: false, bitrate: true, timeslice: true }],
    [{ pipeline: 'worklet', encoder: 'mediarecorder', loopback: true },
      { buffer: true, mediaBitrate: true, bitrate: false, timeslice: true }]
  ];
  for (const [values, expected] of cases) {
    assert.deepEqual(getSettingLockPolicy(profile, values), expected);
  }
});

for (const phase of ['preparing', 'recording', 'test-recording', 'test-analysing']) {
  test(`${phase}: a dynamic update cannot unlock recording settings`, context => {
    const profile = PROFILES['whatsapp-voice'];
    const radios = prepareRadios(profile, profile.values);
    const previousDocument = globalThis.document;
    globalThis.document = { body: { dataset: {} } };
    context.after(() => { globalThis.document = previousDocument; });
    uiStateManager.setStateGetters({
      currentMode: () => phase === 'preparing' ? null : phase,
      isPreparing: () => phase === 'preparing'
    });
    uiStateManager.updateButtonStates();
    for (const radio of Object.values(radios).flat()) assert.equal(radio.disabled, true);
    assert.equal(document.body.dataset.appState, { 'test-recording': 'testing', 'test-analysing': 'analysing' }[phase] || phase);

    uiStateManager.setStateGetters({ currentMode: () => null, isPreparing: () => false });
    uiStateManager.updateButtonStates();
    assert.equal(document.body.dataset.appState, 'idle');
    assert.ok(radios.mediaBitrate.every(radio => !radio.disabled), 'idle restores the editable bitrate');
    assert.ok(radios.bufferSize.every(radio => radio.disabled), 'idle keeps the irrelevant Worklet buffer disabled');
  });
}

test('unsupported Worklet and WASM options stay disabled across busy-to-idle updates', () => {
  const profile = { lockedSettings: [] };
  const radios = prepareRadios(profile, { pipeline: 'standard', encoder: 'mediarecorder', loopback: false }, false);
  uiStateManager._updateRadioGroups({ isIdle: false, isPreparing: false });
  uiStateManager._updateRadioGroups({ isIdle: true, isPreparing: false });
  assert.equal(radios.pipeline.find(radio => radio.value === 'worklet').disabled, true);
  assert.equal(radios.encoder.find(radio => radio.value === 'wasm-opus').disabled, true);
  assert.equal(radios.pipeline.find(radio => radio.value === 'standard').disabled, false);
  assert.equal(radios.encoder.find(radio => radio.value === 'mediarecorder').disabled, false);
});
