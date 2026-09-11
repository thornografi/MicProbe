import { captureEnvironment } from './EnvironmentContext.js';

// Shared by immediate capture help and the server's contextual review catalog.
export const INPUT_SOURCES = Object.freeze({
  windows: { label: 'Microsoft: microphone checks', url: 'https://support.microsoft.com/en-us/windows/hardware/drivers/fix-microphone-problems' },
  macos: { label: 'Apple: sound input settings', url: 'https://support.apple.com/guide/mac-help/change-the-sound-input-settings-mchlp2567/mac' },
  chrome: { label: 'Google: microphone permissions', url: 'https://support.google.com/chrome/answer/2693767' }
});

export function inputSettingsInstruction(os, target = 'recording') {
  const input = target === 'recording' ? 'the same device used for this recording' : 'the microphone used in the affected app';
  if (os === 'windows') return `Open Windows Settings > System > Sound > Input and select ${input}.`;
  if (os === 'macos') return `Open Apple menu > System Settings (System Preferences on older versions) > Sound > Input and select ${input}.`;
  return 'Check the selected microphone and any input controls offered by your device or its audio software.';
}

export function microphonePermissionInstruction({ os, browser } = {}) {
  if (os === 'ios') return `${browser === 'chrome' ? 'If Chrome shows a microphone icon beside the address bar, open it and check the site permission. ' : ''}Check microphone access for your browser in the iPhone or iPad Settings app, then return to the page and allow access if asked.`;
  const site = browser === 'chrome' && ['windows', 'macos', 'linux', 'chromeos'].includes(os)
    ? 'In Chrome Settings > Privacy and security > Site settings > Microphone, check access for this site.'
    : browser === 'chrome' && os === 'android' ? 'In Chrome Settings > Site settings > Microphone, check access for this site.'
    : 'Check this site’s microphone permission in your browser’s site settings.';
  const system = os === 'windows' ? 'In Windows Settings, search for Microphone privacy settings and check access for desktop apps.'
    : os === 'macos' ? 'In Mac System Settings > Privacy & Security > Microphone, check access for your browser.'
      : 'If site access is allowed, check your browser’s microphone permission in the device settings.';
  return `${site} ${system}`;
}

export function captureErrorMessage(error, environment = captureEnvironment(globalThis.navigator)) {
  const messages = {
    NotAllowedError: `Microphone access is blocked. ${microphonePermissionInstruction(environment)}`,
    NotFoundError: 'No matching microphone was found. Connect or enable the intended input, then select it and try again.',
    NotReadableError: 'The microphone could not be opened. Check its connection and try again after closing another app using it; this error does not identify the cause.',
    OverconstrainedError: 'This microphone could not use the requested settings. Restore the test settings or select another input, then retry.',
    AbortError: 'Microphone access was interrupted. Try again; if it continues, check the selected input.',
    SecurityError: 'Microphone access was blocked by a security policy. Check browser or organisation restrictions; ask your administrator if the setting is managed.'
  };
  return messages[error?.name] || error?.message || 'Microphone access failed. Check the selected input and try again.';
}
