import test from 'node:test';
import assert from 'node:assert/strict';
import { readScenarioPreference, rememberScenario, SCENARIO_STORAGE_KEY } from '../modules/ScenarioPreference.js';

test('only valid explicit scenario choices are restored; storage failure is optional', t => {
  const previousStorage = globalThis.localStorage;
  t.after(() => { globalThis.localStorage = previousStorage; });
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
  assert.equal(readScenarioPreference(), null);
  rememberScenario('raw');
  assert.equal(readScenarioPreference(), 'raw');
  rememberScenario('removed-profile');
  assert.equal(readScenarioPreference(), 'raw');
  for (const id of ['removed-profile', '__proto__', 'constructor', '']) {
    values.set(SCENARIO_STORAGE_KEY, id);
    assert.equal(readScenarioPreference(), null);
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
  assert.equal(readScenarioPreference(), null);
  assert.doesNotThrow(() => rememberScenario('discord'));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: previousStorage });
});
