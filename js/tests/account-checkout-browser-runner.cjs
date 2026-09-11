// Purchase-window regressions use only local account/provider fixtures.
const assert = require('node:assert/strict');
const { chromium, firefox, webkit } = require('playwright');
const { createPage, ready } = require('./account-browser-runner.cjs');
const BASE = 'http://localhost:8080';

async function open(f) {
  await f.page.goto(`${BASE}/app`); await ready(f.page);
  await f.page.locator('#accountMenuBtn').click();
}
async function settled(page) {
  await page.waitForFunction(async () => !(await import('/js/modules/PremiumAccess.js')).default.checkoutPromise);
}
async function inactivePurchase(browser) {
  const f = await createPage(browser, { signedIn: true });
  try {
    f.setPremiumUnlocked(false); await open(f);
    await f.page.locator('#accountIdentity').getByText('Premium access inactive', { exact: true }).waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'Get Lifetime Premium', exact: true }).count(), 0);
    assert.equal(await f.page.getByRole('button', { name: 'Manage purchase', exact: true }).isVisible(), true);
    const replacement = f.page.getByRole('button', { name: 'Buy a new license', exact: true });
    assert.equal(await replacement.isVisible(), false);
    await f.page.getByText('Need a new purchase?', { exact: true }).click();
    assert.equal(await replacement.isVisible(), true);
    await f.page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
    await f.page.getByRole('button', { name: 'Open report', exact: true }).click();
    await f.page.locator('#premiumCta').getByText('Review purchase', { exact: true }).waitFor();
    await f.page.locator('#premiumCta').click();
    await f.page.getByRole('button', { name: 'Manage purchase', exact: true }).waitFor();
    assert.equal(f.mutations.filter(p => p.endsWith('/checkout')).length, 0);
    assert.deepEqual(f.pageErrors, []);
  } finally { await f.context.close(); }
}
async function checkoutLifecycle(browser, action, surface = 'account') {
  const f = await createPage(browser, { signedIn: true, purchaseLinked: false });
  const { page } = f;
  let release, started, requests = 0, visits = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { started = resolve; });
  try {
    await page.route('https://checkout.freemius.com/**', route => {
      visits++; return route.fulfill({ contentType: 'text/html', body: '<h1>Unexpected checkout</h1>' });
    });
    await page.route('**/api/account/checkout', async route => {
      requests++; started(); await gate;
      await route.fulfill(action === 'duplicate'
        ? { status: 503, json: { ok: false, error: 'billing_temporarily_unavailable' } }
        : { json: { ok: true, checkoutUrl: 'https://checkout.freemius.com/product/123/plan/456/?test=1' } });
    });
    await open(f);
    if (surface === 'report') {
      await page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
      await page.getByRole('button', { name: 'Open report', exact: true }).click();
    }
    const cta = surface === 'report' ? page.locator('#premiumCta')
      : page.locator('#accountDialog').getByRole('button', { name: 'Get Lifetime Premium', exact: true });
    await cta.click(); await received;
    assert.equal(await cta.isDisabled(), true);
    // Even a queued click event must not send a second request.
    await cta.dispatchEvent('click');
    if (action === 'close' || action === 'reopen') {
      await page.getByRole('button', { name: surface === 'account' ? 'Close account' : 'Close report', exact: true }).click();
      if (action === 'reopen') {
        if (surface === 'account') await page.locator('#accountMenuBtn').click();
        else await page.evaluate(async () => (await import('/js/ui/ReportPanelUI.js')).default.open());
      }
    } else if (action === 'tab') await page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
    else if (action === 'logout') await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    else if (action === 'busy') await page.evaluate(async () => {
      const state = await import('/js/app/AppState.js');
      const bus = (await import('/js/modules/EventBus.js')).default;
      const { EVENTS } = await import('/js/modules/constants.js');
      state.setIsPreparing(true); bus.emit(EVENTS.UI_STATE_CHANGED);
      state.setIsPreparing(false); bus.emit(EVENTS.UI_STATE_CHANGED);
    });
    release(); await settled(page);
    assert.equal(requests, 1); assert.equal(visits, 0);
    assert.match(page.url(), /^http:\/\/localhost:8080/);
    if (action === 'duplicate') await page.waitForFunction(surface =>
      [...document.querySelectorAll(surface === 'account' ? '#accountIdentity button' : '#premiumCta')]
        .some(b => b.textContent === 'Get Lifetime Premium' && !b.disabled), surface);
    assert.deepEqual(f.pageErrors, []);
  } finally { release(); await f.context.close(); }
}
async function alreadyPremium(browser) {
  const f = await createPage(browser, { signedIn: true, purchaseLinked: false });
  try {
    let requests = 0;
    await f.page.route('**/api/account/checkout', async route => {
      requests++; f.verifyPurchase();
      await route.fulfill({ status: 409, json: { ok: false, error: 'already_premium' } });
    });
    await open(f); await f.page.getByRole('button', { name: 'Get Lifetime Premium', exact: true }).click();
    await f.page.getByText('Lifetime Premium', { exact: true }).waitFor(); await settled(f.page);
    assert.equal(requests, 1);
    assert.equal(await f.page.getByRole('button', { name: 'Get Lifetime Premium', exact: true }).count(), 0);
    assert.match(await f.page.locator('#accountStatus').innerText(), /No new purchase/);
    assert.deepEqual(f.pageErrors, []);
  } finally { await f.context.close(); }
}
async function unresolvedReturn(browser, surface) {
  const f = await createPage(browser, { signedIn: true, purchaseLinked: false });
  const { page } = f; let fail = true, attempts = 0;
  try {
    await f.context.addInitScript(() => sessionStorage.setItem('micprobe:pending-account-purchase:v1',
      'http://localhost:8080/app?signature=synthetic-signature&checkout_state=synthetic-checkout-state'));
    await page.route('**/api/account/purchase', async route => {
      attempts++;
      if (fail) await route.fulfill({ status: 503, json: { ok: false, error: 'billing_temporarily_unavailable' } });
      else { f.verifyPurchase(); await route.fulfill({ json: { ok: true, premium: { unlocked: true } } }); }
    });
    await open(f);
    await page.evaluate(async () => (await import('/js/modules/PremiumAccess.js')).default.bootstrap());
    if (surface === 'report') {
      await page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
      await page.getByRole('button', { name: 'Open report', exact: true }).click();
    }
    const panel = page.locator(surface === 'report' ? '#reportPanel' : '#accountDialog');
    const retry = panel.getByRole('button', { name: 'Retry purchase verification', exact: true });
    await retry.waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Get Lifetime Premium', exact: true }).count(), 0);
    assert.doesNotMatch(await panel.innerText(), /Your purchase is linked/);
    const before = attempts; fail = false; await retry.click();
    await page.waitForFunction(async () => (await import('/js/modules/PremiumAccess.js')).default.isUnlocked());
    await page.evaluate(async () => (await import('/js/modules/PremiumAccess.js')).default.purchasePromise);
    assert.equal(attempts, before + 1);
    assert.equal(f.mutations.filter(p => p.endsWith('/checkout')).length, 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('micprobe:pending-account-purchase:v1')), null);
    assert.deepEqual(f.pageErrors, []);
  } finally { await f.context.close(); }
}
async function linkedOffline(browser) {
  const f = await createPage(browser, { signedIn: true, purchaseLinked: false });
  try {
    await f.page.route('**/api/account/restore', async route => {
      f.setSessionUnavailable(true);
      await route.fulfill({ json: { ok: true, premium: { unlocked: true } } });
    });
    await open(f);
    await f.page.getByText('Link an earlier purchase', { exact: true }).click();
    await f.page.getByLabel('License key from your purchase email', { exact: true }).fill('synthetic-license');
    await f.page.getByRole('button', { name: 'Link purchase', exact: true }).click();
    await f.page.getByText('Your purchase was linked. Retry account connection to confirm Premium access.', { exact: true }).waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'Manage purchase', exact: true }).isVisible(), true);
    assert.equal(await f.page.getByRole('button', { name: 'Get Lifetime Premium', exact: true }).count(), 0);
    assert.deepEqual(f.pageErrors, []);
  } finally { await f.context.close(); }
}
async function runCheckoutFlows(browser) {
  await inactivePurchase(browser); await alreadyPremium(browser); await linkedOffline(browser);
  for (const surface of ['account', 'report']) await unresolvedReturn(browser, surface);
  for (const action of ['duplicate', 'close', 'reopen', 'tab', 'logout', 'busy']) await checkoutLifecycle(browser, action);
  for (const action of ['duplicate', 'close', 'reopen', 'busy']) await checkoutLifecycle(browser, action, 'report');
  console.log('PASS purchase-window states, unresolved returns, checkout concurrency and cancellation');
}
module.exports = { runCheckoutFlows };
if (require.main === module) (async () => {
  for (const name of process.argv.includes('--all-browsers') ? ['chrome', 'firefox', 'webkit'] : ['chrome']) {
    const browser = await ({ chrome: chromium, firefox, webkit })[name].launch({ headless: true, ...(name === 'chrome' ? { channel: 'chrome' } : {}) });
    try { await runCheckoutFlows(browser); console.log(JSON.stringify({ browser: name, cases: 15, status: 'passed' })); }
    finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
