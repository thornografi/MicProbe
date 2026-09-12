// Local support/navigation fixtures. No real microphone, email, sign-in or payment.
const assert = require('node:assert/strict');
const { chromium, firefox, webkit } = require('playwright');
const { createPage, ready } = require('./account-browser-runner.cjs');
const BASE = 'http://localhost:8080';

async function supportPage(browser) {
  const f = await createPage(browser);
  try {
    await f.context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: {
      async writeText(value) {
        if (window.copyFails) throw new Error('Clipboard unavailable');
        window.copiedSupportText = value;
      }
    } }));
    const { page } = f;
    await page.goto(`${BASE}/contact.html`);
    // Windows WebKit's default Tab policy skips links; validate activation there.
    if (browser.browserType().name() === 'webkit') await page.locator('.skip-link').focus();
    else await page.keyboard.press('Tab');
    assert.equal(await page.locator('.skip-link').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'contact-main');
    await page.getByRole('button', { name: 'Copy email address' }).click();
    await page.waitForFunction(() => document.querySelector('#contactCopyStatus').textContent.includes('copied'));
    assert.equal(await page.evaluate(() => window.copiedSupportText), 'support@micprobe.com');
    await page.getByText('What to include in a support message', { exact: true }).click();
    const copyOutline = page.locator('[data-copy-target="supportTemplate"]');
    await copyOutline.click();
    assert.equal(await page.evaluate(() => window.copiedSupportText), await page.locator('#supportTemplate').inputValue());
    await page.evaluate(() => { window.copyFails = true; });
    await copyOutline.click();
    await page.waitForFunction(() => document.querySelector('#contactCopyStatus').textContent.includes('copy it manually'));
    assert.equal(await page.locator('#supportTemplate').evaluate(node =>
      node === document.activeElement && node.selectionEnd - node.selectionStart === node.value.length), true);
    assert.equal(await copyOutline.isEnabled(), true);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: contact overflow`);
    }
    assert.deepEqual(f.accountRequests, [], 'Contact must work without loading account services');
    assert.equal(await page.evaluate(() => window.__accountTestMicRequests), 0);
    assert.deepEqual(f.pageErrors, []);
  } finally { await f.context.close(); }
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(`${BASE}/contact.html`);
    assert.equal(await page.locator('#supportEmail').isVisible(), true);
    assert.equal(await page.locator('[data-copy-target="supportEmail"]').isVisible(), false);
    await page.getByText('What to include in a support message', { exact: true }).click();
    assert.equal(await page.locator('#supportTemplate').isVisible(), true);
  } finally { await context.close(); }
}

async function preserveRecording(browser) {
  const f = await createPage(browser, { configured: true });
  const { page } = f;
  try {
    await page.goto(BASE);
    if (browser.browserType().name() === 'webkit') await page.locator('#skipToContent').focus();
    else await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'landing-main');
    await page.locator('#heroLaunchBtn').click(); await ready(page);
    await page.locator('#skipToContent').press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'scenarioPickerTitle');
    await page.locator('#scenarioChoices [data-profile="raw"]').click();
    await page.locator('#skipToContent').press('Enter');
    assert.equal(await page.locator('#scenarioWorkspace h1').evaluate(node => node === document.activeElement), true);
    const original = await page.evaluate(async () => {
      const { createWavBlob } = await import('/js/modules/utils/wav.js');
      const { EVENTS } = await import('/js/modules/constants.js');
      (await import('/js/modules/EventBus.js')).default.emit(EVENTS.RECORDING_COMPLETED, {
        blob: await createWavBlob([new Float32Array(48000)], 48000, 1), mimeType: 'audio/wav', filename: 'support-test.wav', durationMs: 1000,
        runSnapshot: { runId: 'support-fixture', profileLabel: 'Voice recording' }
      });
      return document.getElementById('downloadBtn').href;
    });
    assert.match(original, /^blob:/);
    for (const path of ['/contact.html', '/privacy.html', '/terms.html']) {
      const popupPromise = page.waitForEvent('popup');
      await page.locator(`.site-footer-links a[href="${path}"]`).click();
      const popup = await popupPromise;
      await popup.waitForLoadState();
      assert.equal(new URL(popup.url()).pathname, path);
      assert.equal(await popup.evaluate(() => window.opener === null), true);
      assert.equal(new URL(page.url()).pathname, '/app');
      assert.equal(await page.locator('#downloadBtn').getAttribute('href'), original);
      assert.equal(await page.locator('#downloadBtn').isEnabled(), true);
      await popup.close();
    }
    await page.goto(`${BASE}/app#premium`); await ready(page);
    await page.locator('#accountIdentity .checkout-notice').waitFor({ state: 'visible' });
    assert.match(await page.locator('#accountIdentity .checkout-notice').innerText(), /not the recording/);
    assert.equal(f.mutations.filter(path => path.endsWith('/checkout')).length, 0);
    assert.deepEqual(f.pageErrors, []);
  } finally { await f.context.close(); }
}

(async () => {
  for (const name of process.argv.includes('--all-browsers') ? ['chrome', 'firefox', 'webkit'] : ['chrome']) {
    const browser = await ({ chrome: chromium, firefox, webkit })[name].launch({ headless: true, ...(name === 'chrome' ? { channel: 'chrome' } : {}) });
    try {
      await supportPage(browser); await preserveRecording(browser);
      console.log(`PASS ${name}: contact copy/fallback/no-JS, skip navigation, recording preservation and checkout notice`);
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
