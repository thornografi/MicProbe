// Requires localhost:8080, Playwright and Chrome. Uses a fake microphone and a fixture account.
const { chromium } = require('playwright');
const { selectScenario } = require('./scenario-browser-helpers.cjs');
const assert = require('node:assert/strict');
const BASE = 'http://localhost:8080';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.__reportTracks = [];
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await capture(constraints);
        window.__reportTracks.push(...stream.getTracks());
        return stream;
      };
    });
    const page = await context.newPage();
    await require('./scenario-browser-helpers.cjs').allowTestAccess(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.origin !== BASE, route => route.fulfill({ status: 200, body: '' }));
    await page.route('**/api/account/config', route => route.fulfill({ json: { ok: true, configured: true } }));
    await page.route('**/api/account/session', route => route.fulfill({ json: { ok: true, user: { id: 'report-fixture-account' }, premium: { unlocked: true } } }));
    const savedReports = new Map();
    await page.route('**/api/account/reports', route => {
      const request = route.request();
      assert.equal(request.headers()['x-micprobe-account'], 'report-fixture-account');
      if (request.method() === 'GET') return route.fulfill({ json: { ok: true, reports: [...savedReports.values()] } });
      const body = request.postDataJSON();
      const entry = { id: body.report.run.id, ...body, createdAt: body.report.generatedAt };
      savedReports.set(entry.id, entry);
      return route.fulfill({ json: { ok: true, report: entry } });
    });
    await page.route('**/api/freemius/config', route => route.fulfill({ json: { configured: false, mode: 'sandbox' } }));
    await page.route('**/api/report/detailed', route => route.fulfill({ json: { ok: true, detailed: { metrics: [], recommendations: [] } } }));
    await page.route('**/api/reviews/assess', route => route.fulfill({ json: { ok: true } }));
    await page.goto(`${BASE}/#app`);
    await page.waitForFunction(() => document.body.classList.contains('app-mode'));
    await page.locator('#scenarioChoices [data-profile="discord"]').click();
    await page.locator('#testBtn').waitFor({ state: 'visible' });
    await page.evaluate(async () => {
      const bus = (await import('/js/modules/EventBus.js')).default;
      const { EVENTS } = await import('/js/modules/constants.js');
      window.__reportResults = []; window.__reportStarts = [];
      bus.on(EVENTS.DIAGNOSTIC_REPORT_READY, report => window.__reportResults.push(report));
      bus.on(EVENTS.TEST_RECORDING_STARTED, data => window.__reportStarts.push(data));
    });
    await page.locator('#testBtn').click();
    await page.waitForFunction(() => window.__reportResults.length === 1, null, { timeout: 20000 });
    assert.equal(await page.locator('#reportPanel').evaluate(node => node.open), false);
    await page.locator('#inlineResult').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#inlineResult').isVisible(), true);
    assert.equal(await page.locator('#comparePreviousBtn').isVisible(), false);
    const firstId = await page.evaluate(async () => {
      (await import('/js/ui/ReportPanelUI.js')).default.close();
      return window.__reportResults[0].run.id;
    });
    await page.locator('#showReportBtn').click();
    assert.equal(await page.locator('#reportSetupBtn').innerText(), 'Back to test');
    assert.equal(await page.locator('#inlineResultNextStep').isVisible(), true);
    assert.equal(await page.locator('.report-next-step p').innerText(), await page.locator('#inlineResultNextStep').innerText());
    assert.equal(await page.locator('#reportRetestBtn').isVisible(), true);
    await page.locator('#reportSetupBtn').click();
    assert.equal(await page.locator('#customSettingsToggle').getAttribute('aria-expanded'), 'false', 'Returning to the test must not promote advanced settings');
    assert.equal(await page.locator('#reportPanel').evaluate(node => node.open), false);
    assert.equal(await page.locator('#resultCard').getAttribute('data-run-id'), firstId);
    assert.equal(await page.evaluate(() => window.__reportStarts.length), 1, 'Returning to the test must not capture');
    await page.locator('#customSettingsToggle').click();
    await page.locator('#custom-setting-bitrate').selectOption('96000');
    await page.locator('#showReportBtn').click();
    await page.locator('#reportRetestBtn').click();
    await page.waitForFunction(() => window.__reportStarts.length === 2, null, { timeout: 10000 });
    assert.equal(await page.locator('#accountMenuBtn').isDisabled(), true, 'History menu is locked during capture');
    assert.equal(await page.locator('#changeScenarioBtn').isDisabled(), true, 'Scenario navigation is locked during capture');
    await page.locator('#changeScenarioBtn').dispatchEvent('click');
    assert.equal(await page.locator('#scenarioWorkspace').isVisible(), true, 'Programmatic navigation cannot interrupt capture');
    assert(await page.locator('#scenarioChoices button').evaluateAll(nodes => nodes.every(node => node.disabled)), 'Sidebar choices are locked during capture');
    await page.evaluate(async () => (await import('/js/ui/ProfileUIManager.js')).default.handleProfileSelect('raw'));
    assert.equal(await page.locator('.nav-item[aria-current]').getAttribute('data-profile'), 'discord');
    // Bypass the native menu lock to exercise the saved-report action's independent ownership guard.
    await page.locator('#accountMenuBtn').dispatchEvent('click');
    await page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
    const open = page.getByRole('button', { name: 'Open report', exact: true });
    assert.equal(await open.isDisabled(), true, 'Saved reports stay locked when the dialog is opened programmatically');
    // Dispatching bypasses the native disabled check; the action must still reject it.
    await open.dispatchEvent('click');
    assert.match(await page.locator('#accountStatus').innerText(), /analysis to finish/);
    assert.equal(await page.locator('#accountDialog').evaluate(node => node.open), true);
    await page.locator('#accountDialog [data-close-account]').click();
    await page.waitForFunction(() => window.__reportResults.length === 2, null, { timeout: 20000 });
    const state = await page.evaluate(async () => ({
      newRun: window.__reportStarts[1].runSnapshot.runId,
      requestedBitrate: window.__reportStarts[1].runSnapshot.requestedSettings.bitrate,
      report: window.__reportResults[1],
      shownId: (await import('/js/ui/ReportPanelUI.js')).default.currentReport.run.id,
      pending: (await import('/js/modules/DiagnosticReportBuilder.js')).default.isReportPending(),
      liveTracks: window.__reportTracks.filter(track => track.readyState !== 'ended').length
    }));
    assert.notEqual(state.newRun, firstId);
    assert.equal(state.requestedBitrate, 96000, 'Retest uses the edited settings, not the previous report snapshot');
    assert.equal(state.report.run.id, state.newRun);
    assert.equal(state.shownId, state.newRun);
    assert.equal(state.report.audioMetrics.status, 'measured');
    assert.equal(state.pending, false);
    assert.equal(state.liveTracks, 0);
    assert.deepEqual(errors, []);
    console.log('PASS: actual Call, history keyboard/programmatic busy guards, next run publication and microphone cleanup');
    assert.equal(await page.locator('#comparePreviousBtn').count(), 0);
    assert.equal(savedReports.size, 2, 'Each completed Premium test is archived independently');
    console.log('PASS: direct retest creates an independent Premium report');

    // Permission failures do not publish another history row. An already open
    // dialog must release its busy lock without rebuilding unsaved note inputs.
    for (const [profile, startButton] of [['discord', '#testBtn'], ['raw', '#recordToggle']]) {
      await page.evaluate(async () => (await import('/js/ui/ReportPanelUI.js')).default.close());
      await selectScenario(page, profile);
      await page.evaluate(() => {
        window.__rejectHistoryCapture = null;
        navigator.mediaDevices.getUserMedia = () => new Promise((_resolve, reject) => {
          window.__rejectHistoryCapture = () => reject(new DOMException('Permission denied', 'NotAllowedError'));
        });
      });
      await page.locator(startButton).click();
      await page.waitForFunction(() => typeof window.__rejectHistoryCapture === 'function');
      assert.equal(await page.locator('#accountMenuBtn').isDisabled(), true);
      assert.equal(await page.locator('#changeScenarioBtn').isDisabled(), true);
      await page.locator('#accountMenuBtn').dispatchEvent('click');
      await page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
      const card = page.locator('#accountHistoryList .account-report').last();
      const openSaved = card.getByRole('button', { name: 'Open report', exact: true });
      assert.equal(await openSaved.isDisabled(), true);
      const draft = `Unsaved note during ${profile} permission prompt`;
      if (!await card.locator('.account-note').evaluate(node => node.open)) await card.locator('.account-note > summary').click();
      await card.getByRole('textbox').fill(draft);
      await page.evaluate(() => window.__rejectHistoryCapture());
      await page.waitForFunction(async () => {
        const state = await import('/js/app/AppState.js');
        return !state.getIsPreparing() && !state.getCurrentMode();
      });
      assert.equal(await openSaved.isDisabled(), false, `${profile}: history must unlock after permission failure`);
      assert.equal(await page.locator('#changeScenarioBtn').isDisabled(), false, `${profile}: scenario navigation recovers after permission failure`);
      assert.equal(await card.getByRole('textbox').inputValue(), draft, 'Releasing the busy lock must retain an unsaved note');
      await openSaved.click();
      assert.equal(await page.locator('#accountDialog').evaluate(node => node.open), false);
      assert.equal(await page.evaluate(async () => (await import('/js/ui/ReportPanelUI.js')).default.currentReport.run.id), firstId);
      assert.equal(await page.locator('#reportRetestBtn').isVisible(), false, 'An older report cannot retest the current settings');
      assert.equal(await page.locator('#reportSetupBtn').innerText(), 'Back to test');
      assert.equal(await page.evaluate(() => window.__reportResults.length), 3 + (profile === 'raw' ? 1 : 0));
    }
    assert.deepEqual(errors, []);
    console.log('PASS: Call and Record permission failure unlocks the open history dialog and preserves unsaved notes');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
