import { createCommunicationContext } from './CommunicationContext.js';
import { createTroubleshootingContext } from './TroubleshootingContext.js';
import { capturePlatformRuntime } from './PlatformContext.js';
import { captureEnvironment } from './EnvironmentContext.js';

// A run owns the settings selected before permission/setup and the settings the device delivered.
let nextRun = 0;

export function createRunSnapshot({ profile = {}, requestedSettings = {}, captureGuide = null, troubleshooting = {}, navigator: navigatorInfo = globalThis.navigator } = {}) {
  const environment = captureEnvironment(navigatorInfo);
  const communicationContext = createCommunicationContext({ profile, environment });
  return Object.freeze({
    runId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${++nextRun}`,
    profileId: profile.id ?? null,
    profileLabel: profile.label ?? null,
    profileReferenceVersion: profile.referenceVersion ?? null,
    category: profile.category ?? null,
    captureGuide: captureGuide ? Object.freeze({ ...captureGuide }) : null,
    communicationContext,
    environment,
    captureRuntime: capturePlatformRuntime(navigatorInfo, communicationContext.access.formFactor, environment),
    troubleshooting: createTroubleshootingContext({ input: troubleshooting, environment }),
    detection: profile.detection ? { ...profile.detection } : null,
    evidence: profile.evidence ? Object.freeze(structuredClone(profile.evidence)) : null,
    transport: profile.transport ? Object.freeze({ ...profile.transport }) : null,
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
