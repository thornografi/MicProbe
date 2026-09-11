import { captureEnvironment, OS_NAMES } from './EnvironmentContext.js';

function field(label, options) {
  return Object.freeze({
    label,
    options: Object.freeze(options.map(([value, optionLabel]) => Object.freeze({ value, label: optionLabel })))
  });
}

// Current runs capture an OS hint; descriptive fields remain for stored-report compatibility.
export const TROUBLESHOOTING_FIELDS = Object.freeze({
  usage: field('Use for help without recording', [
    ['unknown', 'Not sure'], ['voice-call', 'Voice calls'], ['voice-message', 'Voice messages'],
    ['recording', 'Audio recording']
  ]),
  os: field('Operating system with the problem', Object.entries(OS_NAMES)),
  app: field('App with the problem', [
    ['unknown', 'Not sure'], ['discord', 'Discord'], ['teams', 'Microsoft Teams'], ['zoom', 'Zoom'],
    ['whatsapp', 'WhatsApp'], ['telegram', 'Telegram'], ['browser', 'Another browser app'], ['other', 'Another app']
  ]),
  client: field('How you use that app', [
    ['unknown', 'Not sure'], ['native', 'Installed app'], ['web', 'In a browser']
  ]),
  symptom: field('What goes wrong?', [
    ['unknown', 'Not sure'], ['no-input', 'No microphone input'], ['quiet', 'My voice is too quiet'],
    ['noise', 'Too much background noise'], ['distorted', 'Crackling or distorted sound'],
    ['cuts', 'My voice cuts out'], ['bluetooth-change', 'Bluetooth sound changes when a call starts']
  ]),
  scope: field('Where have you noticed it?', [
    ['unknown', 'Not checked yet'], ['all-apps', 'In multiple apps'], ['one-app', 'Only in this app']
  ]),
  trigger: field('When does it happen?', [
    ['unknown', 'Not sure'], ['under-load', 'When the device is busy'], ['background', 'After switching apps or tabs'],
    ['call-start', 'When a call starts'], ['always', 'Throughout use']
  ])
});

const allowedValues = Object.fromEntries(Object.entries(TROUBLESHOOTING_FIELDS)
  .map(([key, definition]) => [key, new Set(definition.options.map(option => option.value))]));

export function createTroubleshootingContext({ input = {}, navigator: navigatorInfo, environment = captureEnvironment(navigatorInfo) } = {}) {
  const values = input && typeof input === 'object' ? input : {};
  const hasOs = Object.hasOwn(values, 'os');
  const selectedOs = hasOs && allowedValues.os.has(values.os);
  const os = selectedOs ? values.os : hasOs ? 'unknown' : environment.os;
  const preservedSource = values.version === 1 && selectedOs
    && ['browser-hint', 'user-selected', 'unknown'].includes(values.osSource) ? values.osSource : null;
  return Object.freeze({
    version: 1,
    os,
    osSource: preservedSource || (selectedOs ? 'user-selected' : os === 'unknown' ? 'unknown' : 'browser-hint'),
    ...Object.fromEntries(['usage', 'app', 'client', 'symptom', 'scope', 'trigger']
      .map(key => [key, allowedValues[key].has(values[key]) ? values[key] : 'unknown']))
  });
}

export function describeTroubleshootingContext(context) {
  const normalized = createTroubleshootingContext({ input: context });
  return Object.entries(TROUBLESHOOTING_FIELDS).flatMap(([key, definition]) => {
    if (normalized[key] === 'unknown') return [];
    const option = definition.options.find(item => item.value === normalized[key]);
    const source = key !== 'os' ? '' : normalized.osSource === 'browser-hint' ? ' (browser hint)'
      : normalized.osSource === 'user-selected' ? ' (you selected)' : '';
    return [[definition.label, option.label + source]];
  });
}

// Legacy reports must not acquire today's browser context on restore.
export const UNKNOWN_TROUBLESHOOTING_CONTEXT = createTroubleshootingContext();
