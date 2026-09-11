// Requires Playwright locally or through NODE_PATH, installed Chrome, and localhost:8080.
// Isolated contexts use synthetic reports and HTTP fixtures; no microphone or real sign-in.
const { chromium, firefox, webkit } = require('playwright');
const assert = require('node:assert/strict');

const BASE = 'http://localhost:8080';
const report = (id, label, generatedAt, peakDb) => ({
  version: '2.0', generatedAt, sessionId: 'account-browser-fixture', run: { id, type: 'test' },
  device: { micName: 'Synthetic USB microphone' },
  profile: { id: 'discord', label, category: 'call', approximation: true, pipeline: 'mediarecorder', encoder: 'opus',
    requestedConstraints: { sampleRate: 16000, noiseSuppression: true },
    appliedConstraints: { sampleRate: 48000, noiseSuppression: false } },
  audioMetrics: { status: 'measured', source: 'decoded-file-pcm', sampleCount: 48000, durationMs: 1000,
    signal: { rmsDb: -24, peakDb }, clipping: { status: 'measured', method: 'sample-saturation', rate: 0 },
    headroom: { peakDb, db: peakDb == null ? null : -peakDb }, coverage: { truncated: false },
    noiseFloor: { status: 'unavailable', estimatedDb: null }, snr: { status: 'unavailable', estimatedDb: null } }
});
const before = report('00000000-0000-4000-8000-000000000001', 'Before gain change', '2026-09-05T10:00:00.000Z', null);
const after = report('00000000-0000-4000-8000-000000000002', 'After gain change', '2026-09-05T10:05:00.000Z', -10);
after.audioMetrics.signal.rmsDb = -18;
after.profile.appliedConstraints.noiseSuppression = true;
const privateReport = report('00000000-0000-4000-8000-000000000003', 'Private account report', '2026-09-05T10:10:00.000Z', -12);

async function createPage(browser, { signedIn = false, configured = signedIn, purchasePending = false, purchaseLinked = signedIn, comparisonReports = false,
  userName = 'Fixture account', userEmail = 'fixture@example.test' } = {}) {
  const accountConfigured = configured;
  let premiumUnlocked = signedIn && purchaseLinked && !purchasePending;
  let sessionUnavailable = false;
  let reportWritesUnavailable = false;
  let historyUnavailable = false;
  const savedReports = new Map((signedIn ? (comparisonReports ? [before, after] : [privateReport]) : []).map(value => {
    const id = comparisonReports ? value.run.id : '00000000-0000-4000-8000-000000000099';
    return [id, { id, report: value, note: 'Account A only', createdAt: value.generatedAt }];
  }));
  let observedCheckoutSnapshot;
  const signInChoices = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ legacyPremium, pendingReturn }) => {
    window.__accountTestMicRequests = 0;
    window.__googleFixture = { loads: 0, prompts: 0, initializations: 0, cancellations: 0 };
    // Playwright's WebKit build on Windows can lack capture APIs entirely.
    // Account UI must still work; any accidental capture request remains fatal.
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {} });
    if (!window.AudioContext && !window.webkitAudioContext) window.AudioContext = class {
      // Account-only fixture for Windows WebKit (which has no WebAudio).
      // It supports idle warmup only; capture is prohibited below.
      state = 'suspended'; sampleRate = 48000;
      async resume() { this.state = 'running'; }
      async close() { this.state = 'closed'; }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      window.__accountTestMicRequests++;
      throw new Error('Account UI test must never request microphone audio');
    };
    if (legacyPremium) localStorage.setItem('micprobe:premium-access:v1', JSON.stringify({
      verified: true, mode: 'sandbox', accessToken: 'old-browser-token-must-not-unlock-signed-out-account'
    }));
    if (pendingReturn) sessionStorage.setItem('micprobe:pending-account-purchase:v1',
      'http://localhost:8080/app?signature=synthetic-signature&checkout_state=synthetic-checkout-state');
  }, { legacyPremium: signedIn, pendingReturn: purchasePending });
  const page = await context.newPage();
  await require('./scenario-browser-helpers.cjs').allowTestAccess(page);
  const pageErrors = []; const consoleErrors = []; const mutations = []; const accountRequests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(`${message.text()} ${message.location().url || ''}`.trim()); });
  // Keep this regression deterministic and entirely local, including lazy font requests.
  await page.route(url => url.origin !== BASE, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  // The running development server may predate the public/ asset mapping.
  // Exercise account behavior against the real icon files without restarting the user's server.
  await page.route(url => url.origin === BASE && /^\/favicon(?:\.svg|-96\.png)$/.test(url.pathname), route =>
    route.fulfill({ path: require('node:path').join(__dirname, '../../public', new URL(route.request().url()).pathname.slice(1)) }));
  await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({ status: 200, contentType: 'application/javascript',
    body: `window.__googleFixture.loads++;
      globalThis.google = {accounts:{id:{
        initialize(options){this.options=options;window.__googleFixture.initializations++;},
        disableAutoSelect(){},
        cancel(){window.__googleFixture.cancellations++;document.getElementById('googleOneTapFixture')?.remove();},
        prompt(){
          window.__googleFixture.prompts++;
          const callback=this.options.callback;
          window.__googleFixture.lateCallback=()=>callback({credential:'synthetic-google-credential'});
          const button=document.createElement('button');button.id='googleOneTapFixture';
          button.textContent='Continue with Google One Tap (test fixture)';
          button.addEventListener('click',()=>callback({credential:'synthetic-google-credential'}));
          document.body.append(button);
        },
        renderButton(container){const callback=this.options.callback;
          const button=document.createElement('button');button.textContent='Continue with Google (test fixture)';
          button.addEventListener('click',()=>callback({credential:'synthetic-google-credential'}));container.append(button);
        }
      }}};` }));
  await page.route('https://checkout.freemius.com/**', route => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<!doctype html><title>Local checkout fixture</title><a id="returnFromCheckout" href="http://localhost:8080/app?signature=synthetic-signature&amp;checkout_state=synthetic-checkout-state">Return to MicProbe</a>' }));
  await page.route('**/api/freemius/config', route => route.fulfill({ json: { configured: false, mode: 'sandbox' } }));
  await page.route('**/api/account/**', async route => {
    const request = route.request(); const pathname = new URL(request.url()).pathname;
    accountRequests.push({ path: pathname, method: request.method() });
    if (!['/api/account/config', '/api/account/session', '/api/account/google'].includes(pathname)) {
      assert.equal(request.headers()['x-micprobe-account'], signedIn ? 'fixture-account-A' : 'anonymous');
    }
    if (request.method() !== 'GET') {
      mutations.push(pathname);
      assert.equal(request.headers()['x-micprobe-request'], '1');
    }
    let payload;
    if (pathname.endsWith('/config')) payload = { ok: true, configured: accountConfigured, googleClientId: accountConfigured ? 'test-client.apps.googleusercontent.com' : null, nonce: accountConfigured ? 'test-only-nonce' : null };
    else if (pathname.endsWith('/session')) payload = sessionUnavailable ? { ok: false, error: 'account_unavailable' }
      : { ok: true, user: signedIn ? { id: 'fixture-account-A', name: userName, email: userEmail } : null,
        purchaseLinked: signedIn && purchaseLinked, premium: { unlocked: premiumUnlocked, pending: purchasePending, mode: 'sandbox' } };
    else if (pathname.endsWith('/reports') && request.method() === 'GET' && historyUnavailable) {
      await route.fulfill({ status: 503, json: { ok: false, error: 'account_unavailable' } }); return;
    }
    else if (pathname.endsWith('/reports') && request.method() === 'GET') payload = { ok: true,
      reports: signedIn ? [...savedReports.values()] : [], nextCursor: null };
    else if (pathname.endsWith('/reports') && request.method() === 'POST') {
      const body = request.postDataJSON();
      const entry = [...savedReports.values()].find(entry => entry.report.run.id === body.report.run.id)
        || { id: body.report.run.id, ...body, createdAt: body.report.generatedAt };
      if (!reportWritesUnavailable) savedReports.set(entry.id, entry);
      payload = reportWritesUnavailable ? { ok: false, error: 'account_unavailable' } : { ok: true, report: entry };
    } else if (pathname.includes('/reports/') && request.method() === 'PATCH') {
      if (reportWritesUnavailable) return route.fulfill({ status: 503, json: { ok: false, error: 'account_unavailable' } });
      const entry = savedReports.get(pathname.split('/').pop());
      entry.note = request.postDataJSON().note;
      payload = { ok: true, report: entry };
    } else if (pathname.includes('/reports/') && request.method() === 'DELETE') {
      savedReports.delete(pathname.split('/').pop());
      payload = { ok: true };
    }
    else if (pathname.endsWith('/google') && request.method() === 'POST') {
      signInChoices.push(request.postDataJSON().rememberMe);
      assert.equal(request.postDataJSON().credential, 'synthetic-google-credential'); signedIn = true;
      payload = { ok: true, user: { id: 'fixture-account-A' }, premium: { unlocked: false, mode: 'sandbox' } };
    } else if (pathname.endsWith('/checkout') && request.method() === 'POST') {
      observedCheckoutSnapshot = await page.evaluate(() => JSON.parse(sessionStorage.getItem('micprobe:checkout-snapshot:v1')));
      payload = { ok: true, checkoutUrl: 'https://checkout.freemius.com/product/123/plan/456/?test=1' };
    } else if (pathname.endsWith('/purchase') && request.method() === 'POST') {
      assert.match(request.postDataJSON().url, /checkout_state=synthetic-checkout-state/);
      premiumUnlocked = true; purchaseLinked = true; payload = { ok: true, premium: { unlocked: true, mode: 'sandbox' } };
    } else if (pathname.endsWith('/logout') && request.method() === 'POST') { signedIn = false; premiumUnlocked = false; payload = { ok: true, user: null, premium: { unlocked: false, mode: 'sandbox' } }; }
    else { await route.fulfill({ status: 400, json: { ok: false, error: 'unexpected_test_request' } }); return; }
    await route.fulfill({ json: payload });
  });
  await page.route('**/api/report/detailed', route => route.fulfill({ json: { ok: true, detailed: {
    metrics: [{ key: 'fixture', label: 'Fixture account detail', value: '-12', unit: 'dBFS', rating: 'info' }], recommendations: []
  } } }));
  // These account fixtures do not start personal reviews or reach the local DB.
  await page.route('**/api/reviews/assess', route => route.fulfill({ json: {
    ok: true, decision: { eligible: false, status: 'UNSUPPORTED', title: 'Account UI fixture' }
  } }));
  await page.route('**/api/reviews/load', route => route.fulfill({ json: { ok: true, review: null } }));
  return { context, page, pageErrors, consoleErrors, mutations, accountRequests, signInChoices, checkoutSnapshot: () => observedCheckoutSnapshot,
    clearReports: () => savedReports.clear(), setHistoryUnavailable: value => { historyUnavailable = value; },
    verifyPurchase: () => { purchasePending = false; premiumUnlocked = true; purchaseLinked = true; },
    setPremiumUnlocked: value => { premiumUnlocked = value; },
    setSessionUnavailable: value => { sessionUnavailable = value; }, setReportWritesUnavailable: value => { reportWritesUnavailable = value; } };
}

async function ready(page) {
  await page.waitForFunction(() => document.body?.classList.contains('app-mode')
    || !!window.__micprobeStartupDiagnostics?.marks?.['showAppView.failed'], null, { timeout: 15000 });
  const startupError = await page.evaluate(() => window.__micprobeStartupDiagnostics?.marks?.['showAppView.failed']?.details?.error);
  assert.equal(startupError, undefined, `Application startup failed: ${startupError}`);
  await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.bootstrap());
  try { await page.locator('#accountMenuBtn').waitFor({ state: 'visible', timeout: 5000 }); }
  catch (error) {
    const visibility = await page.evaluate(() => {
      const ancestors = [];
      for (let node = document.getElementById('accountMenuBtn'); node; node = node.parentElement) {
        const style = getComputedStyle(node); const rect = node.getBoundingClientRect();
        ancestors.push({ tag: node.tagName, id: node.id, class: node.className, display: style.display,
          visibility: style.visibility, width: rect.width, height: rect.height });
      }
      return { url: location.href, ancestors, errors: window.__earlyErrors };
    });
    throw new Error(`Account control hidden: ${JSON.stringify(visibility)}`, { cause: error });
  }
}

async function verifyStyles(page) {
  const result = await page.evaluate(() => {
    const link = document.querySelector('link[data-app-style][href="/css/account.css"]');
    const dialog = document.getElementById('accountDialog');
    const rect = dialog.getBoundingClientRect();
    return { lazyLoaded: !!link?.sheet, radius: getComputedStyle(dialog).borderRadius,
      overlayRadius: getComputedStyle(dialog).getPropertyValue('--overlay-radius').trim(),
      buttonRadius: getComputedStyle(document.getElementById('accountMenuBtn')).borderRadius,
      left: rect.left, right: rect.right, width: innerWidth };
  });
  assert.equal(result.lazyLoaded, true, 'Account styles must be part of the actual lazy loader');
  assert.ok(result.overlayRadius, 'Shared overlay radius must be available');
  assert.equal(result.radius, result.overlayRadius, 'Dialog must use the shared overlay styling');
  assert.equal(result.buttonRadius, '8px');
  assert.ok(result.left >= 0 && result.right <= result.width + 1, 'Dialog must stay within viewport');
}

async function openPremiumMeasurements(page) {
  const detailed = page.locator('#reportDetailed');
  const evidence = detailed.locator('details.report-evidence').filter({ hasText: 'Fixture account detail' });
  const metric = page.getByText('Fixture account detail', { exact: true });
  await detailed.waitFor({ state: 'visible' });
  await metric.waitFor({ state: 'attached' });
  assert.equal(await detailed.getByText('Measurement guidance', { exact: true }).isVisible(), true,
    'Premium guidance must be available before opening the measurements');
  assert.equal(await evidence.evaluate(node => node.open), false, 'Measurements start in a collapsed disclosure');
  assert.equal(await metric.isVisible(), false, 'Collapsed measurements must not be mistaken for failed Premium access');
  await evidence.locator('summary').click();
  await metric.waitFor({ state: 'visible' });
  assert.equal(await evidence.evaluate(node => node.open), true);
}

async function rememberMeFlow(browser) {
  const env = await createPage(browser, { configured: true }); const { page } = env;
  try {
    await page.goto(`${BASE}/app`); await ready(page);
    await page.locator('#accountMenuBtn').click();
    const remember = page.getByRole('checkbox', { name: 'Keep me signed in on this device', exact: true });
    await remember.waitFor();
    assert.equal(await remember.isChecked(), false);
    await remember.check();
    await page.keyboard.press('Escape');
    await page.locator('#accountMenuBtn').click();
    assert.equal(await remember.isChecked(), false, 'Closing sign-in resets the unsubmitted preference');
    for (const choice of [true, false]) {
      await page.setViewportSize({ width: choice ? 1280 : 390, height: 900 });
      await remember.setChecked(choice);
      await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.refresh());
      assert.equal(await remember.isChecked(), choice, 'An account refresh preserves the visible choice');
      await verifyStyles(page);
      await page.getByRole('button', { name: 'Continue with Google (test fixture)', exact: true }).click();
      const logout = page.getByRole('button', { name: 'Sign out', exact: true });
      await logout.waitFor();
      assert.equal(env.signInChoices.at(-1), choice);
      await logout.click(); await remember.waitFor();
      assert.equal(await remember.isChecked(), false, 'Signing out never preselects a persistent login');
    }
    assert.deepEqual(env.pageErrors, []); assert.deepEqual(env.consoleErrors, []);
    console.log('PASS remember-me: explicit opt-in, default session, refresh, dismissal, logout, desktop and mobile');
  } finally { await env.context.close(); }
}

async function guestFlow(browser) {
  const env = await createPage(browser); const { page } = env;
  try {
    await page.goto(`${BASE}/#app`); await ready(page);
    assert.equal(await page.locator('#accountMenuBtn').innerText(), 'Sign in');
    await page.evaluate(async reports => {
      const bus = (await import('/js/modules/EventBus.js')).default;
      const { EVENTS } = await import('/js/modules/constants.js');
      reports.forEach(value => bus.emit(EVENTS.DIAGNOSTIC_REPORT_READY, value));
    }, [before, after]);
    await page.evaluate(async () => (await import('/js/ui/ReportPanelUI.js')).default.open());
    assert.equal(await page.locator('#reportHistoryBtn').isVisible(), false);
    assert.equal(await page.locator('#comparePreviousBtn').isVisible(), false);
    await page.getByRole('button', { name: 'Close report', exact: true }).click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator('#accountMenuBtn').click();
      assert.equal(await page.locator('#accountDialogTitle').innerText(), 'Sign in');
      assert.equal(await page.locator('.account-history').isVisible(), false);
      assert.equal(await page.locator('#accountHistoryList .account-report').count(), 0);
      assert.equal(await page.evaluate(() => localStorage.getItem('micprobe:report-history:v1')), null);
      await verifyStyles(page);
      await page.keyboard.press('Escape');
    }
    await page.reload(); await ready(page);
    assert.equal(await page.locator('#accountMenuBtn').innerText(), 'Sign in');
    assert.deepEqual(env.mutations, []);
    assert.equal(env.accountRequests.some(request => request.path.includes('/reports')), false);
    assert.deepEqual(env.pageErrors, []); assert.deepEqual(env.consoleErrors, []);
    console.log('PASS signed-out tests show their current result without history storage or account writes');
  } finally { await env.context.close(); }
}

async function historyFlow(browser) {
  const env = await createPage(browser, { signedIn: true, comparisonReports: true }); const { page } = env;
  env.setPremiumUnlocked(false);
  try {
    await page.goto(`${BASE}/#app`); await ready(page);
    assert.equal(await page.locator('#accountMenuBtn').innerText(), 'Account');
    await page.locator('#accountMenuBtn').click();
    await page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
    const dialog = page.locator('#accountDialog');
    await verifyStyles(page);
    assert.equal(await dialog.evaluate(node => node.open), true);
    const cards = page.locator('#accountHistoryList .account-report');
    assert.equal(await cards.count(), 2);
    assert.equal(await page.getByRole('button', { name: /Save browser history/ }).count(), 0);
    assert.match(await dialog.innerText(), /Audio recordings stay on your device/);

    const draft = '<img src=x onerror=alert(1)> Lowered gain';
    await cards.first().locator('.account-note > summary').click();
    await cards.first().getByRole('textbox').fill(draft);
    await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.refresh());
    assert.equal(await cards.first().getByRole('textbox').inputValue(), draft, 'Session refresh must preserve an unsaved note');
    await cards.first().getByRole('button', { name: 'Save note', exact: true }).click();
    await page.waitForFunction(expected => document.querySelector('#accountHistoryList input[type="text"]')?.value === expected, draft);
    assert.equal(await page.locator('#accountHistoryList img').count(), 0, 'A report note must never become HTML');
    await page.reload(); await ready(page); await page.locator('#accountMenuBtn').click();
    await page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
    assert.equal(await cards.count(), 2);
    assert.equal(await cards.first().locator('.account-note').evaluate(node => node.open), false, 'Saved notes start compact after reload');
    await cards.first().locator('.account-note > summary').click();
    assert.equal(await cards.first().getByRole('textbox').inputValue(), draft);
    assert.equal(await cards.getByRole('checkbox').count(), 0, 'Archived reports are independent');
    const backgroundAcceptsFocus = await page.evaluate(() => {
      const background = document.getElementById('accountMenuBtn'); background.focus();
      return document.activeElement === background;
    });
    assert.equal(backgroundAcceptsFocus, false, 'Native modal must make background controls inert');
    await dialog.getByRole('button', { name: 'Close account', exact: true }).focus();
    let browserChromeFocusStops = 0;
    for (let index = 0; index < 20; index++) {
      const previous = await page.evaluate(() => ({ tag: document.activeElement?.tagName, id: document.activeElement?.id, text: document.activeElement?.textContent?.slice(0, 45) }));
      await page.keyboard.press('Tab');
      const focus = await dialog.evaluate(node => ({ inside: node.contains(document.activeElement), modal: node.matches(':modal'),
        tag: document.activeElement?.tagName, id: document.activeElement?.id, pageFocused: document.hasFocus() }));
      // Chrome may visit its own UI after the last button: activeElement becomes
      // BODY while document.hasFocus() is false. That is not background app focus.
      const inBrowserChrome = focus.modal && focus.tag === 'BODY' && !focus.pageFocused;
      if (inBrowserChrome) browserChromeFocusStops++;
      assert.ok(focus.inside || inBrowserChrome, `Native dialog focus: ${JSON.stringify({ index, previous, ...focus })}`);
    }
    await page.keyboard.press('Escape'); assert.equal(await dialog.evaluate(node => node.open), false);
    await page.locator('#accountMenuBtn').click();
    await page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
    await cards.nth(1).getByRole('button', { name: 'Open report', exact: true }).click();
    const openedId = await page.evaluate(async () => (await import('/js/ui/ReportPanelUI.js')).default.currentReport.run.id);
    assert.equal(openedId, before.run.id, 'History must restore the selected snapshot identity');
    await page.locator('#reportHistoryBtn').click();
    assert.equal(await cards.count(), 2, 'Opening a saved report must not create another history record');
    await page.setViewportSize({ width: 390, height: 844 });
    await verifyStyles(page);
    const layout = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
      dialog: document.getElementById('accountDialog').clientWidth, dialogScroll: document.getElementById('accountDialog').scrollWidth }));
    assert.ok(layout.document <= layout.width + 1, `Mobile page overflow: ${JSON.stringify(layout)}`);
    assert.ok(layout.dialogScroll <= layout.dialog + 1, `Mobile dialog overflow: ${JSON.stringify(layout)}`);
    await cards.first().getByRole('button', { name: 'Delete', exact: true }).click();
    await cards.first().getByRole('button', { name: 'Delete report', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#accountHistoryList .account-report').length === 1);
    assert.equal(await page.getByRole('button', { name: /^Compare selected/ }).count(), 0,
      'Comparison needs at least two reports');
    assert.equal(await cards.getByRole('checkbox').count(), 0, 'A single report has no comparison control');
    assert.equal(await page.locator('#accountComparison').count(), 0);
    assert.equal(await page.evaluate(() => window.__accountTestMicRequests), 0);
    assert.ok(env.mutations.some(path => path.includes('/reports/')), 'Signed-in notes and deletion must reach the account');
    assert.deepEqual(env.pageErrors, []); assert.deepEqual(env.consoleErrors, []);
    console.log(JSON.stringify({ test: 'account-history-browser', status: 'passed', reports: 2, lazyCss: true,
      persistedNote: true, draftSurvivesRefresh: true, independentReports: true, deletion: true,
      nativeFocus: true, browserChromeFocusStops, mobile: '390x844', pageErrors: 0, consoleErrors: 0 }));
  } finally { await env.context.close(); }
}

async function logoutFlow(browser) {
  const env = await createPage(browser, { signedIn: true }); const { page } = env;
  try {
    await page.goto(`${BASE}/#app`); await ready(page); await page.locator('#accountMenuBtn').click();
    await page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
    const cards = page.locator('#accountHistoryList .account-report');
    await cards.first().waitFor(); assert.equal(await cards.count(), 1);
    assert.match(await cards.first().innerText(), /Private account report/);
    const draft = 'Moved microphone closer';
    await cards.first().locator('.account-note > summary').click();
    await cards.first().getByRole('textbox').fill(draft);
    env.setSessionUnavailable(true);
    await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.refresh());
    assert.equal(await page.getByRole('button', { name: 'Get Lifetime Premium', exact: true }).count(), 0,
      'An unverified account connection must not suggest buying again');
    await page.getByRole('tab', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: 'Retry account connection', exact: true }).waitFor();
    env.setSessionUnavailable(false);
    await page.getByRole('button', { name: 'Retry account connection', exact: true }).click();
    await page.getByRole('button', { name: 'Manage purchase', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
    assert.equal(await cards.first().getByRole('textbox').inputValue(), draft, 'Account navigation and recovery preserve the report note');
    env.setReportWritesUnavailable(true);
    const failedSave = page.waitForResponse(response => response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === '/api/account/reports/00000000-0000-4000-8000-000000000099');
    await cards.first().getByRole('button', { name: 'Save note', exact: true }).click();
    assert.equal((await failedSave).status(), 503);
    await page.waitForFunction(() => /unavailable|try again|could not/i.test(document.getElementById('accountStatus').textContent));
    assert.equal(await cards.first().getByRole('textbox').inputValue(), draft);
    env.setReportWritesUnavailable(false);
    await cards.first().getByRole('button', { name: 'Save note', exact: true }).click();
    await cards.first().locator('.account-saved-note').getByText(draft, { exact: true }).waitFor();
    assert.equal(await cards.first().locator('.account-saved-note').innerText(), draft);
    await cards.first().getByRole('button', { name: 'Open report', exact: true }).click();
    await openPremiumMeasurements(page);
    await page.locator('#reportHistoryBtn').click();
    await page.getByRole('tab', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('accountMenuBtn').textContent === 'Sign in');
    assert.equal(await page.locator('.account-history').isVisible(), false);
    assert.equal(await cards.count(), 0);
    const state = await page.evaluate(async () => {
      const premium = (await import('/js/modules/PremiumAccess.js')).default;
      const panel = (await import('/js/ui/ReportPanelUI.js')).default;
      return { unlocked: premium.isUnlocked(), currentReport: panel.currentReport, detailed: panel._lastDetailed,
        microphoneRequests: window.__accountTestMicRequests };
    });
    assert.equal(state.unlocked, false, 'Legacy token must not unlock a signed-out account deployment');
    assert.equal(state.currentReport, null); assert.equal(state.detailed, null); assert.equal(state.microphoneRequests, 0);
    assert.deepEqual(env.mutations, ['/api/account/reports/00000000-0000-4000-8000-000000000099', '/api/account/reports/00000000-0000-4000-8000-000000000099', '/api/account/logout']);
    assert.deepEqual(env.pageErrors, []);
    // Engines differ in whether failed HTTP responses produce console errors.
    // The response and recovery are verified above; unrelated errors still fail.
    for (const error of env.consoleErrors) {
      assert.match(error, /503.*\/api\/account\/reports\/00000000-0000-4000-8000-000000000099/);
    }
    console.log(JSON.stringify({ test: 'account-logout-browser', status: 'passed', privateHistoryHidden: true,
      legacyTokenSuppressed: true, displayedReportCleared: true, connectionRecovery: true,
      pendingNoteRetry: true, realGoogleSignIn: false, pageErrors: 0, consoleErrors: 0 }));
  } finally { await env.context.close(); }
}

async function historyAccessFlow(browser) {
  const env = await createPage(browser, { signedIn: true, comparisonReports: true }); const { page } = env;
  try {
    await page.goto(`${BASE}/app`); await ready(page); await page.locator('#accountMenuBtn').click();
    await page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
    const cards = page.locator('#accountHistoryList .account-report');
    await cards.nth(1).waitFor();
    assert.equal(await cards.getByRole('checkbox').count(), 0);
    const draft = 'Keep this unsaved note';
    await cards.first().locator('.account-note > summary').click();
    await cards.first().getByRole('textbox').fill(draft);
    for (const premium of [false, true]) {
      env.setPremiumUnlocked(premium);
      await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.refresh());
      await cards.nth(1).waitFor();
      assert.equal(await cards.first().getByRole('textbox').inputValue(), draft);
      assert.equal(await page.evaluate(async () => (await import('/js/modules/PremiumAccess.js')).default.isUnlocked()), premium);
    }
    await page.getByRole('tab', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('accountMenuBtn').textContent === 'Sign in');
    assert.equal(await cards.count(), 0);
    assert.equal(await page.evaluate(() => window.__accountTestMicRequests), 0);
    assert.deepEqual(env.pageErrors, []); assert.deepEqual(env.consoleErrors, []);
    console.log('PASS archive retained on Premium loss, notes preserved, logout clears private data');
  } finally { await env.context.close(); }
}

async function firstPurchaseFlow(browser) {
  const env = await createPage(browser, { configured: true }); const { page } = env;
  const purchaseReport = { ...before, audioMetrics: after.audioMetrics };
  try {
    await page.goto(`${BASE}/#app`); await ready(page);
    await page.evaluate(async value => {
      const bus = (await import('/js/modules/EventBus.js')).default;
      const { EVENTS } = await import('/js/modules/constants.js');
      bus.emit(EVENTS.DIAGNOSTIC_REPORT_READY, value);
    }, purchaseReport);
    await page.evaluate(async () => (await import('/js/ui/ReportPanelUI.js')).default.open());
    await page.locator('#premiumCta').click();
    await page.getByRole('button', { name: 'Continue with Google (test fixture)', exact: true }).click();
    await page.waitForURL('https://checkout.freemius.com/**');
    const snapshot = env.checkoutSnapshot();
    assert.equal(snapshot?.ownerId, 'fixture-account-A', 'First sign-in must bind the checkout snapshot to its account');
    assert.equal(snapshot?.report.run.id, before.run.id, 'Guest report must survive first sign-in and checkout');
    await page.locator('#returnFromCheckout').click(); await ready(page);
    await openPremiumMeasurements(page);
    const restored = await page.evaluate(async () => ({ unlocked: (await import('/js/modules/PremiumAccess.js')).default.isUnlocked(),
      runId: (await import('/js/ui/ReportPanelUI.js')).default.currentReport?.run.id }));
    assert.deepEqual(restored, { unlocked: true, runId: before.run.id });
    assert.equal(await page.evaluate(() => sessionStorage.getItem('micprobe:checkout-snapshot:v1')), null);
    assert.equal(await page.evaluate(() => window.__accountTestMicRequests), 0);
    assert.deepEqual(env.mutations, ['/api/account/google', '/api/account/checkout', '/api/account/purchase'], 'Restoring checkout must not upload the snapshot as a new account report');
    assert.deepEqual(env.pageErrors, []); assert.deepEqual(env.consoleErrors, []);
    console.log(JSON.stringify({ test: 'account-first-purchase-browser', status: 'passed', guestReportPreserved: true,
      checkoutOwnerBound: true, originalReportRestored: true, realGoogleSignIn: false, realPayment: false, pageErrors: 0, consoleErrors: 0 }));
  } finally { await env.context.close(); }
}

async function emptyHistoryRecoveryFlow(browser) {
  const env = await createPage(browser, { signedIn: true }); const { page } = env;
  env.clearReports(); env.setHistoryUnavailable(true);
  try {
    await page.goto(`${BASE}/app`); await ready(page);
    await page.locator('#accountMenuBtn').click();
    const section = page.locator('.account-history');
    await page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
    await section.getByText(/Saved reports could not be loaded/).waitFor();
    assert.doesNotMatch(await section.innerText(), /No reports yet|first test report/);
    assert.equal(await section.getByRole('button', { name: /Compare selected/ }).count(), 0);
    env.setHistoryUnavailable(false);
    await section.getByRole('button', { name: 'Try again', exact: true }).click();
    await section.getByText('No saved reports yet', { exact: false }).waitFor();
    assert.doesNotMatch(await section.innerText(), /Saved reports could not be loaded|Waiting to sync/);
    assert.equal(await section.getByRole('button', { name: 'Refresh reports', exact: true }).count(), 0);
    await section.getByRole('button', { name: 'Back to test', exact: true }).click();
    assert.equal(await page.locator('#accountDialog').evaluate(e => e.open), false);
    assert.equal(await page.evaluate(() => window.__accountTestMicRequests), 0);
    console.log(JSON.stringify({ test: 'empty-history-recovery', status: 'passed' }));
  } finally { await env.context.close(); }
}

async function pendingPurchaseFlow(browser) {
  const env = await createPage(browser, { signedIn: true, purchasePending: true }); const { page } = env;
  try {
    await page.goto(`${BASE}/app`); await ready(page); await page.locator('#accountMenuBtn').click();
    const identity = page.locator('#accountIdentity');
    assert.match(await identity.innerText(), /Purchase verification pending/);
    assert.doesNotMatch(await identity.innerText(), /Free account|Get Lifetime Premium|Link an earlier purchase/);
    env.setSessionUnavailable(true);
    const firstRetry = env.accountRequests.length;
    await identity.getByRole('button', { name: 'Retry purchase verification', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('accountStatus').textContent !== 'Working…');
    assert.deepEqual(env.accountRequests.slice(firstRetry), [{ path: '/api/account/session', method: 'GET' }]);
    assert.match(await identity.innerText(), /Purchase verification pending/);
    env.setSessionUnavailable(false);
    await page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
    await page.locator('#accountHistoryList').getByRole('button', { name: 'Open report', exact: true }).click();
    const cta = page.locator('#premiumCta');
    assert.equal(await cta.innerText(), 'Retry purchase verification');
    assert.doesNotMatch(await page.locator('#premiumOverlay').innerText(), /Get Lifetime Premium|One payment/);
    const secondRetry = env.accountRequests.length;
    await cta.click();
    await page.waitForFunction(() => !document.getElementById('premiumCta').disabled);
    assert.deepEqual(env.accountRequests.slice(secondRetry), [{ path: '/api/account/session', method: 'GET' }]);
    assert.equal(await cta.innerText(), 'Retry purchase verification');
    assert.deepEqual(env.mutations, [], 'Pending purchase retries must not repeat checkout or purchase POSTs');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('micprobe:checkout-snapshot:v1')), null,
      'Verification retry must not create a new checkout snapshot');
    env.verifyPurchase();
    await cta.click();
    await openPremiumMeasurements(page);
    assert.deepEqual(env.mutations, [], 'Confirmed verification must not replay a pending signed return');
    assert.deepEqual(env.pageErrors, []); assert.deepEqual(env.consoleErrors, []);
    console.log(JSON.stringify({ test: 'account-pending-purchase-browser', status: 'passed', noRepeatPurchase: true,
      sessionOnlyRetries: true, pendingSurvivesConnectionFailure: true, verifiedReportUnlocked: true, pageErrors: 0, consoleErrors: 0 }));
  } finally { await env.context.close(); }
}

async function oneTapFlow(browser) {
  const env = await createPage(browser, { configured: true });
  const { page } = env;
  try {
    await page.goto(BASE);
    await page.locator('#hero-title').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.__googleFixture.loads), 0, 'Landing must not load Google');
    await page.evaluate(async () => (await import('/js/landing.js')).showAppView()); await ready(page);
    await page.locator('#googleOneTapFixture').waitFor();
    assert.deepEqual(env.signInChoices, [], 'Prompt display must never sign in automatically');
    await page.locator('#googleOneTapFixture').click();
    await page.getByRole('button', { name: 'Account', exact: true }).waitFor();
    assert.deepEqual(env.signInChoices, [false], 'One Tap must not opt into a persistent session');
    assert.equal(await page.locator('#accountDialog').evaluate(node => node.open), false, 'Success must not open a modal');
    await page.locator('#accountMenuBtn').click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('button', { name: 'Continue with Google (test fixture)', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#googleOneTapFixture').count(), 0);
    await page.reload(); await ready(page);
    assert.equal(await page.evaluate(() => window.__googleFixture.loads), 0, 'Reload after logout must not reopen One Tap');
    assert.equal(await page.evaluate(() => window.__accountTestMicRequests), 0);
    assert.deepEqual(env.pageErrors, []); assert.deepEqual(env.consoleErrors, []);
    console.log(JSON.stringify({ test: 'google-one-tap-browser', status: 'passed', landingLoadsGoogle: false,
      explicitCredential: true, rememberMe: false, logoutAndReloadSuppressed: true }));
  } finally { await env.context.close(); }

  const busy = await createPage(browser, { configured: true });
  try {
    await busy.page.goto(BASE + '/app'); await ready(busy.page);
    await busy.page.locator('#googleOneTapFixture').waitFor();
    await busy.page.evaluate(async () => {
      const state = await import('/js/app/AppState.js');
      const { default: eventBus } = await import('/js/modules/EventBus.js');
      const { EVENTS } = await import('/js/modules/constants.js');
      state.setIsPreparing(true); eventBus.emit(EVENTS.UI_STATE_CHANGED);
      await window.__googleFixture.lateCallback();
      state.setIsPreparing(false); eventBus.emit(EVENTS.UI_STATE_CHANGED);
    });
    assert.equal(await busy.page.locator('#googleOneTapFixture').count(), 0);
    assert.deepEqual(busy.signInChoices, [], 'Late Google credential during preparation must be ignored');
    await busy.page.locator('#accountMenuBtn').click();
    await busy.page.getByRole('button', { name: 'Continue with Google (test fixture)', exact: true }).waitFor();
    const beforeRefresh = await busy.page.evaluate(() => window.__googleFixture.initializations);
    await busy.page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.refresh({ sessionOnly: true }));
    assert.equal(await busy.page.evaluate(() => window.__googleFixture.initializations), beforeRefresh,
      'Routine session refresh must preserve the active consent callback');
    await busy.page.getByRole('button', { name: 'Continue with Google (test fixture)', exact: true }).click();
    await busy.page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    assert.deepEqual(busy.signInChoices, [false]);
    assert.deepEqual(busy.pageErrors, []); assert.deepEqual(busy.consoleErrors, []);
    console.log(JSON.stringify({ test: 'google-one-tap-cancellation-browser', status: 'passed',
      preparationCancels: true, staleCredentialIgnored: true, manualFallbackWorks: true, refreshPreservesConsent: true }));
  } finally { await busy.context.close(); }
}

async function signInRecoveryFlow(browser) {
  const env = await createPage(browser, { configured: true }); const { page } = env;
  try {
    await page.goto(`${BASE}/app`); await ready(page);
    await page.locator('#accountMenuBtn').click();
    const google = page.getByRole('button', { name: 'Continue with Google (test fixture)', exact: true });
    await google.waitFor();
    const retry = page.locator('#accountIdentity').getByRole('button', { name: 'Try again', exact: true });
    assert.equal(await retry.isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Load Google sign-in', exact: true }).count(), 0);
    await page.route('**/api/account/google', route => route.fulfill({ status: 503,
      json: { ok: false, error: 'google_temporarily_unavailable' } }));
    await google.click(); await retry.waitFor();
    assert.match(await page.locator('#accountStatus').innerText(), /temporarily unavailable/);
    assert.equal(await google.count(), 0);
    await page.unroute('**/api/account/google');
    await retry.click(); await google.waitFor();
    assert.equal(await retry.isVisible(), false);
    await google.click();
    await page.waitForFunction(() => document.getElementById('accountMenuBtn').textContent === 'Account');
    assert.deepEqual(env.pageErrors, []);
    console.log(JSON.stringify({ test: 'sign-in-recovery-browser', status: 'passed', singleButton: true, providerRetry: true }));
  } finally { await env.context.close(); }
}

async function accountNavigationFlow(browser) {
  const env = await createPage(browser, { signedIn: true, comparisonReports: true,
    userName: 'Alexandra A very long account display name that must wrap on phones',
    userEmail: `${'long-address-'.repeat(12)}@example.test` });
  const { page } = env;
  try {
    await page.goto(`${BASE}/app`); await ready(page); await page.locator('#accountMenuBtn').click();
    const account = page.getByRole('tab', { name: 'Account', exact: true });
    const reports = page.getByRole('tab', { name: 'Saved reports', exact: true });
    assert.equal(await account.getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#accountReports').isVisible(), false);
    assert.match(await page.locator('#accountIdentity').innerText(), /Signed in with Google/);
    await account.press('ArrowRight');
    assert.equal(await reports.getAttribute('aria-selected'), 'true');
    assert.equal(await reports.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('#accountIdentity').isVisible(), false);
    const card = page.locator('.account-report').first();
    await card.locator('.account-note > summary').click();
    await card.getByRole('textbox').fill('Keep this note while switching account sections');
    assert.equal(await card.getByRole('checkbox').count(), 0);
    await reports.press('Home');
    assert.equal(await account.getAttribute('aria-selected'), 'true');
    await page.getByText('Account data and deletion', { exact: true }).click();
    assert.equal(await page.getByRole('link', { name: 'Email an account request' }).getAttribute('href'),
      'mailto:support@micprobe.com?subject=MicProbe%20account%20data%20request');
    assert.equal(await page.getByRole('button', { name: /delete account/i }).count(), 0, 'A support request is not an immediate account deletion');
    await account.press('End');
    assert.equal(await card.getByRole('textbox').inputValue(), 'Keep this note while switching account sections');
    assert.equal(await card.getByRole('checkbox').count(), 0);
    await card.getByRole('button', { name: 'Delete', exact: true }).click();
    assert.equal(await card.getByRole('button', { name: 'Keep', exact: true }).evaluate(node => node === document.activeElement), true);
    await card.getByRole('button', { name: 'Keep', exact: true }).click();
    assert.equal(await card.getByRole('button', { name: 'Delete', exact: true }).evaluate(node => node === document.activeElement), true);
    for (const [width, height] of [[1280, 900], [768, 1024], [390, 844], [320, 600], [844, 390]]) {
      await page.setViewportSize({ width, height });
      for (const tab of [account, reports]) {
        await tab.click();
        const bounds = await page.locator('#accountDialog').evaluate(dialog => {
          const body = dialog.querySelector('.account-dialog-body');
          const tabs = dialog.querySelector('.account-tabs').getBoundingClientRect();
          const close = dialog.querySelector('[data-close-account]').getBoundingClientRect();
          const rect = dialog.getBoundingClientRect();
          return { fits: rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1,
            overflow: body.scrollWidth > body.clientWidth + 1, readingHeight: body.clientHeight,
            controls: close.top >= 0 && close.bottom <= innerHeight && tabs.bottom <= innerHeight };
        });
        assert.ok(bounds.fits && !bounds.overflow && bounds.controls && bounds.readingHeight >= 150,
          `${width}x${height}: ${JSON.stringify(bounds)}`);
        const top = await page.locator('.account-tabs').evaluate(node => node.getBoundingClientRect().top);
        await page.locator('#accountDialog .account-dialog-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
        assert.equal(await page.locator('.account-tabs').evaluate(node => node.getBoundingClientRect().top), top);
      }
    }
    assert.doesNotMatch(await page.locator('#accountDialog').innerText(), /history/i);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('accountDialog').open
      && document.activeElement === document.getElementById('accountMenuBtn'), null, { timeout: 5000 });
    assert.equal(await page.locator('#accountMenuBtn').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.__accountTestMicRequests), 0);
    assert.deepEqual(env.pageErrors, []); assert.deepEqual(env.consoleErrors, []);
    console.log(JSON.stringify({ test: 'account-navigation-browser', status: 'passed', keyboardTabs: true,
      preservedDraft: true, longIdentity: true, mobileAndLandscape: true, cancelDeleteFocus: true }));
  } finally { await env.context.close(); }
}

async function main() {
  const selected = process.argv.includes('--all-browsers') ? ['chrome', 'firefox', 'webkit']
    : [process.argv.find(arg => arg.startsWith('--browser='))?.split('=')[1] || 'chrome'];
  for (const name of selected) {
    assert.ok(['chrome', 'firefox', 'webkit'].includes(name), 'Select chrome, firefox or webkit');
    const browser = await ({ chrome: chromium, firefox, webkit })[name].launch({ ...(name === 'chrome' ? { channel: 'chrome' } : {}), headless: true });
    try {
      await accountNavigationFlow(browser);
      await signInRecoveryFlow(browser); await oneTapFlow(browser); await rememberMeFlow(browser);
      await guestFlow(browser); await historyFlow(browser); await logoutFlow(browser);
      await emptyHistoryRecoveryFlow(browser);
      await historyAccessFlow(browser); await firstPurchaseFlow(browser); await pendingPurchaseFlow(browser);
      await require('./account-portal-browser-runner.cjs').runPortalFlows(browser);
      await require('./account-checkout-browser-runner.cjs').runCheckoutFlows(browser);
      console.log(JSON.stringify({ browser: name, status: 'passed', realGoogleSignIn: false }));
    } finally { await browser.close(); }
  }
}

module.exports = { createPage, ready };
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ status: 'failed', error: error.stack })); process.exitCode = 1; });
