import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES } from '../modules/Config.js';
import { updateCategoryUI } from '../app/ModuleInit.js';
import { setupButtonHandlers } from '../app/ButtonHandlers.js';
import uiStateManager from '../modules/UIStateManager.js';

function element() {
  const classes = new Set();
  const attributes = new Map();
  const text = { textContent: '' };
  return {
    style: {}, disabled: false,
    classList: {
      toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
    querySelector() { return text; }
  };
}

test('all call scenarios retain Test while voice-message and raw scenarios retain Record', () => {
  const remoteVu = element();
  globalThis.document = { getElementById: () => remoteVu };
  for (const profile of Object.values(PROFILES)) {
    const elements = {
      testBtn: element(), recordToggleBtn: element(), recordingPlayerPanelEl: element()
    };
    updateCategoryUI(profile.id, elements);
    const isCall = profile.category === 'call';
    assert.equal(elements.testBtn.style.display, isCall ? 'flex' : 'none', profile.id);
    assert.equal(elements.recordToggleBtn.style.display, isCall ? 'none' : 'flex', profile.id);
    assert.equal(elements.recordingPlayerPanelEl.style.display, isCall ? 'none' : 'block', profile.id);
    assert.equal(remoteVu.style.display, isCall ? 'block' : 'none', profile.id);
  }
});

test('Test and Record buttons route to their own flow without a live-preview controller', async () => {
  const elements = { testBtn: element(), recordToggleBtn: element() };
  const actions = [];
  setupButtonHandlers(elements, {
    testRecordingFlow: { async toggle() { actions.push('test'); } },
    recordingController: { async toggle() { actions.push('record'); } }
  });
  await elements.testBtn.onclick();
  await elements.recordToggleBtn.onclick();
  assert.deepEqual(actions, ['test', 'record']);
});

test('Test preparation, capture, analysis and recording retain exclusive actions and profile locks', () => {
  globalThis.document = { body: { dataset: {} } };
  const manager = new uiStateManager.constructor();
  const elements = { testBtn: element(), recordToggleBtn: element(), micSelector: element() };
  const profileButton = element();
  let currentMode = null, isPreparing = false;
  manager.init(elements);
  manager.setProfileCollections({ navItems: [profileButton] });
  manager.setStateGetters({ currentMode: () => currentMode, isPreparing: () => isPreparing });

  manager.updateButtonStates();
  assert.equal(document.body.dataset.appState, 'idle');
  assert.equal(elements.testBtn.disabled, false);
  assert.equal(elements.recordToggleBtn.disabled, false);
  assert.equal(profileButton.getAttribute('aria-disabled'), 'false');

  currentMode = 'test-recording'; isPreparing = true;
  manager.updateButtonStates();
  assert.equal(document.body.dataset.appState, 'preparing');
  assert.equal(elements.testBtn.getAttribute('aria-label'), 'Preparing scenario test');
  assert.equal(elements.recordToggleBtn.disabled, true);
  assert.equal(elements.micSelector.disabled, true);
  assert.equal(profileButton.getAttribute('aria-disabled'), 'true');

  isPreparing = false;
  manager.updateButtonStates();
  assert.equal(document.body.dataset.appState, 'testing');
  assert.equal(elements.testBtn.disabled, false);
  assert.equal(elements.testBtn.getAttribute('aria-label'), 'Finish test recording and analyse');

  currentMode = 'test-analysing';
  manager.updateButtonStates();
  assert.equal(elements.testBtn.getAttribute('aria-label'), 'Analysing recording');
  assert.equal(elements.recordToggleBtn.disabled, true);

  currentMode = 'recording';
  manager.updateButtonStates();
  assert.equal(document.body.dataset.appState, 'recording');
  assert.equal(elements.testBtn.disabled, true);
  assert.equal(elements.recordToggleBtn.disabled, false);
  assert.equal(elements.recordToggleBtn.getAttribute('aria-label'), 'Stop recording');
});
