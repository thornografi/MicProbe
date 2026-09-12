// Account journeys in isolated contexts; provider, photo and billing responses are fixtures.
const { chromium, firefox, webkit } = require('playwright');
const assert = require('node:assert/strict');
const { readFileSync, existsSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { createPage } = require('./account-browser-runner.cjs');
const BASE = 'http://localhost:8080';
const PHOTO = 'https://lh3.googleusercontent.com/account-photo-fixture';
const built = process.argv.includes('--built');
const output = resolve('.tmp/account-ux');
const assets = resolve('.tmp/cloudflare-dev-assets');
// The user's source server may predate this change. Use the current server's
// actual policy, including its image allowlist, without restarting that process.
const policy = readFileSync(resolve('server.js'), 'utf8').match(/const CSP_POLICY = \[([\s\S]*?)\]\.join/)[1]
  .trim().split(/,\s*\r?\n/).map(line => JSON.parse(line.trim())).join('; ');
mkdirSync(output, { recursive: true });

async function fixture(browser, options = {}) {
  const f = await createPage(browser, { configured: true, ...options });
  const requests = [];
  f.page.on('request', request => requests.push(request.url()));
  await f.page.route(url => url.origin === BASE && !url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url());
    const entry = url.pathname === '/' ? '/index.html' : /^\/app\/?$/.test(url.pathname) ? '/app.html' : url.pathname;
    const path = resolve(assets, '.' + entry);
    if (built && path.startsWith(assets) && existsSync(path)) {
      return route.fulfill({ path, headers: { 'Content-Security-Policy': policy } });
    }
    if (route.request().isNavigationRequest()) {
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } });
    }
    return route.fallback();
  });
  await f.page.route(PHOTO, route => {
    assert.equal(route.request().headers().referer, undefined, 'Photo requests omit the page referrer');
    return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#9a82ff"/></svg>' });
  });
  const ready = () => f.page.waitForFunction(() => document.body.classList.contains('app-mode')
    && document.getElementById('accountMenuBtn').getAttribute('aria-busy') === 'false');
  return { ...f, requests, ready };
}

async function signedInJourney(browser, name) {
  const f = await fixture(browser, { signedIn: true, userName: 'Çağrı İleri', userPicture: PHOTO });
  const { page } = f;
  try {
    await page.goto(BASE);
    await page.waitForFunction(() => document.getElementById('landingAccountBtn').getAttribute('aria-busy') === 'false');
    await page.locator('#landingAccountBtn img').waitFor();
    assert.equal(await page.locator('#landingAccountBtn .account-avatar').textContent(), 'Çİ');
    assert.equal(await page.locator('#landingAccountBtn img').evaluate(img => img.complete && img.naturalWidth > 0), true);
    assert.equal(await page.locator('#pricingPremiumCta').textContent(), 'Open saved reports');
    assert.ok(!f.requests.some(url => /\/js\/app\.js|\/assets\/app-|\/api\/account\/reports|accounts.google.com/.test(url)),
      'Landing loads identity without the microphone app, archive or Google SDK');
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const menu = page.locator('#mobileMenuBtn');
      if (await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
      assert.equal(await page.locator('#landingAccountBtn').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `Landing fits ${width}px`);
      if (name === 'chrome' && [1440, 390].includes(width)) await page.screenshot({ path: resolve(output, `landing-${width}${built ? '-built' : ''}.png`) });
      if (await menu.isVisible()) await menu.click();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#pricingPremiumCta').click(); await f.ready();
    await page.locator('#accountReports').waitFor({ state: 'visible' });
    assert.equal(new URL(page.url()).hash, '#reports');
    await page.getByRole('tab', { name: 'Account', exact: true }).click();
    assert.equal(new URL(page.url()).hash, '#account');
    await page.keyboard.press('Escape'); await page.waitForURL(BASE + '/app');
    await page.goBack(); await page.waitForURL(BASE + '/');
    await page.goForward(); await f.ready();
    assert.equal(await page.locator('#accountDialog').isVisible(), false);
    await page.goto(BASE + '/app#reports'); await f.ready();
    await page.locator('#accountReports').waitFor({ state: 'visible' });
    await page.reload(); await f.ready();
    await page.locator('#accountReports').waitFor({ state: 'visible' });
    await page.getByRole('tab', { name: 'Account', exact: true }).click();
    await page.locator('#accountIdentity img').waitFor();
    if (name === 'chrome') await page.screenshot({ path: resolve(output, `account${built ? '-built' : ''}.png`) });
    assert.deepEqual(f.mutations, []);
    assert.deepEqual(f.pageErrors, []);
  } finally { await f.context.close(); }
}

async function guestJourney(browser) {
  const f = await fixture(browser), { page } = f;
  try {
    await page.goto(BASE);
    await page.locator('#landingAccountBtn[aria-label="Sign in"]').waitFor();
    await page.locator('#landingAccountBtn').click(); await f.ready();
    assert.equal(new URL(page.url()).hash, '#signin');
    assert.equal(await page.getByRole('checkbox', { name: 'Keep me signed in on this device', exact: true }).isChecked(), true);
    assert.equal(await page.locator('#accountRememberHint').textContent(), 'Avoid on shared devices.');
    assert.doesNotMatch(await page.locator('#accountIdentity').innerText(), /\b[25]\b.*tests|requires Premium|Premium saves tests/i);
    await page.getByText('Trouble signing in?', { exact: true }).click();
    assert.equal(await page.locator('#accountIdentity a[href="/contact.html#account"]').isVisible(), true);
    await page.getByRole('button', { name: 'Continue with Google (test fixture)', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('accountDialog').open);
    await page.waitForURL(BASE + '/app');
    assert.deepEqual(f.signInChoices, [true], 'The untouched default requests a persistent Google sign-in');
    assert.equal(await page.locator('#userMessage').isVisible(), false, 'Successful sign-in does not show a toast');
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#scenarioPicker h1')), true);
    assert.ok(!f.mutations.includes('/api/account/checkout'));
    await page.locator('#accountMenuBtn').click();
    await page.getByRole('button', { name: 'Switch account', exact: true }).click();
    await page.getByRole('button', { name: 'Continue with Google (test fixture)', exact: true }).waitFor();
    assert.match(await page.locator('#accountIdentity').textContent(), /Use another account/);
    assert.equal(new URL(page.url()).hash, '#switch-account');
    assert.ok(!f.mutations.includes('/api/account/logout'), 'Opening the chooser keeps the current account');
    assert.deepEqual(f.pageErrors, []);
  } finally { await f.context.close(); }
}

async function switchJourney(browser) {
  const f = await fixture(browser, { signedIn: true }), { page } = f;
  const state = () => page.evaluate(async () => ({
    account: (await import('/js/modules/AccountAccess.js')).default.getState(),
    report: (await import('/js/ui/ReportPanelUI.js')).default.currentReport
  }));
  const choose = () => page.getByRole('button', { name: 'Continue with Google (test fixture)', exact: true }).click();
  const openSwitch = async () => {
    if (!await page.locator('#accountDialog').isVisible()) await page.locator('#accountMenuBtn').click();
    await page.getByRole('button', { name: 'Switch account', exact: true }).click();
    await page.getByRole('button', { name: 'Continue with Google (test fixture)', exact: true }).waitFor();
  };
  try {
    await page.goto(BASE + '/app'); await f.ready();
    await page.evaluate(async () => {
      (await import('/js/ui/ReportPanelUI.js')).default.currentReport = { run: { id: 'account-a-current-report' } };
    });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await openSwitch();
      assert.match(await page.locator('#accountIdentity').innerText(), /Use another account/);
      assert.equal((await state()).account.user.id, 'fixture-account-A');
      assert.equal((await state()).account.premium.unlocked, true);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.evaluate(() => window.__googleFixture.buttonCallback());
      assert.equal((await state()).report.run.id, 'account-a-current-report');
      assert.ok(!f.mutations.includes('/api/account/google/switch'), 'Cancellation ignores the old Google callback');
      await openSwitch(); await page.keyboard.press('Escape');
      assert.equal((await state()).account.user.id, 'fixture-account-A');
      assert.equal((await state()).report.run.id, 'account-a-current-report');
    }
    await openSwitch();
    const initializations = await page.evaluate(() => window.__googleFixture.initializations);
    await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.refresh({ sessionOnly: true }));
    assert.equal(await page.evaluate(() => window.__googleFixture.initializations), initializations,
      'Returning from Google verification keeps the current chooser');
    assert.equal(await page.locator('#accountDialogTitle').textContent(), 'Switch account');
    f.setNextAccount('fixture-account-A'); await choose();
    await page.waitForFunction(() => !document.getElementById('accountDialog').open);
    assert.equal((await state()).report.run.id, 'account-a-current-report');
    assert.equal((await state()).account.premium.unlocked, true);
    await openSwitch();
    const fail = route => route.fulfill({ status: 503, json: { ok: false, error: 'google_temporarily_unavailable' } });
    await page.route('**/api/account/google/switch', fail);
    await choose(); await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
    assert.equal((await state()).account.user.id, 'fixture-account-A');
    assert.equal((await state()).report.run.id, 'account-a-current-report');
    await page.unroute('**/api/account/google/switch', fail);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    f.setNextAccount('fixture-account-B');
    let release;
    const delay = async route => { await new Promise(resolve => { release = resolve; }); await route.fallback(); };
    await page.route('**/api/account/google/switch', delay);
    const request = page.waitForRequest('**/api/account/google/switch');
    await choose(); await request;
    assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
    assert.equal((await state()).account.user.id, 'fixture-account-A', 'Verification keeps A until the response commits');
    assert.equal((await state()).report.run.id, 'account-a-current-report');
    release();
    await page.waitForFunction(() => !document.getElementById('accountDialog').open);
    const switched = await state();
    assert.equal(switched.account.user.id, 'fixture-account-B');
    assert.equal(switched.account.premium.unlocked, false);
    assert.equal(switched.report, null, 'A report is not exposed under B');
    assert.ok(!f.mutations.includes('/api/account/logout'));
    assert.deepEqual(f.pageErrors, []);
  } finally { await f.context.close(); }
}

async function fallbackAndPlans(browser) {
  for (const variant of ['free', 'pending', 'offline', 'broken-photo', 'unsafe-photo', 'blank-name']) {
    const f = await fixture(browser, { signedIn: true, purchaseLinked: variant !== 'free', purchasePending: variant === 'pending',
      userName: variant === 'blank-name' ? '   ' : 'Single', userPicture: variant === 'broken-photo' ? PHOTO : variant === 'unsafe-photo' ? 'https://example.com/track-photo' : '' });
    const { page } = f;
    try {
      if (variant === 'offline') f.setSessionUnavailable(true);
      if (variant === 'broken-photo') await page.route(PHOTO, route => route.abort());
      await page.goto(BASE);
      await page.waitForFunction(() => document.getElementById('landingAccountBtn').getAttribute('aria-busy') === 'false');
      if (variant !== 'offline') {
        assert.equal(await page.locator('#landingAccountBtn .account-avatar').textContent(), variant === 'blank-name' ? 'F' : 'S');
        await page.waitForFunction(() => !document.querySelector('#landingAccountBtn img'));
      }
      assert.ok(!f.requests.includes('https://example.com/track-photo'));
      const cta = await page.locator('#pricingPremiumCta').textContent();
      assert.equal(cta, ['pending', 'offline'].includes(variant) ? 'Review your account' : variant === 'free' ? 'Get Lifetime Premium' : 'Open saved reports');
      if (variant === 'free') {
        f.clearReports();
        await page.goto(BASE + '/app#reports'); await f.ready();
        await page.locator('#accountIdentity').getByRole('button', { name: 'Get Lifetime Premium', exact: true }).click();
        await page.waitForURL('https://checkout.freemius.com/**');
      }
      assert.deepEqual(f.pageErrors, []);
    } finally { await f.context.close(); }
  }
}

(async () => {
  for (const name of process.argv.includes('--all-browsers') ? ['chrome', 'firefox', 'webkit'] : ['chrome']) {
    const browser = await ({ chrome: chromium, firefox, webkit })[name].launch({ headless: true, ...(name === 'chrome' ? { channel: 'chrome' } : {}) });
    try {
      await signedInJourney(browser, name); await guestJourney(browser); await fallbackAndPlans(browser);
      if (!built) await switchJourney(browser);
      console.log(`PASS ${name} ${built ? 'compiled' : 'source'}: account entry, avatar/CSP/fallback, responsive navigation, intended return, switch account and plan CTAs`);
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
