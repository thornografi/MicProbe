// Real browser boundaries: navigation, lazy boot and recoverable resource failures.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = 'http://localhost:8080';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  async function open(path = '/') {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === BASE
      ? route.continue() : route.fulfill({ body: '' }));
    await page.route('**/api/freemius/config', route => route.fulfill({ json: { configured: false } }));
    await page.route('**/api/account/config', route => route.fulfill({ json: { configured: false } }));
    await page.route('**/api/account/session', route => route.fulfill({ json: { authenticated: false } }));
    await page.goto(BASE + path);
    return { context, page };
  }
  const appReady = page => page.waitForFunction(() => document.body?.classList.contains('app-mode'));
  const landingReady = page => page.waitForFunction(() => !document.body.classList.contains('app-mode'));
  const errorReady = page => page.locator('#appLoadRetry').waitFor({ state: 'visible' });
  try {
    {
      const { context, page } = await open();
      await page.locator('#heroLaunchBtn').hover();
      await page.locator('#heroLaunchBtn').focus();
      // Cross the legacy idle warmup deadline deliberately; no user action occurs.
      await page.waitForTimeout(1600);
      const requests = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname));
      assert.ok(!requests.includes('/js/app.js'), 'Landing must not evaluate the test application');
      assert.ok(!requests.some(path => path.startsWith('/api/')), 'Landing must not start account/checkout API calls');
      assert.ok(!requests.includes('/css/report.css'), 'App CSS stays lazy');
      assert.equal(await page.locator('#heroLaunchBtn').getAttribute('href'), '/app');
      await page.locator('#navbar a[href="#features"]').click();
      await page.waitForURL(BASE + '/#features');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'features-title');
      await page.locator('#navbarCta').click(); await appReady(page);
      assert.equal(new URL(page.url()).pathname, '/app');
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), 'https://micprobe.com/app');
      await page.goBack(); await landingReady(page);
      assert.equal(new URL(page.url()).hash, '#features');
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), 'https://micprobe.com/');
      await page.goForward(); await appReady(page);
      await context.close();
      console.log('PASS landing stays idle, real app links, section URL/focus and Back/Forward');
    }
    for (const entry of ['/app/', '/#app']) {
      const { context, page } = await open();
      const count = await page.evaluate(() => history.length);
      await page.goto(BASE + entry); await appReady(page);
      assert.equal(new URL(page.url()).pathname, '/app');
      assert.equal(await page.evaluate(() => history.length), count + 1, 'Normalization must replace, not push');
      await page.goBack(); await landingReady(page);
      assert.equal(new URL(page.url()).pathname, '/');
      await page.goForward(); await appReady(page);
      assert.equal(await page.evaluate(() => history.length), count + 1);
      await context.close();
    }
    console.log('PASS /app/ and legacy #app normalization never trap browser history');
    {
      const { context, page } = await open();
      let fail = true, requests = 0;
      await page.setViewportSize({ width: 320, height: 740 });
      await page.route('**/css/report.css', route => { requests++; return fail ? route.abort('failed') : route.continue(); });
      await page.locator('#heroLaunchBtn').click(); await errorReady(page);
      await page.waitForLoadState('networkidle');
      assert.equal(await page.evaluate(() => document.body.classList.contains('app-mode')), false);
      assert.match(await page.locator('#appLoadMessage').textContent(), /could not open/);
      assert.ok(await page.locator('#appLoadStatus').evaluate(node => {
        const bounds = node.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
      }), 'The retry panel must fit the smallest supported viewport');
      await page.screenshot({ path: '.tmp/navigation-load-error-mobile.png' });
      fail = false;
      await page.locator('#appLoadRetry').click(); await appReady(page);
      assert.equal(requests, 2, 'Failed stylesheet must actually be requested again');
      assert.equal(await page.locator('#appLoadStatus').isVisible(), false);
      await context.close();
      console.log('PASS failed app stylesheet is visible and retryable');
    }
    {
      const { context, page } = await open();
      let fail = true;
      await page.route('**/js/app.js', route => fail ? route.abort('failed') : route.continue());
      await page.locator('#heroLaunchBtn').click(); await errorReady(page);
      fail = false;
      await page.locator('#appLoadRetry').click(); await appReady(page);
      assert.equal(await page.locator('#appLoadStatus').isVisible(), false);
      await context.close();
      console.log('PASS failed module import recovers on explicit retry');
    }
    {
      const { context, page } = await open();
      await page.locator('#heroLaunchBtn').click(); await appReady(page);
      const count = await page.evaluate(() => history.length);
      await page.locator('#accountMenuBtn').click();
      await page.evaluate(async () => (await import('/js/app/AppState.js')).setIsPreparing(true));
      await page.evaluate(() => history.back());
      await page.waitForURL(BASE + '/app');
      assert.equal(await page.evaluate(() => document.body.classList.contains('app-mode')), true);
      assert.equal(await page.evaluate(() => history.length), count, 'Busy guard must not add a new entry');
      assert(await page.locator('#accountDialog').evaluate(dialog => dialog.open), 'Rejected navigation keeps the current overlay');
      await page.evaluate(async () => (await import('/js/app/AppState.js')).setIsPreparing(false));
      await page.goBack(); await landingReady(page);
      assert.equal(new URL(page.url()).pathname, '/');
      assert(await page.evaluate(() => !document.querySelector('#accountDialog').open
        && !document.documentElement.classList.contains('is-scroll-locked')), 'Accepted navigation releases the overlay and scroll lock');
      await context.close();
      console.log('PASS active preparation restores accepted history entry without growing history');
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
