// Private, source-backed next steps. New reports use canonical saved-audio
// findings. Description-based rules remain only for existing report contexts.
const VERIFIED_ON = '2026-09-05';
const { inputSettingsInstruction, INPUT_SOURCES } = require('../js/modules/InputGuidance.js');
const { normalizeEnvironment } = require('../js/modules/EnvironmentContext.js');
const { getAppliedConstraints } = require('../js/modules/CaptureContext.js');
const source = (label, url) => ({ label, url });
const SOURCES = {
  windows: INPUT_SOURCES.windows,
  macInput: INPUT_SOURCES.macos,
  latency: source('Resplendence: using LatencyMon', 'https://www.resplendence.com/latencymon_using'),
  windowsPerformance: source('Microsoft: checking Windows performance', 'https://support.microsoft.com/en-us/windows/tips-to-improve-pc-performance-in-windows-b3b3ef5b-5953-fb6a-2528-4bbed82fba96'),
  androidBrowser: source('Google: Chrome microphone permissions', 'https://support.google.com/chrome/answer/2693767?co=GENIE.Platform%3DAndroid&hl=en'),
  androidAccess: source('Google: Android microphone access', 'https://support.google.com/android/answer/13532937?hl=en'),
  iphone: source('Apple: iPhone microphone checks', 'https://support.apple.com/en-ie/101600'),
  isolation: source('Apple: microphone modes on iPhone and iPad', 'https://support.apple.com/en-ie/101993'),
  windowsBluetooth: source('Microsoft: Bluetooth Classic audio', 'https://learn.microsoft.com/en-us/windows-hardware/drivers/bluetooth/bluetooth-classic-audio'),
  macBluetooth: source('Apple: Bluetooth audio on Mac', 'https://support.apple.com/en-us/102217'),
  teams: source('Microsoft: Teams Call health', 'https://support.microsoft.com/en-us/teams/meetings/monitor-call-and-meeting-quality-in-microsoft-teams'),
  discord: source('Discord: voice troubleshooting', 'https://support.discord.com/hc/en-us/articles/360045138471-Discord-Voice-and-Video-Troubleshooting-Guide')
};

const hasOs = (c, ...names) => ['browser-hint', 'user-selected'].includes(c.osSource) && names.includes(c.os);
const nativeApp = c => c.client === 'native' && ['discord', 'teams', 'zoom', 'whatsapp', 'telegram', 'other'].includes(c.app);

// Most specific app routes precede broader system checks. Keep the result bounded
// as the catalog grows; never infer a driver/network fault from timing counters.
const DESCRIPTION_RULES = [
  {
    match: (c, usage) => usage === 'voice-call' && hasOs(c, 'ios') && c.app === 'discord'
      && c.client === 'native' && c.symptom === 'cuts' && c.scope === 'one-app' && c.trigger === 'background',
    create: () => ({
      id: 'GUIDE_DISCORD_IOS_BACKGROUND',
      reason: 'You reported that Discord calls cut out when you switch to another app on iOS.',
      action: 'Check Discord call integration, then repeat the same app switch.',
      steps: [
        'In Discord, open User Settings > Notifications and look for Integrate calls with the Phone app.',
        'If available, enable it. If already enabled, Discord suggests turning it off and on again.',
        'Repeat a short call and the same switch to another app.'
      ],
      expected: 'If the call now stays connected, the result supports keeping that integration enabled for this use.',
      next: 'If it still cuts out or the setting is absent, use Discord support with your iOS version, app version and the exact app-switch steps.',
      sources: [SOURCES.discord]
    })
  },
  {
    match: (c, usage) => usage === 'voice-call' && c.app === 'teams'
      && ['native', 'web'].includes(c.client) && c.symptom === 'cuts' && c.scope === 'one-app',
    create: () => ({
      id: 'GUIDE_TEAMS_CALL_HEALTH',
      reason: 'You reported cuts specifically in Teams calls. This local recording does not measure the Teams connection.',
      action: 'Inspect Call health during the affected Teams call.',
      steps: [
        'During the call, open More actions > Settings > Call health, if available in your client.',
        'Note when a cut is heard and whether your voice or the other person\'s voice is affected.',
        'Compare that time with the displayed audio and network data. Received jitter and received packet loss describe audio arriving at your client; they do not directly measure your voice arriving at the other person.'
      ],
      expected: 'The real-call data and affected direction help choose whether to investigate capture, transmission or reception; a single reading does not identify the cause.',
      next: 'If others hear your voice cut out, compare a local sample and ask the affected participant to check their receiving data. If Call health is absent, provide the client/version to Teams support.',
      sources: [SOURCES.teams]
    })
  },
  {
    match: c => hasOs(c, 'windows') && ['cuts', 'distorted'].includes(c.symptom)
      && c.scope === 'all-apps' && c.trigger === 'under-load',
    create: () => ({
      id: 'GUIDE_WINDOWS_LOAD',
      reason: 'You reported cuts or distortion across apps when the computer is busy. The cause has not been measured here.',
      action: 'Compare a lighter workload before investigating driver timing.',
      steps: [
        'Repeat the same speaking task with fewer busy apps. Use Task Manager to note which activity coincides with the audible problem.',
        'If the problem remains reproducible across apps, optionally run LatencyMon from Resplendence during a reproduction and save its report.',
        'Review DPC/ISR execution times and hard pagefaults together with the audible event. LatencyMon is a separate Windows timing test, not a CPU percentage or internet-quality measurement.'
      ],
      expected: 'A repeatable difference with workload narrows the investigation. One spike or a listed driver alone does not prove that a driver caused the audio problem.',
      next: 'If the lighter workload helps, reintroduce one activity at a time. Otherwise share the reproduction steps and LatencyMon report with the device vendor before changing drivers.',
      sources: [SOURCES.latency, SOURCES.windowsPerformance]
    })
  },
  {
    match: c => hasOs(c, 'windows') && c.symptom === 'no-input',
    create: c => ({
      id: 'GUIDE_WINDOWS_INPUT',
      reason: 'You reported that no microphone input is available on Windows. Start by checking whether Windows itself receives it.',
      action: 'Check Windows input, then the affected app or site.',
      steps: [
        'Open Windows Settings > System > Sound > Input. Select the intended device and use its microphone test; the test controls differ between Windows versions.',
        'If Windows receives no sound, check physical mute and Windows microphone access. In Settings, search for Microphone privacy settings and check app/desktop-app access.',
        c.client === 'web'
          ? 'If Windows receives sound, check the browser\'s microphone access, the affected site\'s permission and its selected input.'
          : 'If Windows receives sound, check the affected app\'s mute, input selection and microphone permission.'
      ],
      expected: 'Working Windows input with a failing app narrows the next check to that app or its access; a failed Windows test leaves the system/input path to investigate.',
      next: 'Repeat after one change. If Windows still receives no sound, follow Microsoft\'s device checks; if only the app fails, continue with that app\'s support guide.',
      sources: [SOURCES.windows]
    })
  },
  {
    match: c => hasOs(c, 'android') && c.client === 'web' && c.symptom === 'no-input',
    create: () => ({
      id: 'GUIDE_ANDROID_WEB_INPUT',
      reason: 'You reported missing input in a browser on Android. Site permission and Android access are separate checks.',
      action: 'Check microphone access at the site, browser app and device levels.',
      steps: [
        'Check the affected site\'s microphone permission in your browser. In Chrome, use Settings > Site settings > Microphone and review blocked sites.',
        'In Android Settings, open the browser app\'s permissions and allow microphone access for the intended use.',
        'If your device provides a microphone-access control in Quick Settings, check that it is on. This control depends on Android version and device. Return to the site and retry.'
      ],
      expected: 'Input returning after an access change supports that permission path; it does not establish a microphone quality fault.',
      next: 'If access is allowed but input still fails, compare a local recording app and report which browser/site fails. Use your browser\'s own instructions if its menus differ from Chrome.',
      sources: [SOURCES.androidBrowser, SOURCES.androidAccess]
    })
  },
  {
    match: c => hasOs(c, 'ios') && nativeApp(c) && c.symptom === 'no-input',
    create: () => ({
      id: 'GUIDE_IOS_APP_INPUT',
      reason: 'You reported missing input in an iOS app. Check the app\'s access and compare a local recording.',
      action: 'Check the affected app\'s microphone permission.',
      steps: [
        'Open Settings > Privacy & Security > Microphone and check that the affected app is enabled, if listed.',
        'Make a short Voice Memos recording and listen to it, then retry the affected app.'
      ],
      expected: 'A clear local memo with missing input only in the app narrows the next check to that app; it does not prove all microphone paths work.',
      next: 'If the app is allowed or absent from the permission list but still fails, contact its developer. If the local memo also fails, continue with Apple\'s microphone checks.',
      sources: [SOURCES.iphone]
    })
  },
  {
    match: c => hasOs(c, 'ios') && nativeApp(c) && c.symptom === 'noise',
    create: () => ({
      id: 'GUIDE_IOS_MIC_MODE',
      reason: 'You reported unwanted background sound in an iOS app. Supported devices and apps may offer microphone modes.',
      action: 'If available, compare Voice Isolation with Standard in the affected app.',
      steps: [
        'While the app is using the microphone, open Control Centre and its app controls. Look for Mic Mode; availability depends on your device, OS version and app.',
        'If offered, record or speak the same phrase using Standard and Voice Isolation, keeping distance and background conditions the same.',
        'Compare both speech clarity and background sound. If the option is absent, skip this step rather than changing unrelated settings.'
      ],
      expected: 'Keep the mode that makes speech easier to hear without unwanted processing. Quieter background alone does not prove better speech quality.',
      next: 'If neither mode helps, compare the same app in a quieter setting. If the controls are unavailable, use the app\'s supported audio settings.',
      sources: [SOURCES.isolation]
    })
  },
  {
    match: (c, usage) => usage === 'voice-call' && hasOs(c, 'windows', 'macos')
      && c.symptom === 'bluetooth-change' && c.trigger === 'call-start',
    create: c => ({
      id: 'GUIDE_BLUETOOTH_CALL_CHANGE',
      reason: 'You reported a Bluetooth sound change when a call starts. Opening the headset microphone can change its audio path; this test has not identified the active Bluetooth mode.',
      action: 'Compare the call using another input while keeping the headphones as output, if your app allows it.',
      steps: [
        'In the affected app, note its selected input and output before the call.',
        'If a built-in or other microphone is available, select it as input and keep the Bluetooth headphones as output. Repeat the same short call.',
        'Check both what you hear and what the other person hears. Revert the input if the alternative makes your voice worse.'
      ],
      expected: 'A repeatable change narrows the issue to the input/routing combination. It does not identify the active codec or prove that the headset is defective.',
      next: c.os === 'windows'
        ? 'If unchanged, check the Windows version and headset support before investigating Bluetooth Classic versus LE Audio behavior; this report cannot determine which is active.'
        : 'If output remains affected after the call, close apps using the headset microphone and follow Apple\'s Bluetooth audio checks.',
      sources: [c.os === 'windows' ? SOURCES.windowsBluetooth : SOURCES.macBluetooth]
    })
  }
];

function inputLevelInstruction(report, reduce = false) {
  const automatic = getAppliedConstraints(report.profile).autoGainControl === true;
  if (automatic) return `Automatic gain control was active. Check whether the input level is managed or moves automatically during speech before changing a manual control. ${reduce
    ? 'If playback sounds distorted, lower one available input-level control or move slightly farther from the microphone. Do not increase gain.'
    : 'If spoken audio sounds too quiet, check microphone position and one available input-level control.'} If the system level is managed, use the microphone/interface control or speaking distance instead.`;
  return reduce
    ? 'If playback sounds distorted, lower one available input-level control or move slightly farther from the microphone. Do not increase gain to compensate for quiet sections.'
    : 'If spoken audio sounds too quiet, check microphone position and the selected input level. The recording alone does not identify the cause.';
}

function automaticInputGuidance(report, context, measurementFindings) {
  if (report.run?.type === 'troubleshooting' || context.osSource !== 'browser-hint'
      || !['windows', 'macos'].includes(context.os) || report.audioMetrics?.source !== 'decoded-file-pcm') return [];
  // The evaluator supplies its canonical, sufficiently measured findings. Do not
  // run another level classifier here or promote imported report fields to evidence.
  const saturation = measurementFindings.some(item => item.id === 'FULL_SCALE_SAMPLES');
  const pinned = !saturation && measurementFindings.some(item => item.id === 'PINNED_CEILING');
  const lowLevel = !saturation && !pinned && !measurementFindings.some(item => item.id === 'TRUE_PEAK_OVER')
    && measurementFindings.some(item => item.id === 'LOW_RECORDED_LEVEL' && !item.nearSilent);
  if (!saturation && !pinned && !lowLevel) return [];
  const windows = context.os === 'windows';
  const osName = windows ? 'Windows' : 'macOS';
  return [{
    id: windows ? 'GUIDE_WINDOWS_RECORDED_INPUT' : 'GUIDE_MACOS_RECORDED_INPUT',
    replaces: saturation ? 'FULL_SCALE_SAMPLES' : pinned ? 'PINNED_CEILING' : 'LOW_RECORDED_LEVEL',
    reason: saturation
      ? 'Some samples in the saved recording reach full scale. Listen for distortion before changing the input level.'
      : pinned
        ? 'Many saved samples cluster near a ceiling below full scale. Clipping or limiting can produce this pattern; it does not locate the cause in the interface or microphone.'
        : measurementFindings.find(item => item.id === 'LOW_RECORDED_LEVEL').reason + ' This does not show whether you were speaking or why the level was low.',
    action: saturation || pinned
      ? `If playback sounds distorted, reduce an available input-level control in ${osName} or on your device. Increasing gain could worsen the peaks.`
      : `If you spoke during this recording and playback is too quiet, check the selected input in ${osName}.`,
    steps: [
      inputSettingsInstruction(context.os),
      inputLevelInstruction(report, saturation || pinned)
    ],
    expected: 'These controls apply to the local recording device. The selected platform preset does not measure settings inside your actual app.',
    evidence: `Based on the saved recording and a browser hint for ${osName}. The operating system's settings and the cause of the measured level were not inspected.`,
    sources: [windows ? SOURCES.windows : SOURCES.macInput]
  }];
}

function getTroubleshootingGuidance(report, { measurementFindings = [] } = {}) {
  let context = report?.troubleshooting;
  // Current measured reports own a frozen capture environment. A legacy target
  // description must not redirect that recording's instructions to another OS.
  if (report?.run?.type !== 'troubleshooting' && report?.environment?.version === 1) {
    const environment = normalizeEnvironment(report.environment);
    context = { version: 1, os: environment.os, osSource: environment.osSource,
      ...Object.fromEntries(['app', 'client', 'symptom', 'scope', 'trigger'].map(key => [key, 'unknown'])) };
  }
  if (!context || typeof context !== 'object' || Array.isArray(context) || context.version !== 1) return [];
  const usage = report.run?.type === 'troubleshooting' ? context.usage : report.communicationContext?.usage;
  const automatic = ['app', 'client', 'symptom', 'scope', 'trigger'].every(key => context[key] === 'unknown');
  const items = automatic ? automaticInputGuidance(report, context, measurementFindings)
    : DESCRIPTION_RULES.filter(rule => rule.match(context, usage)).map(rule => rule.create(context));
  return items.slice(0, 2).map(item => {
    return {
      category: 'troubleshooting', severity: 'info', confidence: 'low', relatedSetting: null,
      evidence: 'Based on your description. These checks do not establish a measured fault in the target app or operating system.',
      ...item, message: item.reason,
      verifiedOn: VERIFIED_ON,
      sources: item.sources.map(entry => ({ ...entry }))
    };
  });
}

module.exports = { getTroubleshootingGuidance, inputLevelInstruction };
