// Access is a browser-provided hint, not evidence about a native app's audio technology.
function getAccessHint(navigatorInfo) {
  const userAgent = navigatorInfo?.userAgent || '';
  const platform = navigatorInfo?.platform || '';
  if (/Smart-?TV|HbbTV|Tizen|Web[O0]S|GoogleTV|Android TV|CrKey/i.test(userAgent)) {
    return { formFactor: 'unknown', source: 'unknown' };
  }
  if (navigatorInfo?.userAgentData?.mobile === true) {
    return { formFactor: 'mobile', source: 'user-agent-data' };
  }
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)
      || (platform === 'MacIntel' && navigatorInfo?.maxTouchPoints > 1)) {
    return { formFactor: 'mobile', source: 'user-agent' };
  }
  // mobile:false also covers unclassified devices; require an explicit desktop OS hint.
  if (/Windows NT|Macintosh|CrOS|X11.*Linux/i.test(userAgent)
      || /^(Win32|Win64|MacIntel|Linux x86_64)$/.test(platform)) {
    return { formFactor: 'desktop', source: 'user-agent' };
  }
  return { formFactor: 'unknown', source: 'unknown' };
}

export function createCommunicationContext({ profile = {}, navigator: navigatorInfo } = {}) {
  const usage = profile.category === 'call' ? 'voice-call'
    : ['whatsapp-voice', 'telegram-voice'].includes(profile.id) ? 'voice-message'
      : profile.id === 'raw' ? 'recording' : 'unknown';
  return Object.freeze({
    usage,
    access: Object.freeze(getAccessHint(navigatorInfo)),
    client: 'browser'
  });
}

// Missing legacy context stays unknown; do not reconstruct it using the current environment.
export const UNKNOWN_COMMUNICATION_CONTEXT = createCommunicationContext();
