// Real account service, SQLite, cookies and full-page return; Google is a fixture.
const assert = require('node:assert/strict');
const { chromium, firefox, webkit } = require('playwright');
const { createPage, ready } = require('./account-browser-runner.cjs');
const BASE = 'http://localhost:8080';

async function run(browser, rememberMe) {
  const { createNodeAccountDb } = await import('../../server/node-account-db.mjs');
  const { createAccountService } = await import('../../server/account-service.mjs');
  const db = createNodeAccountDb(':memory:');
  const service = createAccountService({ db, origin: BASE, googleClientId: 'fixture-client', verifyGoogleToken: JSON.parse });
  const env = await createPage(browser, { configured: true });
  const { context, page } = env;
  const starts = [], callbacks = [], finishes = [];
  try {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/account/**', async route => {
      const incoming = route.request();
      const request = new Request(incoming.url(), { method: incoming.method(), headers: await incoming.allHeaders(),
        ...(incoming.postData() ? { body: incoming.postData() } : {}) });
      if (incoming.url().endsWith('/start')) starts.push(incoming.postDataJSON());
      if (incoming.url().endsWith('/redirect')) callbacks.push(request.headers.get('Cookie') || '');
      if (incoming.url().endsWith('/finish')) finishes.push(request.headers.get('Cookie') || '');
      const response = await service.handle(request);
      const headers = Object.fromEntries(response.headers);
      const cookies = response.headers.getSetCookie();
      if (incoming.url().endsWith('/start')) cookies.push('g_csrf_token=fixture-csrf; Path=/; SameSite=None; Secure');
      if (cookies.length) headers['set-cookie'] = cookies.join('\n');
      await route.fulfill({ status: response.status, headers, body: await response.text() });
    });
    await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({ contentType: 'text/javascript', body: `
      globalThis.google = { accounts: { id: {
        initialize(options) { this.options = options; window.__redirectOptions = options; },
        cancel() {}, disableAutoSelect() {},
        renderButton(container) {
          const options = this.options;
          const button = document.createElement('button'); button.textContent = 'Google redirect fixture';
          button.onclick = () => location.assign('https://accounts.google.com/gsi/redirect-fixture?nonce=' + options.nonce);
          container.append(button);
        }
      } } };` }));
    await page.route('https://accounts.google.com/gsi/redirect-fixture?*', route => {
      const credential = JSON.stringify({ sub: 'browser-owner', nonce: new URL(route.request().url()).searchParams.get('nonce'),
        aud: 'fixture-client', iss: 'https://accounts.google.com', email: 'browser@gmail.com', email_verified: true,
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
      return route.fulfill({ contentType: 'text/html', body: `<form method="post" action="${BASE}/api/account/google/redirect">
        <input name="g_csrf_token" value="fixture-csrf"><textarea name="credential">${credential}</textarea></form>
        <script>document.querySelector('form').submit()</script>` });
    });
    await page.goto(`${BASE}/app`); await ready(page);
    await page.evaluate(async () => {
      const panel = (await import('/js/ui/ReportPanelUI.js')).default;
      panel.currentReport = { version: '2.0', generatedAt: new Date().toISOString(), sessionId: 'redirect-guest',
        run: { id: 'redirect-guest-report', type: 'test' }, device: { micName: 'Fixture microphone' },
        profile: { id: 'discord', label: 'Discord Voice', constraints: {} },
        audioMetrics: { status: 'unavailable', sampleCount: 0 } };
    });
    await page.locator('#accountMenuBtn').click();
    await page.getByRole('button', { name: 'Google redirect fixture' }).waitFor();
    if (rememberMe) {
      await page.getByRole('checkbox', { name: 'Keep me signed in on this device' }).check();
      await page.waitForFunction(() => document.querySelector('.account-google button'));
    }
    assert.equal(starts.at(-1).rememberMe, rememberMe);
    assert.equal(await page.evaluate(() => window.__redirectOptions.ux_mode), 'redirect');
    await page.getByRole('button', { name: 'Google redirect fixture' }).click();
    if (browser.browserType().name() === 'webkit') {
      // Windows WebKit does not send Secure cookies over localhost HTTP.
      // Exercise the refusal/recovery instead of weakening the production CSRF check.
      await page.getByRole('link', { name: 'Return to MicProbe', exact: true }).waitFor();
      assert.equal(callbacks.length, 1); assert.equal(finishes.length, 0);
      assert.ok(!callbacks[0].includes('g_csrf_token='));
      assert.equal((await db.prepare('SELECT count(*) AS n FROM accounts').first()).n, 0);
      await page.getByRole('link', { name: 'Return to MicProbe', exact: true }).click();
      await page.locator('#accountDialog[open]').waitFor();
      assert.deepEqual(env.pageErrors, []);
      return;
    }
    await page.getByText('Signed in. New reports will be saved. Premium requires a verified purchase.', { exact: true }).waitFor({ timeout: 20000 });
    assert.equal(await page.getByText('Free account', { exact: true }).count(), 1);
    assert.equal(callbacks.length, 1); assert.equal(finishes.length, 1);
    assert.ok(!callbacks[0].includes('micprobe_login_nonce_'), 'Cross-site POST does not carry Lax browser proof');
    assert.ok(finishes[0].includes('micprobe_login_nonce_'), 'Same-origin exchange carries the proof');
    const session = (await context.cookies(BASE)).find(cookie => cookie.name === 'micprobe_session');
    assert.ok(session); assert.equal(session.expires > 0, rememberMe);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('micprobe:google-return:v1')), null);
    assert.equal(await page.evaluate(async () => (await import('/js/ui/ReportPanelUI.js')).default.currentReport?.run.id), 'redirect-guest-report');
    assert.deepEqual(env.pageErrors, []);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM account_reports').first()).n, 0);
  } catch (error) {
    console.error({ url: page.url(), text: (await page.locator('body').innerText()).slice(-2000),
      errors: env.pageErrors, consoleErrors: env.consoleErrors,
      callbackProof: callbacks.map(value => ({ csrf: value.includes('g_csrf_token='), nonce: value.includes('micprobe_login_nonce_') })),
      finishProof: finishes.map(value => value.includes('micprobe_login_nonce_')) });
    throw error;
  } finally { await context.close(); db.close(); }
}

(async () => {
  for (const [name, engine, options] of [['Chrome', chromium, { channel: 'chrome' }], ['Firefox', firefox, {}], ['WebKit', webkit, {}]]) {
    const browser = await engine.launch({ headless: true, ...options });
    try { for (const remember of name === 'WebKit' ? [false] : [false, true]) {
      await run(browser, remember);
      console.log(name === 'WebKit' ? 'PASS WebKit: missing Secure cookie refusal and return to Account (localhost HTTP)' : `PASS ${name}: redirect and rememberMe=${remember}`);
    } }
    finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
