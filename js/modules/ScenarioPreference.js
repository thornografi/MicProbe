import { PROFILES } from './Config.js';

export const SCENARIO_STORAGE_KEY = 'micprobe.lastScenario';

// A remembered choice is optional. Private browsing, blocked storage, and removed
// profiles must all leave the first-use chooser usable.
export function readScenarioPreference() {
  try {
    const id = localStorage.getItem(SCENARIO_STORAGE_KEY);
    return Object.hasOwn(PROFILES, id) ? id : null;
  } catch {
    return null;
  }
}

export function rememberScenario(id) {
  if (!Object.hasOwn(PROFILES, id)) return;
  try {
    localStorage.setItem(SCENARIO_STORAGE_KEY, id);
  } catch { /* Choosing a scenario never depends on persistence. */ }
}
