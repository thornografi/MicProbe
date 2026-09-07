import { createCommunicationContext } from './CommunicationContext.js';
import { createTroubleshootingContext } from './TroubleshootingContext.js';

// A run owns the settings selected before permission/setup and the settings the device delivered.
let nextRun = 0;

export function createRunSnapshot({ profile = {}, requestedSettings = {}, captureGuide = null, troubleshooting = {}, navigator: navigatorInfo = globalThis.navigator } = {}) {
  return Object.freeze({
    runId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${++nextRun}`,
    profileId: profile.id ?? null,
    profileLabel: profile.label ?? null,
    category: profile.category ?? null,
    captureGuide: captureGuide ? Object.freeze({ ...captureGuide }) : null,
    communicationContext: createCommunicationContext({ profile, navigator: navigatorInfo }),
    troubleshooting: createTroubleshootingContext({ input: troubleshooting, navigator: navigatorInfo }),
    detection: profile.detection ? { ...profile.detection } : null,
    evidence: profile.evidence ? Object.freeze(structuredClone(profile.evidence)) : null,
    requestedSettings: Object.freeze(structuredClone(requestedSettings))
  });
}

export function completeRunSnapshot(snapshot, stream, execution = {}) {
  const track = stream?.getAudioTracks?.()[0];
  const settings = track?.getSettings?.() || {};
  const capabilities = track?.getCapabilities?.() || {};
  return Object.freeze({
    ...(snapshot || createRunSnapshot()),
    ...execution,
    startedAt: new Date().toISOString(),
    appliedSettings: Object.freeze({ ...settings }),
    device: Object.freeze({
      micName: track?.label || null,
      channelCount: settings.channelCount ?? null,
      sampleRate: settings.sampleRate ?? null,
      capabilities: {
        sampleRateRange: capabilities.sampleRate ?? null,
        channelCountRange: capabilities.channelCount ?? null,
        ecSupported: capabilities.echoCancellation ?? null,
        nsSupported: capabilities.noiseSuppression ?? null,
        agcSupported: capabilities.autoGainControl ?? null
      }
    })
  });
}
