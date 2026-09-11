const { normalizeEnvironment, OS_NAMES } = require('../js/modules/EnvironmentContext.js');
const { inputSettingsInstruction, microphonePermissionInstruction, INPUT_SOURCES } = require('../js/modules/InputGuidance.js');
const { PLATFORM_TARGETS } = require('../js/modules/PlatformContext.js');
const question = (id, text, choices) => ({ id, text, options: choices.map(([value, label]) => ({ value, label })) });
const UNKNOWN = ['unknown', 'Not sure'];
const QUESTIONS = {
  targetDevice: question('targetDevice', 'Is the problem on the device that made this recording?', [['same', 'Same device'], ['other', 'Another device'], UNKNOWN]),
  targetOs: question('targetOs', 'Which operating system is on the device with the problem?', Object.entries(OS_NAMES)),
  targetApp: question('targetApp', 'Which app has the problem?', [['teams', 'Microsoft Teams'], ['discord', 'Discord'], ['zoom', 'Zoom'], ['google-meet', 'Google Meet'], ['webex', 'Webex'], ['whatsapp', 'WhatsApp'], ['telegram', 'Telegram'], ['other', 'Another app'], UNKNOWN]),
  targetClient: question('targetClient', 'How do you use the affected app?', [['native', 'Installed app'], ['web', 'In a browser'], UNKNOWN]),
  symptom: question('symptom', 'What do you notice in the affected app?', [['no-input', 'No microphone input'], ['quiet', 'My voice is too quiet'], ['distorted', 'Distorted sound'], ['cuts', 'My voice cuts out'], ['noise', 'Background sound'], ['echo', 'Echo'], ['bluetooth-change', 'Sound changes when a call starts'], UNKNOWN]),
  trigger: question('trigger', 'When does the sound cut out or change?', [['under-load', 'When the device is busy'], ['background', 'After switching apps or tabs'], ['call-start', 'When a call starts'], ['always', 'Throughout use'], UNKNOWN]),
  inputControl: question('inputControl', 'Does the microphone have another input-level control?', [['hardware', 'An interface or microphone gain knob'], ['virtual', 'A virtual mixer or audio app'], ['none', 'No other control'], UNKNOWN])
};
const SOURCES = {
  ...INPUT_SOURCES,
  teams: { label: 'Microsoft: Teams Call health', url: 'https://support.microsoft.com/en-us/teams/meetings/monitor-call-and-meeting-quality-in-microsoft-teams' },
  bluetooth: { label: 'Microsoft: Bluetooth Classic audio', url: 'https://learn.microsoft.com/en-us/windows-hardware/drivers/bluetooth/bluetooth-classic-audio' },
  macBluetooth: { label: 'Apple: Bluetooth audio on Mac', url: 'https://support.apple.com/en-us/102217' }
};
const ACTIONS = {
  captureSelection: { title: 'Check the selected input', instruction: 'Confirm that MicProbe has the microphone you intended to test selected. If it is wrong, change only the input selection and repeat the speaking part.', target: 'capture', changes: [] },
  physicalMute: { title: 'Check the microphone mute switch', instruction: 'Check any mute switch on the microphone, headset or interface. If muted, unmute it and repeat the same phrase. Keep input levels unchanged.', target: 'capture', changes: [] },
  distance: { title: 'Compare speaking distance', instruction: 'Move a little closer for quiet speech, or farther away for distortion. Change only the distance.', target: 'local', changes: ['distance'] },
  hardwareInput: { title: 'Check the microphone gain control', instruction: 'Note the current microphone/interface gain. Change that one control slightly; leave monitor and headphone volume unchanged.', target: 'local', changes: ['input-level'] },
  virtualInput: { title: 'Check the virtual input route', instruction: 'In your virtual mixer, locate the microphone input feeding the selected virtual output. Note its level and change only that input control.', target: 'local', changes: ['input-level'] },
  appInput: { title: 'Check the affected app’s microphone', instruction: 'In the affected app, check mute and select the intended microphone. If the input is wrong, change only that selection.', target: 'external', changes: [] },
  sitePermission: { title: 'Check microphone access for the affected site', instruction: 'Check the affected site’s microphone permission, then retry in that same site.', target: 'external', changes: [] },
  systemInput: { title: 'Check whether the device receives your microphone', instruction: 'Use the device’s microphone test or recording app with the intended input. This distinguishes a local input problem from an app-specific one.', target: 'external', changes: [] },
  headphones: { title: 'Check one playback condition', instruction: 'Use headphones for the same task while keeping microphone settings unchanged. Compare whether the echo or distortion is still heard.', target: 'external', changes: [] },
  appLevel: { title: 'Check one input level in the affected app', instruction: 'If the app provides microphone input volume, note its value and change only that control slightly. Leave speaker volume unchanged.', target: 'external', changes: [] },
  foreground: { title: 'Compare with the affected app in front', instruction: 'Repeat the same task with the affected app or tab kept in front and the screen awake. Keep input and sound settings unchanged.', target: 'external', changes: [] },
  workload: { title: 'Compare one workload change', instruction: 'Pause one busy background activity and repeat the affected task with the same microphone and settings. Restore it if there is no improvement.', target: 'external', changes: [] },
  teamsHealth: { title: 'Inspect the affected Teams call', instruction: 'During the affected call, open More actions > Settings > Call health, if available. Note the time and who hears the cut. Received jitter and packet loss describe audio arriving at that participant, not your outgoing voice.', target: 'external', changes: [], sources: [SOURCES.teams] },
  bluetoothInput: { title: 'Compare the call’s microphone route', instruction: 'Keep the Bluetooth headphones as output, but select a separate built-in or wired microphone for one call, if available. Compare whether the sound still changes when the microphone activates.', target: 'external', changes: [] },
  appBackground: { title: 'Compare one source of background sound', instruction: 'Reduce one audible background source. Repeat in the affected app with the same distance and input settings.', target: 'external', changes: [] },
  supportDetails: { title: 'Collect a focused reproduction for support', instruction: 'Record the affected app and device, their versions, the exact steps and who hears the problem. Include which checks were unavailable or made no difference. Use the app or device vendor’s support channel.', target: 'external', changes: [] }
};
for (const [id, action] of Object.entries(ACTIONS)) Object.assign(action, { id,
  purpose: 'This is a troubleshooting check based on your answers, not a measured cause.',
  keep: 'Change one condition at a time. Restore an ineffective change before trying another.',
  outcomes: action.target === 'local' ? 'Compare the same phrase in MicProbe; a difference does not prove the original cause.'
    : 'Check the result in the affected app and on the affected device. A new MicProbe recording cannot verify this app-specific change.'
});

function resolvedContext(report, answers) {
  const environment = normalizeEnvironment(report?.environment);
  const profileApp = PLATFORM_TARGETS[report?.profile?.id]?.platform || 'unknown';
  const app = answers.targetApp || (QUESTIONS.targetApp.options.some(o => o.value === profileApp) ? profileApp : 'unknown');
  const local = answers.sameProblem === 'yes';
  const useCapture = local || answers.targetDevice === 'same';
  return { os: answers.targetOs || (useCapture ? environment.os : 'unknown'),
    browser: local ? environment.browser : 'unknown', app,
    client: local ? 'web' : answers.targetClient || 'unknown', device: local ? 'capture' : answers.targetDevice || 'unknown',
    symptom: answers.symptom || 'unknown', trigger: answers.trigger || 'unknown', inputControl: answers.inputControl || 'unknown' };
}
function contextKey(context) { return JSON.stringify(context); }
function wasTried(attempts, id, key) { return attempts.some(a => a.actionId === id && (!a.contextKey || a.contextKey === key)); }
function decorate(action, context, key) {
  const next = { ...action, contextKey: key, context: { ...context }, verifiedOn: '2026-09-11' };
  if (action.id === 'systemInput') next.instruction = `${inputSettingsInstruction(context.os, context.device === 'capture' ? 'recording' : 'app')} Use its microphone test if available; otherwise compare a short recording in the device’s recording app.`;
  if (action.id === 'sitePermission') next.instruction = microphonePermissionInstruction(context);
  if (action.id === 'bluetoothInput' && ['windows', 'macos'].includes(context.os)) next.sources = [context.os === 'macos' ? SOURCES.macBluetooth : SOURCES.bluetooth];
  if (action.id === 'systemInput' && SOURCES[context.os]) next.sources = [SOURCES[context.os]];
  if (action.id === 'appLevel' && context.symptom === 'distorted') next.instruction += ' Lower the input level for distortion; do not raise it.';
  return next;
}

function supportDecision(result, report, state) {
  const answers = state.answers || {}, context = resolvedContext(report, answers), key = contextKey(context);
  const nextQuestion = id => ({ ...result, status: 'PREPARE', eligible: false, supportAvailable: true, reason: 'support-context',
    title: 'Choose a check for the problem you reported.', question: QUESTIONS[id], next: null });
  if (!Object.hasOwn(answers, 'sameProblem')) return null; // The evaluator owns the scope question.
  if (answers.sameProblem === 'unknown') return { ...result, status: 'STOP', reason: 'complaint-link-unknown',
    title: 'Listen to the saved sample and compare with the affected app. You can correct this answer when you know where the problem is heard.', next: null };
  if (answers.sameProblem === 'external') {
    if (!Object.hasOwn(answers, 'targetDevice')) return nextQuestion('targetDevice');
    if (context.os === 'unknown' && !Object.hasOwn(answers, 'targetOs')) return nextQuestion('targetOs');
    if (context.app === 'unknown' && !Object.hasOwn(answers, 'targetApp')) return nextQuestion('targetApp');
  }
  if (!Object.hasOwn(answers, 'symptom')) return nextQuestion('symptom');
  if (answers.sameProblem === 'external' && context.symptom === 'no-input' && !Object.hasOwn(answers, 'targetClient')) return nextQuestion('targetClient');
  if (context.symptom === 'cuts' && !Object.hasOwn(answers, 'trigger')) return nextQuestion('trigger');
  const ids = [];
  const local = context.device === 'capture';
  if (context.symptom === 'no-input') ids.push(local ? 'captureSelection' : 'appInput', ...(context.client === 'web' ? ['sitePermission'] : []), 'systemInput');
  if (context.symptom === 'quiet') ids.push(...(local ? ['systemInput', 'headphones'] : ['appInput', 'appLevel', 'systemInput']));
  if (context.symptom === 'distorted') ids.push('headphones', local ? 'systemInput' : 'appLevel');
  if (context.symptom === 'echo') ids.push('headphones');
  if (context.symptom === 'noise') ids.push('appBackground');
  if (context.symptom === 'bluetooth-change' && !local) ids.push('bluetoothInput');
  if (context.symptom === 'cuts') {
    if (context.trigger === 'background') ids.push('foreground');
    if (context.trigger === 'under-load') ids.push('workload');
    if (context.app === 'teams' && !local) ids.push('teamsHealth');
    ids.push(local ? 'captureSelection' : 'appInput');
  }
  ids.push('supportDetails');
  const action = ids.find(id => !wasTried(state.attempts || [], id, key));
  const next = action ? decorate(ACTIONS[action], context, key) : null;
  if (next && answers.sameProblem === 'yes') {
    next.target = 'capture';
    next.instruction = next.instruction.replaceAll('the affected app', 'MicProbe');
    next.outcomes = 'Check the same saved sample or repeat the same task in MicProbe, as appropriate for this control. A change is not proof of the original cause.';
  }
  return { ...result, status: action ? 'SUPPORT' : 'STOP', eligible: false, supportAvailable: true,
    reason: action ? 'user-reported-check' : 'checks-exhausted', question: null,
    title: action ? 'A check for the problem you reported.' : 'The relevant checks have been recorded. No cause was confirmed.',
    next };
}

function measuredAction(action, report, state) {
  const context = resolvedContext(report, state.answers || {}), key = contextKey(context);
  const next = decorate(action, context, key);
  if (['inputLevel', 'headroom'].includes(action.id) && ['windows', 'macos'].includes(context.os)) {
    next.instruction = `${inputSettingsInstruction(context.os)} If an input-volume control is available, note its value and ${action.id === 'headroom' ? 'lower' : 'increase'} it slightly. Leave speaking distance and other controls unchanged. If the control is absent or managed, choose Not available.`;
    next.sources = [SOURCES[context.os]]; next.changes = ['input-level'];
  }
  return next;
}

function alternativeInput(report, state, primary) {
  const context = resolvedContext(report, state.answers || {}), attempts = state.attempts || [];
  // Only new, contextual controls get alternatives. Stored legacy steps already
  // offered distance, so do not repeat that work when reopening an old review.
  const key = contextKey({ ...context, inputControl: 'unknown' });
  const prior = attempts.find(a => a.actionId === primary && a.contextKey === key);
  if (!prior || prior.outcome !== 'unavailable') return null;
  if (!Object.hasOwn(state.answers || {}, 'inputControl')) return { question: QUESTIONS.inputControl };
  const ids = context.inputControl === 'hardware' ? ['hardwareInput', 'distance']
    : context.inputControl === 'virtual' ? ['virtualInput', 'distance'] : ['distance'];
  const action = ids.find(id => !wasTried(attempts, id, contextKey(context)));
  if (!action) return null;
  const next = decorate(ACTIONS[action], context, contextKey(context));
  if (action === 'distance') next.instruction = primary === 'headroom'
    ? 'Move slightly farther from the microphone. Keep all input controls unchanged.'
    : 'Move slightly closer to the microphone. Keep all input controls unchanged.';
  else next.instruction += primary === 'headroom' ? ' Reduce gain; do not raise input level.' : ' Increase gain only while speech stays free of distortion.';
  return { next };
}

function silentInputDecision(result, report, state) {
  const context = resolvedContext(report, state.answers || {}), key = contextKey(context);
  const id = ['captureSelection', 'physicalMute', 'systemInput', 'supportDetails'].find(id => !wasTried(state.attempts || [], id, key));
  const next = id ? decorate(ACTIONS[id], context, key) : null;
  if (next) { next.target = 'capture'; next.outcomes = 'Check whether your speech is captured. This does not establish why the original sample was nearly silent.'; }
  return { ...result, status: next ? 'SUPPORT' : 'STOP', eligible: false, question: null, next,
    reason: next ? 'reported-speech-not-captured' : 'checks-exhausted',
    title: 'You reported speaking, but almost no input was captured. Check the input path before changing its level.' };
}

module.exports = { SUPPORT_QUESTIONS: QUESTIONS, SUPPORT_ACTIONS: ACTIONS, resolvedContext, contextKey, wasTried,
  supportDecision, measuredAction, alternativeInput, silentInputDecision };
