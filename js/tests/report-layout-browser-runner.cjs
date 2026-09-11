// Layout-only fixtures: no microphone, account mutation, purchase or physical iOS claim.
const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const playwright = require('playwright');
const { evaluateIndependentReport } = require('../../server/independent-report.js');
const BASE = 'http://localhost:8080';
const sizes = [[320, 568], [375, 667], [390, 670], [479, 800], [480, 800],
  [768, 900], [844, 390], [667, 375], [320, 360], [1280, 900]];
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function checkLayout(page, label, minimum = 150) {
  await settle(page);
  const metrics = await page.locator('#reportPanel').evaluate(dialog => {
    const body = dialog.querySelector('.report-popup-body');
    const rect = dialog.getBoundingClientRect();
    const close = dialog.querySelector('.btn-overlay-close').getBoundingClientRect();
    return {
      bodyHeight: body.clientHeight,
      contained: rect.top >= 0 && rect.bottom <= innerHeight + 1 && rect.left >= 0 && rect.right <= innerWidth + 1,
      horizontalOverflow: body.scrollWidth - body.clientWidth,
      closeVisible: close.top >= rect.top && close.bottom <= body.getBoundingClientRect().top,
      closeSize: Math.min(close.width, close.height),
      clipped: [...body.querySelectorAll('.metric-card-value,.metric-card-label,.rec-action,.rec-reason')]
        .filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1).map(el => el.textContent)
    };
  });
  assert(metrics.bodyHeight >= minimum, `${label}: reading area collapsed (${metrics.bodyHeight}px)`);
  assert(metrics.contained, `${label}: dialog leaves viewport`);
  assert(metrics.horizontalOverflow <= 1, `${label}: body overflows by ${metrics.horizontalOverflow}px`);
  assert(metrics.closeVisible && metrics.closeSize >= 48, `${label}: touch close must stay visible`);
  assert.deepEqual(metrics.clipped, [], `${label}: metric text must wrap`);
  // Each action must remain reachable even when large text makes the entire footer taller than the body.
  for (const id of ['reportSetupBtn', 'reportRetestBtn']) {
    const action = page.locator('#' + id);
    if (await action.isHidden()) continue;
    await action.scrollIntoViewIfNeeded();
    assert(await action.evaluate(button => {
      const rect = button.getBoundingClientRect(), body = button.closest('.report-popup-body').getBoundingClientRect();
      return rect.top >= body.top - 1 && rect.bottom <= body.bottom + 1 && rect.left >= body.left && rect.right <= body.right;
    }), `${label}: ${id} is unreachable`);
  }
}

(async () => {
  const { reviewReport } = await import('./review-fixtures.mjs');
  await mkdir('.tmp/report-layout', { recursive: true });
  let checks = 0;
  const engines = process.argv.find(arg => arg.startsWith('--browser='))?.split('=')[1];
  for (const engine of engines ? [engines] : ['chromium', 'firefox', 'webkit']) {
    const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { channel: 'chrome' } : {}) });
    try {
      for (const mode of ['guest', 'free', 'premium']) {
        const context = await browser.newContext({
          ...(engine === 'firefox' ? { hasTouch: true } : playwright.devices['iPhone 13']),
          viewport: { width: 390, height: 670 }, reducedMotion: 'reduce'
        });
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await context.addInitScript(() => {
          if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {} });
          if (!window.AudioContext && !window.webkitAudioContext) window.AudioContext = class {
            state = 'suspended'; sampleRate = 48000;
            async resume() { this.state = 'running'; }
            async close() { this.state = 'closed'; }
          };
          navigator.mediaDevices.getUserMedia = async () => { throw new Error('Layout test must not capture audio'); };
        });
        await page.route(url => url.origin !== BASE, route => route.fulfill({ body: '' }));
        let detailState = 'ready';
        const pending = [];
        const replyDetails = route => route.fulfill({ json: { ok: true,
          detailed: evaluateIndependentReport(route.request().postDataJSON().report).detailed } });
        await page.route('**/api/**', route => {
          const path = new URL(route.request().url()).pathname;
          if (path === '/api/account/config') return route.fulfill({ json: { ok: true, configured: true } });
          if (path === '/api/account/session') return route.fulfill({ json: { ok: true,
            user: mode === 'guest' ? null : { id: 'layout-user', name: 'Layout', email: 'layout@example.test' },
            premium: { unlocked: mode === 'premium' } } });
          if (path === '/api/account/reports') return route.fulfill({ json: { ok: true, reports: [] } });
          if (path === '/api/freemius/config') return route.fulfill({ json: { configured: false } });
          if (path === '/api/report/detailed') {
            if (detailState === 'loading') { pending.push(route); return; }
            if (detailState === 'error') return route.fulfill({ status: 503, json: { error: 'unavailable' } });
            return replyDetails(route);
          }
          return route.fulfill({ json: { ok: true } });
        });
        await page.goto(BASE);
        await page.locator('#heroLaunchBtn').click();
        await page.waitForFunction(() => document.body.classList.contains('app-mode'));
        await page.locator('#scenarioChoices [data-profile="raw"]').click();
        await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.bootstrap());
        const render = async (id, status = 'measured', close = true) => {
          const report = reviewReport(id, { status });
          if (status === 'unavailable') report.audioMetrics = { source: 'decoded-file-pcm', status };
          report.recording = { mimeType: 'audio/mp4;codecs=mp4a.40.2', durationMs: 10000 };
          await page.evaluate(async ({ report, close }) => {
            const panel = (await import('/js/ui/ReportPanelUI.js')).default;
            if (close) panel.close();
            panel.setWorkflowActions({ getIsBusy: () => false, canRetest: () => true });
            document.querySelector('#resultCard').dataset.runId = report.run.id;
            panel._renderReport(report); panel.open();
          }, { report, close });
          if (mode === 'premium' && status === 'measured') await page.waitForFunction(state =>
            document.querySelector('#reportDetailedWrapper').dataset.state === state, detailState);
          await settle(page);
        };
        const assertStart = async label => {
          assert(await page.locator('.report-popup-body').evaluate(body => {
            const title = body.querySelector('.report-overall-label').getBoundingClientRect();
            return body.scrollTop === 0 && body.scrollLeft === 0 && title.top >= body.getBoundingClientRect().top
              && !body.querySelector('details[open]');
          }), `${label}: new report must start at its result with details collapsed`);
        };
        for (const status of ['measured', 'unavailable']) {
          await render(`layout-${status}`, status);
          await assertStart(`${engine}/${mode}/${status}`);
          if (mode !== 'premium') assert.equal(
            await page.locator('.report-popup-actions').evaluate(el => getComputedStyle(el).display), 'none', 'Empty tools leave no header row');
          if (status === 'unavailable') assert(await page.locator('#reportDownloadBtn').isHidden(), 'Insufficient audio has no PDF action');
          for (const [width, height] of sizes) {
            await page.setViewportSize({ width, height });
            await page.locator('.report-popup-body details').evaluateAll(nodes => nodes.forEach(el => { el.open = true; }));
            await checkLayout(page, `${engine}/${mode}/${status}/${width}x${height}`); checks++;
          }
        }
        await page.setViewportSize({ width: 390, height: 670 });
        await render('scroll-first');
        await page.locator('.report-popup-body details').evaluateAll(nodes => nodes.forEach(el => { el.open = true; }));
        // Stay away from the bottom: native dialog reopening may legitimately clamp its scroll limit.
        const previousScroll = await page.locator('.report-popup-body').evaluate(body => {
          body.scrollTop = Math.floor((body.scrollHeight - body.clientHeight) / 2); return body.scrollTop;
        });
        assert(previousScroll > 0);
        await page.evaluate(async () => { const panel = (await import('/js/ui/ReportPanelUI.js')).default; panel.close(); panel.open(); });
        assert.equal(await page.locator('.report-popup-body').evaluate(body => body.scrollTop), previousScroll, 'Reopening the same report keeps reading position');
        await render('scroll-next'); await assertStart('Replacing a closed report');
        await page.locator('.report-popup-body').evaluate(body => { body.scrollTop = body.scrollHeight; });
        await render('scroll-open', 'measured', false); await assertStart('Replacing an open report');
        await page.screenshot({ path: `.tmp/report-layout/${engine}-${mode}.png` });

        if (mode === 'premium') {
          await page.locator('.report-popup-body details').evaluateAll(nodes => nodes.forEach(el => { el.open = true; }));
          const style = await page.addStyleTag({ content: ':root{--fs-xs:24px;--fs-sm:26px;--fs-base:28px;--fs-md:30px;--fs-lg:32px;--fs-xl:40px;--fs-2xl:48px}' });
          for (const [width, height] of [[320, 568], [390, 670], [667, 375]]) {
            await page.setViewportSize({ width, height });
            await checkLayout(page, `${engine}/large-text/${width}x${height}`); checks++;
          }
          await style.evaluate(el => el.remove());
          await page.setViewportSize({ width: 390, height: 670 });
          detailState = 'loading'; await render('loading');
          await checkLayout(page, `${engine}/loading`); checks++;
          await page.locator('.report-popup-body').evaluate(body => { body.scrollTop = 0; });
          detailState = 'ready'; await Promise.all(pending.splice(0).map(replyDetails));
          await page.waitForFunction(() => document.querySelector('#reportDetailedWrapper').dataset.state === 'ready');
          await assertStart('Delayed details keep the result visible');
          detailState = 'error'; await render('error');
          await checkLayout(page, `${engine}/error`); checks++;
          assert(await page.getByRole('button', { name: 'Retry instructions' }).isVisible());
        }

        // Browser Back must dismiss owned report/account/quota overlays and release page scrolling.
        for (const surface of ['report', 'account', 'quota']) {
          if (surface === 'account') await page.locator('#accountMenuBtn').click();
          if (surface === 'quota') await page.evaluate(async () => {
            const { TestAccessUI } = await import('/js/ui/TestAccessUI.js');
            new TestAccessUI({ onContinue: () => {} }).show('guest_test_limit');
          });
          await page.goBack();
          await page.waitForFunction(() => !document.body.classList.contains('app-mode'));
          assert(await page.evaluate(async () => !document.querySelector('dialog[open]')
            && !(await import('/js/ui/OverlayController.js')).getOpenOverlayCount()
            && !document.documentElement.classList.contains('is-scroll-locked')), `${surface}: Back must release overlays`);
          await page.goForward();
          await page.waitForFunction(() => document.body.classList.contains('app-mode'));
        }
        assert.deepEqual(errors, [], `${engine}/${mode}: uncaught browser errors`);
        await context.close();
        console.log(`PASS ${engine}/${mode}: responsive report, wrapping, scroll ownership and navigation`);
      }
    } finally { await browser.close(); }
  }
  console.log(`PASS ${checks} report layout cases (${engines || 'chromium, firefox, webkit'})`);
})().catch(error => { console.error(error); process.exitCode = 1; });
