// Browser hints describe the capture device, not a target app or its settings.
// No high-entropy queries, device IDs, extension list or inferred OS version.
export const OS_NAMES = Object.freeze({ unknown: 'Not sure', windows: 'Windows', macos: 'macOS',
  ios: 'iPhone / iPad', android: 'Android', linux: 'Linux', chromeos: 'ChromeOS' });
export const BROWSER_NAMES = Object.freeze({ unknown: 'Unknown browser', chrome: 'Chrome', edge: 'Edge',
  firefox: 'Firefox', safari: 'Safari', opera: 'Opera', samsung: 'Samsung Internet' });
const known = (catalog, value) => Object.hasOwn(catalog, value) ? value : 'unknown';

export function normalizeEnvironment(value) {
  const v = value?.version === 1 ? value : {};
  const os = known(OS_NAMES, v.os), browser = known(BROWSER_NAMES, v.browser);
  return Object.freeze({ version: 1, os, browser,
    osSource: os === 'unknown' ? 'unknown' : 'browser-hint',
    browserMajor: browser !== 'unknown' && Number.isInteger(v.browserMajor) && v.browserMajor > 0 && v.browserMajor < 10000 ? v.browserMajor : null,
    formFactor: ['desktop', 'mobile'].includes(v.formFactor) ? v.formFactor : 'unknown',
    formFactorSource: ['user-agent', 'user-agent-data'].includes(v.formFactorSource) ? v.formFactorSource : 'unknown'
  });
}

export function captureEnvironment(nav) {
  const ua = nav?.userAgent || '', platform = nav?.platform || '', data = nav?.userAgentData;
  if (/Smart-?TV|HbbTV|Tizen|Web[O0]S|GoogleTV|Android TV|CrKey/i.test(ua)) return normalizeEnvironment();
  let os = 'unknown';
  if (/iPhone|iPad|iPod/i.test(ua) || /^(iPhone|iPad|iPod)$/i.test(platform)
    || (platform === 'MacIntel' && nav?.maxTouchPoints > 1)) os = 'ios';
  else if (/Android/i.test(ua)) os = 'android';
  else {
    os = known(OS_NAMES, { Windows: 'windows', macOS: 'macos', iOS: 'ios', Android: 'android',
      Linux: 'linux', 'Chrome OS': 'chromeos', ChromeOS: 'chromeos' }[data?.platform]);
    if (os === 'unknown') {
      if (/Windows NT/i.test(ua) || /^Win(32|64)$/i.test(platform)) os = 'windows';
      else if (/CrOS/i.test(ua)) os = 'chromeos';
      else if (/Macintosh|Mac OS X/i.test(ua) || /^Mac(Intel|PPC)$/i.test(platform)) os = 'macos';
      else if (/X11.*Linux/i.test(ua) || (!data?.mobile && (/Linux/i.test(ua) || /^Linux (x86_64|i[3-6]86)$/i.test(platform)))) os = 'linux';
    }
  }
  let formFactor = 'unknown', formFactorSource = 'unknown';
  if (data?.mobile === true) { formFactor = 'mobile'; formFactorSource = 'user-agent-data'; }
  else if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (platform === 'MacIntel' && nav?.maxTouchPoints > 1)) {
    formFactor = 'mobile'; formFactorSource = 'user-agent';
  } else if (/Windows NT|Macintosh|CrOS|X11.*Linux/i.test(ua) || /^(Win32|Win64|MacIntel|Linux x86_64)$/.test(platform)) {
    formFactor = 'desktop'; formFactorSource = 'user-agent';
  }
  const match = /\b(EdgiOS|EdgA|Edg|OPR|SamsungBrowser|CriOS|FxiOS)\/(\d+)/.exec(ua)
    || /\b(Chrome|Firefox)\/(\d+)/.exec(ua) || (/Safari\//.test(ua) && /\b(Version)\/(\d+)/.exec(ua));
  let browser = { EdgiOS: 'edge', EdgA: 'edge', Edg: 'edge', OPR: 'opera', SamsungBrowser: 'samsung',
    CriOS: 'chrome', Chrome: 'chrome', FxiOS: 'firefox', Firefox: 'firefox', Version: 'safari' }[match?.[1]] || 'unknown';
  let browserMajor = match ? Number(match[2]) : null;
  if (Array.isArray(data?.brands) && data.brands.length) {
    const brands = { 'Microsoft Edge': 'edge', 'Google Chrome': 'chrome', Opera: 'opera', 'Samsung Internet': 'samsung' };
    const brand = data.brands.find(item => Object.hasOwn(brands, item?.brand));
    // Chromium alone does not establish a branded Chrome installation.
    browser = brand ? brands[brand.brand] : 'unknown';
    browserMajor = brand && /^\d+$/.test(brand.version) ? Number(brand.version) : null;
  }
  return normalizeEnvironment({ version: 1, os, browser, browserMajor, formFactor, formFactorSource });
}

export const UNKNOWN_ENVIRONMENT = normalizeEnvironment();
