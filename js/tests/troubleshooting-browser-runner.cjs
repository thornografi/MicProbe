// Automatic recommendations: local UI + real evaluator, fixture audio/account transport.
// Requires localhost:8080, Playwright and Chrome; no physical microphone or OS settings.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { evaluatePremiumReport } = require('../../server/premium-report-evaluator.js');
const BASE = 'http://localhost:8080';

async function setup(browser, premium) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    window.__guideMicRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      window.__guideMicRequests++;
      throw new Error('Fixture report test must never request microphone audio');
    };
  });
  const page = await context.newPage();
  await require('./scenario-browser-helpers.cjs').allowTestAccess(page);
  page.setDefaultTimeout(15000);
  const errors = [], requests = [], downloads = [];
  let failuresRemaining = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('download', download => downloads.push(download));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.route(url => url.origin !== BASE, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('**/api/freemius/config', route => route.fulfill({ json: { configured: false, mode: 'sandbox' } }));
  await page.route('**/api/account/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    let payload;
    if (pathname.endsWith('/config')) payload = { ok: true, configured: true, googleClientId: null };
    else if (pathname.endsWith('/session')) payload = { ok: true, user: { id: 'guide-fixture-account' }, premium: { unlocked: premium, mode: 'sandbox' } };
    else if (pathname.endsWith('/reports') && request.method() === 'GET') payload = { ok: true, reports: [], nextCursor: null };
    else if (pathname.endsWith('/reports') && request.method() === 'POST') {
      const { report, note } = request.postDataJSON();
      payload = { ok: true, report: { id: report.run.id, report, note, createdAt: report.generatedAt } };
    } else throw new Error(`Unexpected fixture route: ${request.method()} ${pathname}`);
    await route.fulfill({ json: payload });
  });
  await page.route('**/api/report/detailed', async route => {
    assert.equal(premium, true, 'Locked clients must not request private recommendations');
    const report = route.request().postDataJSON().report;
    requests.push(report);
    if (failuresRemaining > 0) {
      failuresRemaining--;
      await route.fulfill({ status: 503, json: { ok: false, error: 'temporary_failure' } });
      return;
    }
    await route.fulfill({ json: { ok: true, detailed: evaluatePremiumReport(report) } });
  });
  // This runner covers the preserved rule-detail path. The separate review
  // runner exercises explicit review creation against the shared service.
  await page.route('**/api/reviews/**', route => route.fulfill({ json: { ok: true, review: null,
    decision: { status: 'SUMMARY', eligible: false, title: 'Recording measurements are available.' } } }));
  await page.goto(BASE);
  await page.locator('#heroLaunchBtn').click();
  await page.waitForFunction(() => document.body.classList.contains('app-mode'));
  await page.locator('#scenarioChoices [data-profile="discord"]').click();
  assert.equal(await page.evaluate(async () => {
    const account = (await import('/js/modules/AccountAccess.js')).default;
    await account.bootstrap();
    return account.getState().ready;
  }), true);
  await page.locator('#testBtn:visible, #recordToggle:visible').first().waitFor({ state: 'visible' }).catch(async error => {
    console.error(JSON.stringify({ errors, state: await page.evaluate(() => ({ url: location.href, bodyClass: document.body.className,
      trace: window.__micprobeStartupDiagnostics?.entries?.slice(-15), caught: window.__micprobeStartupDiagnostics?.errors })) }, null, 2));
    throw error;
  });
  assert.equal(await page.locator('#troubleshootingPanel, [data-troubleshooting-field]').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Get help without recording', exact: true }).count(), 0);
  return { context, page, errors, requests, downloads, setPremium: value => { premium = value; },
    failNextDetail: () => { failuresRemaining = 1; } };
}

async function publish(page, level) {
  return page.evaluate(async quality => {
    const { createRunSnapshot } = await import('/js/modules/RunSnapshot.js');
    const bus = (await import('/js/modules/EventBus.js')).default;
    const { EVENTS } = await import('/js/modules/constants.js');
    const profile = { id: 'whatsapp-voice', label: 'WhatsApp voice message', category: 'record' };
    const snapshot = createRunSnapshot({ profile });
    const signal = quality === 'quiet' ? { rmsDb: -60, peakDb: -50, maxBlockRmsDb: -53 }
      : quality === 'near-silent' ? { rmsDb: -65, peakDb: -60, maxBlockRmsDb: -62 }
        : { rmsDb: -23, peakDb: -10, maxBlockRmsDb: -18 };
    const report = {
      version: '2.0', generatedAt: new Date().toISOString(), sessionId: 'automatic-guide-fixture',
      run: { id: snapshot.runId, accountOwnerId: 'guide-fixture-account', type: 'record' },
      environment: snapshot.environment, profile,
      communicationContext: snapshot.communicationContext, troubleshooting: snapshot.troubleshooting,
      audioMetrics: { status: 'measured', source: 'decoded-file-pcm', sampleCount: 48000, durationMs: 1000,
        signal,
        clipping: { status: 'measured', method: 'sample-saturation', rate: 0 },
        headroom: { peakDb: signal.peakDb }, coverage: { truncated: false },
        snr: { status: 'unavailable' }, noiseFloor: { status: 'unavailable' } }
    };
    bus.emit(EVENTS.DIAGNOSTIC_REPORT_READY, report);
    // Reports now publish an inline result; opening the optional report is a
    // separate user action. This fixture has no Player, so open it explicitly.
    (await import('/js/ui/ReportPanelUI.js')).default.open();
    return report;
  }, level);
}

async function premiumFlow(browser) {
  const { context, page, errors, requests } = await setup(browser, true);
  try {
    const report = await publish(page, 'quiet');
    await page.waitForFunction(() => document.querySelector('#reportRecommendations')?.textContent.includes('Windows'));
    await page.locator('.report-evidence > summary').filter({ hasText: 'Measurement guidance' }).click();
    assert.equal(report.troubleshooting.osSource, 'browser-hint');
    for (const key of ['app', 'client', 'symptom', 'scope', 'trigger']) assert.equal(report.troubleshooting[key], 'unknown');
    const recommendations = page.locator('#reportRecommendations');
    assert.doesNotMatch(await recommendations.innerText(), /You reported|Based on your description|LatencyMon|DPC/);
    assert(await recommendations.locator('.rec-steps li').count() >= 2);
    assert(await recommendations.locator('a[href^="https://support.microsoft.com/"]').count() > 0);
    assert.equal(await page.locator('#reportTroubleshootingContext').innerText(), '', 'No invented user description');
    await page.setViewportSize({ width: 375, height: 812 });
    await recommendations.scrollIntoViewIfNeeded();
    const geometry = await recommendations.evaluate(node => ({ scroll: node.scrollWidth, width: node.clientWidth }));
    assert(geometry.width > 0 && geometry.scroll <= geometry.width + 1, JSON.stringify(geometry));
    await page.screenshot({ path: '.tmp/automatic-guidance-mobile.png' });

    await page.evaluate(async () => (await import('/js/ui/ReportPanelUI.js')).default.close());
    await publish(page, 'near-silent');
    await page.waitForFunction(() => document.querySelector('#reportRecommendations')?.textContent.includes('Speech was not verified'));
    await page.locator('.report-evidence > summary').filter({ hasText: 'Measurement guidance' }).click();
    assert.equal(await recommendations.locator('.rec-category-troubleshooting').count(), 0, 'Near silence alone must not trigger OS or input-gain steps');
    assert.equal(await recommendations.locator('.rec-steps li').count(), 0);
    assert.match(await recommendations.innerText(), /does not establish a microphone fault or justify increasing gain/);
    assert.doesNotMatch(await recommendations.innerText(), /Windows Settings|check the selected input|input-level control/i);

    await page.evaluate(async () => (await import('/js/ui/ReportPanelUI.js')).default.close());
    await publish(page, 'normal');
    await page.waitForFunction(() => document.querySelector('#reportObservations')?.textContent.includes('Quiet sections alone'));
    await page.locator('.report-evidence > summary').filter({ hasText: 'Measurement guidance' }).click();
    assert.equal(await recommendations.locator('.rec-category-troubleshooting').count(), 0, 'OS alone must not trigger guidance');
    assert.doesNotMatch(await recommendations.innerText(), /LatencyMon|Windows Settings/);
    assert.doesNotMatch(await recommendations.innerText(), /Quiet sections alone|Confidence:/, 'Explanatory observations do not masquerade as actions');
    assert.match(await page.locator('#reportObservations').textContent(), /Quiet sections alone/);
    assert.equal(requests.length, 3, 'Quiet, near-silent and normal reports each request one evaluation');
    assert.equal(await page.evaluate(() => window.__guideMicRequests), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: no questionnaire, automatic OS snapshot, measured-only steps, near-silence and normal-audio exclusions, and mobile report');
  } finally { await context.close(); }
}

async function lockedFlow(browser) {
  const { context, page, errors, requests, downloads, setPremium, failNextDetail } = await setup(browser, false);
  try {
    await publish(page, 'quiet');
    assert.equal(requests.length, 0);
    const summary = page.locator('#reportSummary');
    assert.match(await summary.innerText(), /Saved audio only; speech clarity and recipient audio are unmeasured/);
    assert.match(await summary.innerText(), /The recording has a low sound level/);
    assert.doesNotMatch(await summary.innerText(), /Check the selected|Windows Settings|closer speaking|input.volume|dBFS/);
    assert.equal(await summary.locator('#reportFindings, #reportMetricsGrid, #reportRecommendations').count(), 0);
    assert.equal(await summary.locator('details[open]').count(), 0);
    await summary.locator('summary').click();
    assert.match(await summary.innerText(), /Speech intelligibility.*not measured/);
    await summary.locator('summary').click();
    assert.equal(await page.locator('#reportDetailed').isHidden(), true);
    for (const selector of ['#reportFindings', '#reportMetricsGrid', '#reportRecommendations', '#reportObservations']) {
      assert.equal(await page.locator(selector).textContent(), '', 'Locked detail must be absent, not blurred');
    }
    assert.equal(downloads.length, 0, 'Showing a result must not download a file');
    assert.equal(await page.evaluate(() => !!globalThis.jspdf), false, 'PDF code remains lazy until requested');
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: '.tmp/free-summary-mobile.png' });
    assert.equal(await page.locator('#reportDownloadBtn').isHidden(), true);
    assert.equal(await page.locator('#reportDownloadBtn').isDisabled(), true);
    await page.evaluate(async () => (await import('/js/ui/ReportPanelUI.js')).default._downloadPdf());
    assert.equal(downloads.length, 0, 'Free access cannot export a summary PDF');
    assert.equal(await page.evaluate(() => !!globalThis.jspdf), false);

    // An existing open result gains in-app instructions after membership activates.
    failNextDetail();
    setPremium(true);
    await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.refresh({ sessionOnly: true }));
    const retry = page.getByRole('button', { name: 'Retry instructions', exact: true });
    await retry.waitFor({ state: 'visible' });
    assert.doesNotMatch(await page.locator('#premiumOverlay').innerText(), /Get Lifetime Premium|One payment/);
    assert.equal(await page.locator('#reportDetailed').isHidden(), true);
    assert.equal(await page.locator('#reportDownloadBtn').isHidden(), true, 'Failed details cannot export a PDF');
    await retry.click();
    await page.waitForFunction(() => document.querySelector('#reportRecommendations')?.textContent.includes('Windows'));
    assert.equal(await page.locator('#reportDetailed').isVisible(), true);
    assert.equal(await page.locator('#premiumOverlay').isHidden(), true);
    assert.equal(await page.locator('.report-evidence[open]').count(), 0);
    await page.locator('.report-evidence > summary').filter({ hasText: 'Detailed findings and measurements' }).click();
    assert(await page.locator('#reportMetricsGrid .metric-card').count() > 0);
    assert.equal(await page.locator('#reportFindings').isVisible(), true);
    await page.locator('.report-evidence > summary').filter({ hasText: 'Detailed findings and measurements' }).click();
    assert.equal(downloads.length, 0, 'Membership reveals instructions without requiring PDF download');
    assert.equal(requests.length, 2, 'A failed details request retries instead of starting another checkout');
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download detailed report as PDF', exact: true }).click();
    await (await downloadEvent).saveAs('.tmp/premium-details-browser.pdf');
    assert.equal(downloads.length, 1);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#reportOverall').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.tmp/premium-in-app-instructions.png' });

    setPremium(false);
    await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.refresh({ sessionOnly: true }));
    assert.equal(await page.locator('#reportDetailed').isHidden(), true);
    assert.equal(await page.locator('#reportRecommendations').textContent(), '');
    assert.equal(await page.locator('#reportFindings').textContent(), '');
    assert.equal(await page.locator('#reportMetricsGrid').textContent(), '');
    assert.equal(await page.locator('#reportDownloadBtn').isHidden(), true);
    assert.equal(await page.locator('#reportDownloadBtn').isDisabled(), true);
    await page.evaluate(async () => (await import('/js/ui/ReportPanelUI.js')).default._downloadPdf());
    assert.equal(downloads.length, 1, 'Revoked access cannot download again');
    assert.equal(await page.evaluate(() => window.__guideMicRequests), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: free PDF blocked, Premium PDF after detail retry, and export removed on revocation');
  } finally { await context.close(); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try { await premiumFlow(browser); await lockedFlow(browser); }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
