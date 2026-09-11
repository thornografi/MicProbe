// Independent result, Premium archive and PDF through the real application UI.
// Account/HTTP fixtures and in-memory SQLite; no real audio, billing or AI.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = 'http://localhost:8080';

(async () => {
  const [{ createNodeAccountDb }, { AccountStore }, { createReviewService }, { reviewReport }] = await Promise.all([
    import('../../server/node-account-db.mjs'), import('../../server/account-store.mjs'),
    import('../../server/review-service.mjs'), import('./review-fixtures.mjs')]);
  const { evaluateIndependentReport, EVALUATION_VERSION } = require('../../server/independent-report.js');
  const db = createNodeAccountDb(':memory:'), store = new AccountStore(db, 'sandbox');
  const user = await store.upsertUser({ sub: 'independent-browser', email: 'fixture@example.com', name: 'Fixture' });
  await store.saveLicense(user.id, { licenseId: '44', freemiusUserId: null, active: true, verifiedAt: Date.now() });
  let premium = false;
  const report = reviewReport('independent-browser'); report.run.accountOwnerId = user.id;
  report.profile.label = 'Raw recording'; report.device = { micName: 'Fixture microphone' };
  report.environment = { version: 1, os: 'windows', browser: 'chrome', browserMajor: 145, formFactor: 'desktop' };
  report.profile.requestedConstraints = { ...report.profile.appliedConstraints, sampleRate: 44100 };
  report.profile.appliedConstraints.autoGainControl = true;
  report.captureContext = { capabilities: { sampleRateRange: { min: 48000, max: 48000 }, agcSupported: [true] } };
  report.system = { runId: report.run.id, tabWasHidden: true, mainThreadJitter: { supported: true, sampleCount: 120, spikeCount: 3 } };
  const reviews = createReviewService({ db, accounts: { configured: true, getUser: async () => user },
    billing: { refreshUserLicense: async () => ({ active: premium }) },
    tests: { verifyReviewRun: async (request, runId) => { assert.equal(runId, report.run.id); } }, origin: BASE });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const errors = [], calls = []; let detailCalls = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.origin !== BASE, route => route.fulfill({ status: 200, body: '' }));
    await page.route('**/api/account/**', async route => {
      const req = route.request(), url = new URL(req.url()), method = req.method();
      let payload;
      if (url.pathname.endsWith('/config')) payload = { ok: true, configured: true };
      else if (url.pathname.endsWith('/session')) payload = { ok: true, user, premium: { unlocked: premium } };
      else if (url.pathname.endsWith('/reports') && method === 'GET') payload = { ok: true, ...await store.listReports(user.id, 20) };
      else if (url.pathname.includes('/reports/') && method === 'GET') {
        const entry = await store.getReport(user.id, url.pathname.split('/').pop());
        payload = { ok: true, report: { ...entry, evaluation: premium ? entry.evaluation : { public: entry.evaluation.public } } };
      } else if (url.pathname.endsWith('/reports') && method === 'POST') {
        if (!premium) return route.fulfill({ status: 403, json: { ok: false, error: 'premium_access_required' } });
        const input = req.postDataJSON(); payload = { ok: true, report: await store.saveReport(user.id, input.report, input.note || '') };
      } else return route.fulfill({ status: 400, json: { ok: false, error: 'unexpected-fixture-request' } });
      await route.fulfill({ json: payload });
    });
    await page.route('**/api/freemius/config', route => route.fulfill({ json: { configured: false, mode: 'sandbox' } }));
    await page.route('**/api/report/detailed', async route => {
      detailCalls++;
      const input = route.request().postDataJSON().report;
      const saved = await store.getReportByRun(user.id, input.run.id);
      await route.fulfill({ json: { ok: true, detailed: saved?.evaluation?.detailed || evaluateIndependentReport(input).detailed } });
    });
    await page.route('**/api/reviews/**', async route => {
      const req = route.request(); calls.push(new URL(req.url()).pathname);
      const headers = new Headers(req.headers()); headers.set('Origin', BASE);
      const response = await reviews.handle(new Request(req.url(), { method: req.method(), headers, body: req.postData() }));
      await route.fulfill({ status: response.status, body: await response.text(), headers: Object.fromEntries(response.headers) });
    });
    await page.goto(BASE + '/#app');
    await page.waitForFunction(() => document.body.classList.contains('app-mode'));
    await page.evaluate(async report => {
      await (await import('/js/modules/AccountAccess.js')).default.bootstrap();
      (await import('/js/modules/DiagnosticReportBuilder.js')).default.restoreReport(report);
      (await import('/js/ui/ReportPanelUI.js')).default.open();
    }, report);
    await page.getByRole('button', { name: 'Get Lifetime Premium', exact: true }).waitFor();
    assert.equal(await page.locator('#reportDownloadBtn').isVisible(), false);
    assert.equal(await page.locator('#reportReview').isVisible(), false);
    assert.equal((await store.listReports(user.id, 20)).reports.length, 0);
    const local = await page.evaluate(() => localStorage.getItem('micprobe:report-history:v1'));
    assert.ok(!local || !JSON.stringify(JSON.parse(local).pending).includes(report.run.id));
    premium = true;
    await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.refresh({ sessionOnly: true }));
    await page.getByRole('button', { name: 'Save this report', exact: true }).click();
    await page.getByText('Saved to your account. Each report is assessed independently.', { exact: true }).waitFor();
    const saved = await store.getReportByRun(user.id, report.run.id);
    assert.equal(saved.evaluation.version, EVALUATION_VERSION);
    assert.equal(await page.locator('#reportReview fieldset').count(), 0);
    assert.equal(await page.locator('#comparePreviousBtn').count(), 0);
    await page.locator('#reportDownloadBtn').waitFor({ state: 'visible' });
    await page.getByText('Measurement guidance', { exact: true }).click();
    const contextText = await page.locator('#reportRecommendations').innerText();
    assert.match(contextText, /Automatic gain control was active/);
    assert.match(contextText, /did not report support/);
    assert.match(contextText, /background during part of the run/);
    assert.match(contextText, /Windows Settings/);
    await page.getByText('Detailed findings and measurements', { exact: true }).click();
    assert.match(await page.locator('#reportMetricsGrid').innerText(), /Recording Browser.*Browser Hint/s);
    const detailCount = detailCalls;
    const download = page.waitForEvent('download');
    await page.locator('#reportDownloadBtn').click();
    assert.match((await download).suggestedFilename(), /independent-browser.*\.pdf$/);
    assert.equal(detailCalls, detailCount, 'PDF reuses the accepted result');
    await page.evaluate(async () => (await import('/js/ui/ReportPanelUI.js')).default.close());
    await page.locator('#accountMenuBtn').click();
    await page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
    await page.getByRole('button', { name: 'Open report', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Compare selected/ }).count(), 0);
    assert.match(await page.locator('#accountHistoryList').innerText(), /low sound level/);
    await page.getByRole('button', { name: 'Open report', exact: true }).click();
    await page.locator('#reportDownloadBtn').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(async () => (await import('/js/ui/ReportPanelUI.js')).default.currentReport.savedEvaluation.evaluatedAt), saved.evaluation.evaluatedAt);
    assert.equal(detailCalls, detailCount, 'Opening accepted history needs no new evaluation request');
    const legacyScope = await page.evaluate(async () => {
      const panel = (await import('/js/ui/ReportPanelUI.js')).default;
      const accepted = panel.currentReport.savedEvaluation;
      const before = JSON.stringify(accepted);
      const summary = accepted.public;
      const text = `${summary.scope} Earlier recording details.`;
      panel._renderOverall(summary.overall, summary.summary, [...summary.scope, 'Earlier recording details.'], summary.assessment, summary.scopeSummary);
      const rendered = document.querySelector('.report-scope p').textContent;
      panel._renderOverall(summary.overall, summary.summary, summary.scope, summary.assessment, summary.scopeSummary);
      return { rendered, text, unchanged: JSON.stringify(accepted) === before };
    });
    assert.equal(legacyScope.rendered, legacyScope.text);
    assert.ok(legacyScope.unchanged, 'Scope presentation must not rewrite accepted history');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    premium = false;
    await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.refresh({ sessionOnly: true }));
    assert.equal(await page.locator('#reportDownloadBtn').isVisible(), false);
    assert.equal(await page.locator('#reportDetailed').isVisible(), false);
    assert.equal((await store.listReports(user.id, 20)).reports.length, 1);
    assert.ok(calls.every(path => ['/api/reviews/assess', '/api/reviews/archive'].includes(path)), calls.join(','));
    assert.deepEqual(errors, []);
    console.log('PASS: free no-history, Premium adoption, independent snapshot, lightweight archive, PDF reuse, mobile layout and revocation; no interactive review requests.');
  } finally { await browser.close(); db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
