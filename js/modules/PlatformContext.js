import { captureEnvironment } from './EnvironmentContext.js';

// Pin the reference catalog at capture time. Publishing new laboratory evidence
// requires a new version; an old report must never silently inherit it.
export const PLATFORM_REFERENCE_VERSION = '2026-09-11.1';

export const PLATFORM_TARGET_CATALOGS = Object.freeze({
  '2026-09-11.1': Object.freeze(Object.fromEntries([
  ['teams', 'teams', 'voice-call'], ['webex', 'webex', 'voice-call'],
  ['zoom', 'zoom', 'voice-call'], ['google-meet', 'google-meet', 'voice-call'],
  ['discord', 'discord', 'voice-call'], ['whatsapp-call', 'whatsapp', 'voice-call'],
  ['telegram-call', 'telegram', 'voice-call'], ['whatsapp-voice', 'whatsapp', 'voice-message'],
  ['telegram-voice', 'telegram', 'voice-message'], ['raw', null, 'recording'],
  ['meeting-call', null, 'voice-call'], ['zoom-hifi', null, 'music-call'],
  ['whatsapp-telegram-call', null, 'voice-call']
  ].map(([id, platform, mode]) => [id, Object.freeze({ platform, mode, client: 'unknown' })])))
});
export const PLATFORM_TARGETS = PLATFORM_TARGET_CATALOGS[PLATFORM_REFERENCE_VERSION];

// Coarse local-browser hints, not the user's target-app client or a device ID.
// Unknown browsers cannot inherit a measured Chrome/Safari reference.
export function capturePlatformRuntime(navigatorInfo, formFactor, environment = captureEnvironment(navigatorInfo)) {
  return Object.freeze({ browser: environment.browser, majorVersion: environment.browserMajor,
    platform: navigatorInfo?.platform || 'unknown', formFactor: formFactor || 'unknown' });
}
