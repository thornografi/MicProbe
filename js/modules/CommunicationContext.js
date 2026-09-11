import { captureEnvironment } from './EnvironmentContext.js';

export function createCommunicationContext({ profile = {}, navigator: navigatorInfo, environment = captureEnvironment(navigatorInfo) } = {}) {
  const usage = profile.category === 'call' ? 'voice-call'
    : ['whatsapp-voice', 'telegram-voice'].includes(profile.id) ? 'voice-message'
      : profile.id === 'raw' ? 'recording' : 'unknown';
  return Object.freeze({
    usage,
    access: Object.freeze({ formFactor: environment.formFactor, source: environment.formFactorSource }),
    client: 'browser'
  });
}

// Missing legacy context stays unknown; do not reconstruct it using the current environment.
export const UNKNOWN_COMMUNICATION_CONTEXT = createCommunicationContext();
