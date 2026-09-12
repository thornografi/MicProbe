// Exercise the distributed assets through the real UI, without source-module imports.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { evaluatePremiumReport } = require('../../server/premium-report-evaluator.js');
// The same isolated fixtures can verify an explicitly selected deployed build.
const baseArg = process.argv.indexOf('--base-url');
const BASE = new URL(baseArg >= 0 ? process.argv[baseArg + 1] : 'http://localhost:8080').origin;
assert.ok(BASE === 'http://localhost:8080' || BASE === 'https://micprobe.com', 'Use localhost:8080 or the MicProbe deployment');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [], failedAssets = [];
  async function open(premium = false) {
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await require('./scenario-browser-helpers.cjs').allowTestAccess(page);
    const workers = [];
    page.on('worker', worker => workers.push(worker.url()));
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (new URL(response.url()).origin === BASE && /\.(css|js|wasm)(\?|$)/.test(response.url()) && !response.ok()) failedAssets.push(response.url());
    });
    await page.route(url => url.origin !== BASE, route => route.fulfill({ body: '', contentType: 'text/css' }));
    await page.route('**/api/account/**', route => {
      if (!premium) return route.fulfill({ json: { ok: true, configured: false, user: null } });
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      let payload;
      if (pathname.endsWith('/config')) payload = { ok: true, configured: true, googleClientId: null };
      else if (pathname.endsWith('/session')) payload = { ok: true, user: { id: 'built-pdf-fixture' }, premium: { unlocked: true } };
      else if (pathname.endsWith('/reports') && request.method() === 'GET') payload = { ok: true, reports: [], nextCursor: null };
      else if (pathname.endsWith('/reports') && request.method() === 'POST') {
        const { report, note } = request.postDataJSON();
        payload = { ok: true, report: { id: report.run.id, report, note, createdAt: report.generatedAt } };
      } else throw new Error(`Unexpected fixture route: ${request.method()} ${pathname}`);
      return route.fulfill({ json: payload });
    });
    await page.route('**/api/report/detailed', route => {
      assert.equal(premium, true, 'Free build must not request Premium details');
      return route.fulfill({ json: { ok: true, detailed: evaluatePremiumReport(route.request().postDataJSON().report) } });
    });
    await page.route('**/api/freemius/config', route => route.fulfill({ json: { configured: false } }));
    await page.goto(BASE);
    assert.equal(await page.locator('script[src^="/assets/index-"]').count(), 1, 'Run npm run build, then npm run start:built on localhost:8080');
    return { context, page, workers };
  }
  try {
    {
      const { context, page } = await open();
      await page.waitForTimeout(1600); // Includes post-load idle scheduling.
      const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(e => ({ path: new URL(e.name).pathname, bytes: e.decodedBodySize, type: e.initiatorType })));
      assert.ok(!resources.some(e => /\/api\/|\/app-|\/style-/.test(e.path)), 'Landing must not fetch application code, styles or accounts');
      console.log('PASS built landing stays lazy:', JSON.stringify({ scripts: resources.filter(e => e.type === 'script').length, scriptBytes: resources.filter(e => e.type === 'script').reduce((total, e) => total + e.bytes, 0) }));
      await page.locator('#navbarCta').click();
      await page.waitForFunction(() => document.body.classList.contains('app-mode'));
      const appResources = await page.evaluate(() => performance.getEntriesByType('resource').map(e => new URL(e.name).pathname));
      assert.equal(appResources.filter(path => /\/style-[^/]+\.css$/.test(path)).length, 1);
      assert.ok(!appResources.some(path => path.startsWith('/js/modules/')));
      await page.goBack();
      await page.waitForFunction(() => !document.body.classList.contains('app-mode'));
      await page.goForward();
      await page.waitForFunction(() => document.body.classList.contains('app-mode'));
      for (const path of ['/does-not-exist', '/app/missing', '/js/tests/audio-audit-browser.html']) {
        const response = await page.request.get(BASE + path);
        assert.equal(response.status(), 404, path);
      }
      const css = appResources.find(path => /\/style-[^/]+\.css$/.test(path));
      assert.match((await page.request.get(BASE + css)).headers()['cache-control'], /immutable/);
      await context.close();
      console.log('PASS built navigation, one lazy CSS bundle, immutable assets and real 404 responses');
    }
    for (const blocked of ['**/assets/style-*.css', '**/assets/app-*.js']) {
      const { context, page } = await open();
      let fail = true;
      await page.route(blocked, route => fail ? route.abort('failed') : route.continue());
      await page.locator('#navbarCta').click();
      await page.locator('#appLoadRetry').waitFor({ state: 'visible' });
      fail = false;
      await page.locator('#appLoadRetry').click();
      await page.waitForFunction(() => document.body?.classList.contains('app-mode'));
      await context.close();
    }
    console.log('PASS built CSS and JavaScript failures recover through the visible retry action');
    for (const [profile, button] of [['raw', '#recordToggle'], ['whatsapp-voice', '#recordToggle'], ['discord', '#testBtn']]) {
      const { context, page, workers } = await open(profile === 'raw');
      await page.locator('#navbarCta').click();
      await page.locator(`#scenarioChoices [data-profile="${profile}"]`).click();
      await page.locator(button).click();
      await page.locator('#inlineResult').waitFor({ state: 'visible', timeout: 30000 });
      assert.equal(await page.locator('#recordingPlayer').isVisible(), true);
      const originalEvent = page.waitForEvent('download');
      await page.locator('#downloadMenuBtn').click();
      await page.locator('#downloadBtn').click();
      const original = await originalEvent;
      const bytes = await readFile(await original.path());
      assert.ok(bytes.length > 100);
      assert.match(original.suggestedFilename(), profile === 'raw' ? /\.wav$/ : profile === 'whatsapp-voice' ? /\.ogg$/ : /\.webm$/);
      const decoded = await page.evaluate(async data => {
        const audio = new AudioContext();
        try { const buffer = await audio.decodeAudioData(Uint8Array.from(data).buffer); return buffer.duration; }
        finally { await audio.close(); }
      }, [...bytes]);
      assert.ok(decoded > 5, `${profile}: saved audio decodes and has the expected guided duration`);
      if (profile === 'raw') {
        const mp3Event = page.waitForEvent('download');
        await page.getByRole('link', { name: 'MP3', exact: true }).click();
        const mp3 = await mp3Event;
        assert.match(mp3.suggestedFilename(), /\.mp3$/);
        assert.ok((await readFile(await mp3.path())).length > 100);
        await page.getByRole('button', { name: 'Open test report', exact: true }).click();
        for (const width of [320, 390, 1280]) {
          await page.setViewportSize({ width, height: 844 });
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
          assert.equal(await page.locator('#reportRetestBtn').isVisible(), true);
          await page.locator('.report-workflow-actions').scrollIntoViewIfNeeded();
          assert(await page.locator('.report-workflow-actions').evaluate(footer => {
            const outer = footer.getBoundingClientRect();
            const body = document.querySelector('.report-popup-body').getBoundingClientRect();
            return outer.top >= body.top && outer.bottom <= body.bottom + 1 && [...footer.children].every(button => {
              const rect = button.getBoundingClientRect();
              return rect.left >= outer.left && rect.right <= outer.right && rect.bottom <= outer.bottom;
            });
          }), `${width}: report recovery actions remain reachable inside scrolling content`);
          assert(await page.getByRole('button', { name: 'Close report', exact: true }).evaluate(button => {
            const rect = button.getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= innerHeight;
          }), 'Close report stays visible while the report scrolls');
          await page.locator('.report-popup-body').evaluate(body => { body.scrollTop = 0; });
          if (width === 390) await page.screenshot({ path: '.tmp/ux-report-390.png' });
        }
        const pdfEvent = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download detailed report as PDF', exact: true }).click();
        const pdf = await pdfEvent;
        assert.equal((await readFile(await pdf.path())).subarray(0, 5).toString(), '%PDF-');
      } else {
        await page.getByRole('button', { name: 'Open test report', exact: true }).click();
        assert.equal(await page.locator('#reportDownloadBtn').isHidden(), true, 'Free build cannot export PDF');
      }
      assert.ok(workers.some(path => path.includes('spectral-analysis-worker-')), 'Built analysis worker must run');
      await context.close();
      console.log(`PASS built ${profile}: capture, worker analysis and decodable download${profile === 'raw' ? ', MP3 and PDF' : ''}`);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(failedAssets, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
