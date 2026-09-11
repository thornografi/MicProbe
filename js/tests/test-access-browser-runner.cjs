// Real capture controllers and quota service against isolated SQLite; no account,
// purchase, physical microphone or production storage is used.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = 'http://localhost:8080';

(async () => {
  const { createNodeAccountDb } = await import('../../server/node-account-db.mjs');
  const { createTestAccess } = await import('../../server/test-access.mjs');
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  try {
    for (const profile of ['raw', 'discord']) {
      const db = createNodeAccountDb(':memory:');
      const context = await browser.newContext({ viewport: { width: profile === 'raw' ? 1280 : 390, height: 900 } });
      let owner = null, premium = false;
      const service = createTestAccess({ db, accounts: { configured: true, getUser: async () => owner ? { id: owner } : null },
        billing: { refreshUserLicense: async () => ({ active: premium }) }, origin: BASE });
      try {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.route(url => url.origin !== BASE, route => route.fulfill({ body: '' }));
        await page.route('**/api/account/**', route => route.fulfill({ json: { ok: true, configured: false,
          user: owner ? { id: owner, name: 'Test account' } : null, premium: { unlocked: premium }, reports: [] } }));
        await page.route('**/api/freemius/config', route => route.fulfill({ json: { configured: false, mode: 'sandbox' } }));
        const requests = [];
        await page.route('**/api/tests/**', async route => {
          const request = route.request();
          const body = request.postData(); requests.push({ url: request.url(), body });
          const result = await service.handle(new Request(request.url(), { method: request.method(),
            headers: await request.allHeaders(), body }), { ip: '203.0.113.1' });
          await route.fulfill({ status: result.status, headers: Object.fromEntries(result.headers), body: await result.text() });
        });
        await page.goto(BASE + '/app');
        await page.locator(`#scenarioChoices [data-profile="${profile}"]`).click();
        await page.evaluate(async () => {
          const bus = (await import('/js/modules/EventBus.js')).default;
          const { EVENTS } = await import('/js/modules/constants.js');
          window.__reports = []; window.__requests = 0;
          bus.on(EVENTS.DIAGNOSTIC_REPORT_READY, report => window.__reports.push(report));
          const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
          navigator.mediaDevices.getUserMedia = async constraints => { window.__requests++; return original(constraints); };
        });
        const action = profile === 'raw' ? '#recordToggle' : '#testBtn';
        assert.equal(await page.locator('#testAccessDialog').isVisible(), false);
        await page.locator(action).click();
        await page.waitForFunction(() => window.__reports.length === 1, null, { timeout: 35000 }).catch(async error => {
          console.error({ errors, requests, state: await page.evaluate(() => ({ state: document.body.dataset.appState,
            quota: document.querySelector('#testAccessMessage')?.textContent, guide: document.querySelector('#captureGuideStatus')?.textContent,
            requests: window.__requests })) });
          throw error;
        });
        await page.waitForFunction(() => !document.body.dataset.appState || document.body.dataset.appState === 'idle');
        const id = await page.evaluate(() => window.__reports[0].run.id);
        assert.equal((await db.prepare('SELECT state FROM test_runs WHERE run_id = ?').bind(id).first()).state, 'completed');
        await page.locator(action).click();
        await page.locator('#testAccessDialog[open]').waitFor();
        assert.match(await page.locator('#testAccessMessage').innerText(), /Sign in for free/);
        assert.equal(await page.evaluate(() => window.__requests), 1, 'Blocked attempt never requests a microphone');
        assert.equal(await page.evaluate(() => window.__reports.length), 1, 'Current report survives refusal');
        assert.equal(await page.locator('#testAccessDialog').evaluate(el => el.scrollWidth <= el.clientWidth), true);
        await page.locator('#testAccessDialog [aria-label="Close"]').click();
        await page.locator('#playBtn').click();
        assert.equal(await page.locator('#playBtn').getAttribute('aria-label'), 'Pause');
        await page.locator('#playBtn').click();
        const downloadPromise = page.waitForEvent('download');
        await page.locator('#downloadBtn').click();
        const download = await downloadPromise;
        assert.equal(await download.failure(), null);
        // Sign-in adopts the guest test; four further measured runs exhaust five.
        owner = 'quota-browser-user';
        await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.refresh());
        await page.evaluate(async () => {
          const evidence = { status: 'measured', sampleCount: 48000, durationMs: 1000,
            signal: { rmsDb: -24, peakDb: -12 }, clipping: { status: 'measured', method: 'sample-saturation', rate: 0 } };
          for (let i = 0; i < 4; i++) for (const action of ['start', 'complete']) {
            const response = await fetch(`/api/tests/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json',
              'X-MicProbe-Request': '1', 'X-MicProbe-Account': 'quota-browser-user' },
              body: JSON.stringify({ runId: `seed-account-${i}`, ...(action === 'complete' ? { evidence } : {}) }) });
            if (!response.ok) throw new Error(await response.text());
          }
        });
        await page.locator(action).click();
        await page.locator('#testAccessDialog[open]').waitFor();
        assert.equal(await page.locator('#testAccessMessage').innerText(), 'Continue testing with Premium.');
        assert.equal(await page.evaluate(() => window.__requests), 1);
        await page.locator('#testAccessDialog [aria-label="Close"]').click();
        premium = true;
        await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.refresh());
        await page.locator(action).click();
        await page.waitForFunction(() => window.__requests === 2);
        await page.locator(action).click(); // cancel preparation, keeping this check short
        await page.waitForFunction(() => document.body.dataset.appState === 'idle');
        assert.ok(requests.every(request => !/"(?:audio|pcm|blob|logs|device)"/.test(request.body)));
        console.log(`PASS ${profile}: guest/account limits, Premium access, preserved playback/download, no audio upload`);
      } finally { await context.close(); db.close(); }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
