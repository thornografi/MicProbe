// Isolated provider fixtures; no real portal token, Google sign-in or payment is created.
const { chromium, firefox, webkit } = require('playwright');
const assert = require('node:assert/strict');
const { createPage, ready } = require('./account-browser-runner.cjs');
const BASE = 'http://localhost:8080';
const PORTAL = 'https://customers.freemius.com/login/?token=portal-fixture-secret';

async function fixture(browser, options = {}) {
  const env = await createPage(browser, { signedIn: true, ...options });
  const { page } = env;
  let error, confirmError, redirect = PORTAL, gate, release, started;
  const requests = [], confirmations = [];
  let visits = 0;
  await env.context.addInitScript(() => {
    const store = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (String(value).includes('portal-fixture-secret')) throw new Error('Portal credentials must never be stored');
      return store.call(this, key, value);
    };
  });
  await page.route('https://customers.freemius.com/**', route => {
    visits++;
    return route.fulfill({ contentType: 'text/html', body: '<h1>Purchase management fixture</h1>' });
  });
  await page.route('**/api/account/portal', async route => {
    const request = route.request();
    assert.equal(request.method(), 'POST');
    assert.equal(request.headers()['x-micprobe-account'], 'fixture-account-A');
    assert.deepEqual(request.postDataJSON(), {});
    requests.push(request.url()); started?.();
    if (gate) await gate;
    await route.fulfill({ status: error ? (error === 'billing_temporarily_unavailable' ? 503 : 403) : 200,
      json: error ? { ok: false, error } : { ok: true, url: redirect } });
  });
  await page.route('**/api/account/google/confirm', async route => {
    assert.equal(route.request().headers()['x-micprobe-account'], 'fixture-account-A');
    const body = route.request().postDataJSON(); confirmations.push(body);
    assert.deepEqual(body, { credential: 'synthetic-google-credential' });
    if (!confirmError) error = null;
    await route.fulfill({ status: confirmError ? 403 : 200,
      json: confirmError ? { ok: false, error: confirmError } : { ok: true } });
  });
  await page.goto(`${BASE}/app`); await ready(page);
  await page.evaluate(async () => {
    const Panel = (await import('/js/ui/AccountPanelUI.js')).default;
    const open = Panel.prototype.openPurchasePortal;
    Panel.prototype.openPurchasePortal = function(...args) {
      window.__portalFinished = false;
      const pending = open.apply(this, args);
      pending.finally(() => { window.__portalFinished = true; });
      return pending;
    };
  });
  await page.locator('#accountMenuBtn').click();
  return { ...env, requests, confirmations, visits: () => visits,
    setError: value => { error = value; }, setConfirmError: value => { confirmError = value; },
    setRedirect: value => { redirect = value; },
    hold: () => { gate = new Promise(resolve => { release = resolve; }); return new Promise(resolve => { started = resolve; }); },
    release: () => { release?.(); },
    settle: () => page.waitForFunction(() => window.__portalFinished === true) };
}

async function success(browser) {
  const f = await fixture(browser), { page } = f;
  try {
    assert.equal(f.requests.length, 0, 'Rendering an account must not mint a portal session');
    const started = f.hold();
    await page.getByRole('button', { name: 'Manage purchase', exact: true }).click();
    await started;
    assert.equal(await page.getByRole('button', { name: 'Manage purchase', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Manage purchase', exact: true }).evaluate(node => node.dispatchEvent(new MouseEvent('click')));
    assert.equal(f.requests.length, 1, 'Concurrent clicks share the pending operation');
    f.release(); await page.waitForURL(PORTAL);
    assert.equal(f.visits(), 1); assert.equal(f.confirmations.length, 0);
    assert.deepEqual(f.pageErrors, []);
  } finally { await f.context.close(); }
}

async function confirmation(browser, wrongAccount = false) {
  const f = await fixture(browser), { page } = f;
  try {
    f.setError('portal_confirmation_required');
    await page.getByRole('button', { name: 'Manage purchase', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm with Google', exact: true }).click();
    const google = page.getByRole('button', { name: 'Continue with Google (test fixture)', exact: true });
    await google.waitFor();
    const before = await page.evaluate(() => window.__googleFixture.initializations);
    await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.refresh({ sessionOnly: true }));
    assert.equal(await page.evaluate(() => window.__googleFixture.initializations), before);
    if (wrongAccount) f.setConfirmError('portal_account_mismatch');
    await google.click();
    if (wrongAccount) {
      await page.locator('.account-portal-help [role="alert"]').getByText(/same Google account/).waitFor();
      assert.equal(f.visits(), 0); assert.equal(f.requests.length, 1);
      assert.equal(await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.getState().user.id), 'fixture-account-A');
      f.setConfirmError(null);
      await page.getByRole('button', { name: 'Confirm with Google', exact: true }).click();
      await google.click();
    }
    await page.waitForURL(PORTAL);
    assert.equal(f.requests.length, 2); assert.equal(f.confirmations.length, wrongAccount ? 2 : 1);
    assert.deepEqual(f.signInChoices, [], 'Confirmation must not create a new browser session');
    assert.deepEqual(f.pageErrors, []);
  } finally { await f.context.close(); }
}

async function supersededConfirmation(browser) {
  const f = await fixture(browser), { page } = f;
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    f.setError('portal_confirmation_required');
    const manage = page.getByRole('button', { name: 'Manage purchase', exact: true });
    await manage.click();
    await page.getByRole('button', { name: 'Confirm with Google', exact: true }).click();
    const google = page.getByRole('button', { name: 'Continue with Google (test fixture)', exact: true });
    await google.waitFor();
    await page.evaluate(() => { window.__oldPortalConfirmation = globalThis.google.accounts.id.options.callback; });
    await manage.click();
    await page.locator('.account-portal-help [role="alert"]').waitFor();
    await page.evaluate(() => window.__oldPortalConfirmation({ credential: 'synthetic-google-credential' }));
    assert.equal(f.confirmations.length, 0, 'Retrying management invalidates the previous Google consent');
    assert.equal(f.visits(), 0);
    assert.equal(await page.locator('#accountDialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.getByRole('button', { name: 'Confirm with Google', exact: true }).click();
    await google.click(); await page.waitForURL(PORTAL);
    assert.equal(f.requests.length, 3); assert.equal(f.confirmations.length, 1);
    assert.deepEqual(f.pageErrors, []);
  } finally { await f.context.close(); }
}

async function failure(browser, error) {
  const f = await fixture(browser), { page } = f;
  try {
    if (error === 'invalid_redirect') f.setRedirect('https://checkout.freemius.com/should-not-open');
    else f.setError(error);
    await page.getByRole('button', { name: 'Manage purchase', exact: true }).click();
    const help = page.locator('.account-portal-help');
    await help.getByRole('alert').waitFor();
    assert.equal(await help.getByRole('link', { name: 'Sign in to Freemius (opens in a new tab)', exact: true }).getAttribute('href'), 'https://customers.freemius.com/login/');
    assert.equal(await help.getByRole('link', { name: 'Contact support', exact: true }).getAttribute('href'), 'mailto:support@micprobe.com');
    assert.equal(f.visits(), 0); assert.match(page.url(), /^http:\/\/localhost:8080/);
    assert.equal(await page.getByRole('button', { name: 'Manage purchase', exact: true }).isEnabled(), true);
    assert.equal(await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.getState().premium.unlocked), true);
    f.setError(null); f.setRedirect(PORTAL);
    await page.getByRole('button', { name: 'Manage purchase', exact: true }).click();
    await page.waitForURL(PORTAL);
    assert.deepEqual(f.pageErrors, []);
  } finally { await f.context.close(); }
}

async function cancelled(browser, action) {
  const f = await fixture(browser), { page } = f;
  try {
    const started = f.hold();
    await page.getByRole('button', { name: 'Manage purchase', exact: true }).click(); await started;
    if (action === 'tab') await page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
    else if (action === 'close') await page.getByRole('button', { name: 'Close account', exact: true }).click();
    else await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    f.release(); await f.settle();
    assert.equal(f.visits(), 0); assert.match(page.url(), /^http:\/\/localhost:8080/);
    assert.deepEqual(f.pageErrors, []);
  } finally { await f.context.close(); }
}

async function purchaseStatus(browser, variant) {
  const f = await fixture(browser, { purchasePending: variant === 'pending', purchaseLinked: variant !== 'never-purchased' });
  const { page } = f;
  try {
    if (variant !== 'pending') f.setPremiumUnlocked(false);
    if (variant === 'connection-error') f.setSessionUnavailable(true);
    await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.refresh({ sessionOnly: true }));
    assert.equal(await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.getState().premium.unlocked), false);
    const manage = page.getByRole('button', { name: 'Manage purchase', exact: true });
    if (variant === 'never-purchased') {
      assert.equal(await manage.count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Get Lifetime Premium', exact: true }).count(), 1);
      assert.equal(f.requests.length, 0);
    } else {
      assert.equal(await manage.count(), 1);
      if (variant === 'pending' || variant === 'connection-error') {
        assert.equal(await page.getByRole('button', { name: 'Get Lifetime Premium', exact: true }).count(), 0);
      }
      // Use the fallback first to inspect entitlement after a management failure.
      f.setError('billing_temporarily_unavailable');
      await manage.click();
      await page.locator('.account-portal-help').getByRole('alert').waitFor();
      assert.equal(await page.locator('.account-portal-help').getByRole('link', { name: 'Sign in to Freemius (opens in a new tab)', exact: true }).count(), 1);
      assert.equal(await page.evaluate(async () => (await import('/js/modules/AccountAccess.js')).default.getState().premium.unlocked), false);
      f.setError(null);
      await manage.click(); await page.waitForURL(PORTAL);
      assert.equal(f.requests.length, 2);
    }
    assert.deepEqual(f.pageErrors, []);
  } finally { await f.context.close(); }
}

async function runPortalFlows(browser) {
  await success(browser); await confirmation(browser); await confirmation(browser, true);
  await supersededConfirmation(browser);
  for (const error of ['portal_owner_mismatch', 'portal_identity_unverified', 'billing_temporarily_unavailable', 'invalid_redirect']) await failure(browser, error);
  for (const action of ['tab', 'close', 'logout']) await cancelled(browser, action);
  for (const variant of ['inactive', 'pending', 'connection-error', 'never-purchased']) await purchaseStatus(browser, variant);
}

async function main() {
  const names = process.argv.includes('--all-browsers') ? ['chrome', 'firefox', 'webkit'] : ['chrome'];
  for (const name of names) {
    const browser = await ({ chrome: chromium, firefox, webkit })[name].launch({ headless: true, ...(name === 'chrome' ? { channel: 'chrome' } : {}) });
    try {
      await runPortalFlows(browser);
      console.log(JSON.stringify({ browser: name, status: 'passed', cases: 15, realPortalLogin: false }));
    } finally { await browser.close(); }
  }
}
module.exports = { runPortalFlows };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
