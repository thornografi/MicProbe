import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES } from '../modules/Config.js';
import { initProfileUIManager, updateCategoryUI } from '../app/ModuleInit.js';
import { setupButtonHandlers } from '../app/ButtonHandlers.js';
import uiStateManager from '../modules/UIStateManager.js';
import profileUIManager from '../ui/ProfileUIManager.js';
import profileController from '../controllers/ProfileController.js';
import eventBus from '../modules/EventBus.js';
import { EVENTS } from '../modules/constants.js';

function element() {
  const classes = new Set();
  const attributes = new Map();
  const listeners = new Map();
  const text = { textContent: '' };
  return {
    style: {}, dataset: {}, disabled: false,
    classList: {
      toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
    removeAttribute(name) { attributes.delete(name); },
    querySelector() { return text; },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); },
    click() { return listeners.get('click')?.(); },
    append() {},
    replaceChildren() {}
  };
}

function scenarioUI(context, profileId = 'discord') {
  const previousDocument = globalThis.document;
  const previousMatchMedia = globalThis.matchMedia;
  const groupToggle = element();
  const groupPanel = element();
  groupToggle.setAttribute('aria-controls', 'scenarioCallOptions');
  const scenarioPicker = element();
  scenarioPicker.querySelectorAll = () => [groupToggle];
  globalThis.matchMedia = () => ({ ...element(), matches: true });
  globalThis.document = {
    body: { dataset: {}, classList: element().classList },
    createElement: element,
    getElementById: id => id === 'scenarioCallOptions' ? groupPanel : null
  };
  const manager = new uiStateManager.constructor();
  const profileUI = new profileUIManager.constructor();
  const state = { currentMode: null, isPreparing: false, isReportPending: false, isFinalizing: false, profileId };
  const elements = { testBtn: element(), recordToggleBtn: element(), micSelector: element() };
  const navItems = ['discord', 'raw'].map(id => Object.assign(element(), {
    dataset: { profile: id },
    closest: () => ({ querySelector: () => id === 'discord' ? groupToggle : null })
  }));
  const scenarioElements = { navItems, scenarioPicker, groupToggle, groupPanel,
    changeScenarioBtn: element(), scenarioWorkspace: element() };
  const getters = {
    currentMode: () => state.currentMode,
    isPreparing: () => state.isPreparing,
    isReportPending: () => state.isReportPending
  };
  manager.init(elements);
  manager.setStateGetters({ ...getters, currentProfileId: () => state.profileId,
    isTestFinalizing: () => state.isFinalizing,
    isRecordingFinalizing: () => state.isFinalizing });
  // App startup updates action state before the scenario UI binds its listeners.
  manager.updateButtonStates();
  initProfileUIManager(profileUI, scenarioElements, getters, {});
  profileUI.updateAll(profileId);
  context.after(() => {
    profileUI.destroy();
    globalThis.document = previousDocument;
    globalThis.matchMedia = previousMatchMedia;
  });
  return { manager, profileUI, state, elements, ...scenarioElements,
    assertScenarioLocked(expected) {
      for (const control of [...navItems, groupToggle, scenarioElements.changeScenarioBtn]) {
        assert.equal(control.disabled, expected, 'scenario selection and Change scenario share the busy lock');
      }
    }
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
    assert.equal(elements.testBtn.hidden, !isCall, profile.id);
    assert.equal(elements.recordToggleBtn.hidden, isCall, profile.id);
    assert.equal(elements.recordingPlayerPanelEl.hidden, true, `${profile.id}: no result card before a sample exists`);
    assert.equal(remoteVu.hidden, !isCall, profile.id);
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

test('Test preparation, capture and analysis synchronize exclusive actions and scenario locks', context => {
  const { manager, state, elements, assertScenarioLocked } = scenarioUI(context);

  manager.updateButtonStates();
  assert.equal(document.body.dataset.appState, 'idle');
  assert.equal(elements.testBtn.disabled, false);
  assert.equal(elements.recordToggleBtn.disabled, false);
  assertScenarioLocked(false);

  state.currentMode = 'test-recording'; state.isPreparing = true;
  manager.updateButtonStates();
  assert.equal(document.body.dataset.appState, 'preparing');
  assert.equal(elements.testBtn.getAttribute('aria-label'), 'Cancel test preparation');
  assert.equal(elements.recordToggleBtn.disabled, true);
  assert.equal(elements.micSelector.disabled, true);
  assertScenarioLocked(true);

  state.isPreparing = false;
  manager.updateButtonStates();
  assert.equal(document.body.dataset.appState, 'testing');
  assert.equal(elements.testBtn.disabled, false);
  assert.equal(elements.testBtn.getAttribute('aria-label'), 'Finish test recording and analyse');
  assertScenarioLocked(true);

  state.isFinalizing = true; state.isPreparing = true;
  manager.updateButtonStates();
  assert.equal(elements.testBtn.disabled, true);
  assert.equal(elements.testBtn.querySelector('.btn-text').textContent, 'Finishing...');
  assert.equal(elements.testBtn.getAttribute('aria-label'), 'Finishing recording');
  assertScenarioLocked(true);

  state.isFinalizing = false; state.isPreparing = false;
  state.currentMode = 'test-analysing';
  manager.updateButtonStates();
  assert.equal(document.body.dataset.appState, 'analysing');
  assert.equal(elements.testBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(elements.testBtn.getAttribute('aria-label'), 'Analysing recording');
  assert.equal(elements.testBtn.disabled, true);
  assert.equal(elements.recordToggleBtn.disabled, true);
  assertScenarioLocked(true);

  state.currentMode = null;
  manager.updateButtonStates();
  assertScenarioLocked(false);
});

test('Record finalization and idle with a pending report keep scenarios locked until report publication', context => {
  const { manager, state, elements, assertScenarioLocked } = scenarioUI(context, 'raw');
  state.currentMode = 'recording';
  manager.updateButtonStates();
  assert.equal(document.body.dataset.appState, 'recording');
  assert.equal(elements.testBtn.disabled, true);
  assert.equal(elements.recordToggleBtn.disabled, false);
  assert.equal(elements.recordToggleBtn.getAttribute('aria-label'), 'Finish test recording and analyse');
  assertScenarioLocked(true);

  state.isFinalizing = true;
  manager.updateButtonStates();
  assert.equal(elements.recordToggleBtn.disabled, true);
  assertScenarioLocked(true);

  state.currentMode = null; state.isFinalizing = false; state.isReportPending = true;
  manager.updateButtonStates();
  assertScenarioLocked(true);
  eventBus.emit(EVENTS.DIAGNOSTIC_REPORT_READY);
  assertScenarioLocked(true);

  state.isReportPending = false;
  eventBus.emit(EVENTS.DIAGNOSTIC_REPORT_READY);
  assertScenarioLocked(false);
});

for (const profileId of [null, 'discord', 'raw']) {
  test(`startup ${profileId || 'without a preference'} enables scenario choice and requires a profile for capture`, context => {
    const { elements, scenarioWorkspace, assertScenarioLocked } = scenarioUI(context, profileId);
    assert.equal(elements.testBtn.disabled, !profileId);
    assert.equal(elements.recordToggleBtn.disabled, !profileId);
    assert.equal(scenarioWorkspace.hidden, !profileId);
    assertScenarioLocked(false);
  });
}

for (const mode of [null, 'test-recording', 'recording']) {
  test(`cancelling preparation from ${mode || 'idle'} restores scenario selection`, context => {
    const { manager, state, assertScenarioLocked } = scenarioUI(context);
    state.currentMode = mode; state.isPreparing = true;
    manager.updateButtonStates();
    assertScenarioLocked(true);
    state.currentMode = null; state.isPreparing = false;
    manager.updateButtonStates();
    assertScenarioLocked(false);
  });
}

test('programmatic selection and chooser actions cannot bypass preparing, capture or pending report locks', async context => {
  const { manager, profileUI, state, changeScenarioBtn, groupToggle, groupPanel } = scenarioUI(context);
  const applyProfile = context.mock.method(profileController, 'applyProfile', async () => {});
  const pausePlayback = context.mock.fn();
  profileUI.setCallbacks({ pausePlayback });
  for (const busy of [
    { currentMode: null, isPreparing: true, isReportPending: false },
    { currentMode: 'test-recording', isPreparing: false, isReportPending: false },
    { currentMode: 'test-analysing', isPreparing: false, isReportPending: false },
    { currentMode: 'recording', isPreparing: false, isReportPending: false },
    { currentMode: null, isPreparing: false, isReportPending: true }
  ]) {
    Object.assign(state, busy);
    manager.updateButtonStates();
    await profileUI.handleProfileSelect('raw');
    changeScenarioBtn.click();
    groupToggle.click();
    assert.equal(groupToggle.getAttribute('aria-expanded'), 'true', 'Busy category controls cannot hide the active scenario');
    assert.equal(groupPanel.hidden, false);
  }
  assert.equal(applyProfile.mock.callCount(), 0);
  assert.equal(pausePlayback.mock.callCount(), 0);
});
