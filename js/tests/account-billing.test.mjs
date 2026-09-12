import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createNodeAccountDb } from '../../server/node-account-db.mjs';
import { createAccountService } from '../../server/account-service.mjs';
import { createAccountBilling } from '../../server/account-billing.mjs';

const origin = 'https://micprobe.example';
const config = { mode: 'production', productId: '33850', planId: '55641',
  productSecret: 'test-product-secret', apiToken: 'test-api-token' };
const canonical = { id: '101', plugin_id: '33850', plan_id: '55641', user_id: '202',
  environment: 0, is_cancelled: false, expiration: null, secret_key: 'sk_full-private-test-key' };

async function fixture(t) {
  const db = createNodeAccountDb(':memory:');
  t.after(() => db.close());
  for (const id of ['alice', 'bob']) {
    await db.prepare('INSERT INTO accounts (id,google_sub,email,name,created_at,updated_at,email_authoritative,google_verified_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(id, id, `${id}@gmail.com`, id, Date.now(), Date.now(), 1, Date.now()).run();
    const hash = createHash('sha256').update(id.repeat(43).slice(0, 43)).digest('base64url');
    await db.prepare('INSERT INTO account_sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)')
      .bind(hash, id, Date.now(), Date.now() + 100000).run();
  }
  const accounts = createAccountService({ db, googleClientId: 'web-client', mode: 'production', origin });
  let license = { ...canonical };
  let buyer = { id: '202', email: 'buyer@company.example' };
  let unavailable = false;
  let portalReply = { link: 'https://customers.freemius.com/secure-example', token: 'fixture-secret-token' };
  let beforeResponse = async () => {};
  const calls = [];
  const billing = createAccountBilling({ accounts, config, enabled: true,
    checkoutUrl: 'https://checkout.freemius.com/product/33850/plan/55641/',
    evaluatePremiumReport: report => ({ reportId: report.run.id }),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      assert.equal(options.headers.Authorization, 'Bearer test-api-token');
      await beforeResponse(String(url), options);
      if (unavailable) return new Response('{}', { status: 503 });
      if (String(url).includes('/users/')) return Response.json(buyer);
      if (String(url).includes('/portal/')) return Response.json(portalReply, { status: 201 });
      if (String(url).includes('/licenses.json')) return Response.json({ licenses: [license] });
      return Response.json(license);
    }
  });
  const request = (path, body = {}, user = 'alice', extraHeaders = {}) => new Request(origin + path, {
    method: 'POST', headers: { Origin: origin, 'X-MicProbe-Request': '1', 'X-MicProbe-Account': user, 'Content-Type': 'application/json',
      Cookie: `micprobe_session=${user.repeat(43).slice(0, 43)}`, ...extraHeaders }, body: JSON.stringify(body)
  });
  const call = async (...args) => {
    if (args[1]?.report) args[1].report = { version: '2.0', generatedAt: '2026-09-11T12:00:00Z', ...args[1].report,
      run: { id: 'billing-fixture', type: 'record', ...args[1].report.run } };
    const response = await billing.handle(request(...args));
    return { status: response.status, body: await response.json() };
  };
  const redirect = async (user = 'alice') => {
    const state = await accounts.createCheckout(user);
    const url = `${origin}/app?checkout_state=${state}&license_id=101&user_id=202&plan_id=55641`;
    return `${url}&signature=${createHmac('sha256', config.productSecret).update(url).digest('hex')}`;
  };
  return { db, accounts, billing, call, redirect, calls, request,
    setLicense: value => { license = { ...canonical, ...value }; },
    setBuyer: value => { buyer = { ...buyer, ...value }; },
    setPortalReply: value => { portalReply = value; },
    beforeResponse: action => { beforeResponse = action; },
    outage: value => { unavailable = value; } };
}

test('account checkout needs the browser session and CSRF proof, always purchases lifetime', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/account/checkout', {}, 'nobody')).status, 401);
  assert.equal((await f.call('/api/account/checkout', {}, 'alice', { Origin: 'https://other.example' })).status, 403);
  const result = await f.call('/api/account/checkout');
  assert.equal(result.status, 200);
  const url = new URL(result.body.checkoutUrl);
  assert.equal(url.searchParams.get('billing_cycle'), 'lifetime');
  assert.equal(url.searchParams.get('user_email'), 'alice@gmail.com');
  assert.equal(url.searchParams.get('readonly_user'), 'true');
  const success = new URL(url.searchParams.get('success_url'));
  assert.equal(success.origin, origin);
  assert.ok(await f.accounts.getCheckout(success.searchParams.get('checkout_state'), 'alice'));
  assert.equal(await f.accounts.getCheckout(success.searchParams.get('checkout_state'), 'bob'), null);
});

test('account checkout never creates an intent if canonical product or provider credentials are missing', async t => {
  const f = await fixture(t);
  for (const field of ['productId', 'apiToken', 'productSecret']) {
    const billing = createAccountBilling({ accounts: f.accounts, config: { ...config, [field]: '' }, enabled: true,
      checkoutUrl: 'https://checkout.freemius.com/product/33850/plan/55641/', evaluatePremiumReport: () => ({}) });
    const response = await billing.handle(f.request('/api/account/checkout'));
    assert.equal(response.status, 503, field);
    assert.equal((await response.json()).error, 'billing_not_configured');
  }
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM account_checkouts').first()).n, 0);
});

test('stale account headers cannot purchase, restore, access billing, or request premium details with another account cookie', async t => {
  const f = await fixture(t);
  for (const expected of ['alice', '', 'anonymous']) {
    for (const path of ['/api/account/checkout', '/api/account/purchase', '/api/account/restore', '/api/account/portal', '/api/account/purchase/recheck', '/api/report/detailed']) {
      const result = await f.call(path, { report: { run: { id: 'alice-private' }, audioMetrics: {} } }, 'bob', { 'X-MicProbe-Account': expected });
      assert.equal(result.status, 409);
      assert.equal(result.body.error, 'account_changed');
    }
  }
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM account_checkouts').first()).n, 0);
  assert.equal(f.calls.length, 0);
});

async function recoveryFixture(t, beforeCheckout = async () => {}) {
  const f = await fixture(t);
  const started = Math.ceil(Date.now() / 1000) * 1000 + 1000;
  let now = started;
  t.mock.method(Date, 'now', () => now);
  await beforeCheckout(f, started);
  f.setBuyer({ email: 'alice@gmail.com' });
  const checkout = await f.call('/api/account/checkout', { email: 'not-the-server-user@gmail.com' });
  assert.equal(checkout.status, 200);
  const url = new URL(checkout.body.checkoutUrl);
  assert.equal(url.searchParams.get('user_email'), 'alice@gmail.com');
  const state = new URL(url.searchParams.get('success_url')).searchParams.get('checkout_state');
  f.setLicense({ created: new Date(started + 2000).toISOString().slice(0, 19).replace('T', ' ') });
  now = started + 3000;
  const event = { type: 'license.created', objects: { license: { id: '101', created: 'untrusted-event-snapshot' } } };
  const signature = createHmac('sha256', config.productSecret).update(JSON.stringify(event)).digest('hex');
  return { ...f, started, state,
    clock: value => { now = value; },
    deliver: () => f.call('/api/freemius/webhook', event, 'alice', { 'x-signature': signature }),
    signedRedirect: (includeState = true) => {
      const raw = `${origin}/app?${includeState ? `checkout_state=${state}&` : ''}license_id=101&user_id=202&plan_id=55641`;
      return `${raw}&signature=${createHmac('sha256', config.productSecret).update(raw).digest('hex')}`;
    }
  };
}

test('a signed webhook recovers a lost redirect for a new purchase with one fresh Google-authoritative email owner', async t => {
  const f = await recoveryFixture(t);
  assert.equal(await f.accounts.getLicense('alice'), null);
  const pending = await f.db.prepare('SELECT recovery_email, recovery_verified_at FROM account_checkouts WHERE user_id = ?').bind('alice').first();
  assert.equal(pending.recovery_email, 'alice@gmail.com');
  assert.ok(pending.recovery_verified_at <= f.started);
  assert.equal((await f.deliver()).status, 200);
  assert.equal((await f.accounts.getLicense('alice')).licenseId, '101');
  assert.equal((await f.accounts.getCheckout(f.state, 'alice')).licenseId, '101');
  assert.equal(await f.accounts.getLicense('bob'), null);
  assert.ok(f.calls.some(call => call.url.includes('/users/202.json')));
});

test('a hosted return without checkout_state links its verified account before any webhook and tolerates retries', async t => {
  const f = await recoveryFixture(t);
  const body = { url: f.signedRedirect(false) };
  assert.equal((await f.call('/api/account/purchase', body)).body.premium.unlocked, true);
  assert.equal((await f.accounts.getLicenseById('101')).userId, 'alice');
  assert.equal((await f.call('/api/account/purchase', body)).status, 200);
  assert.equal((await f.deliver()).status, 200);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM account_licenses').first()).n, 1);
  f.setLicense({ is_cancelled: true });
  assert.equal((await f.call('/api/account/purchase', body)).body.premium.unlocked, false);
});

test('a hosted return cannot attach a purchase to another session or mutate its actual owner before verification', async t => {
  const f = await recoveryFixture(t);
  const body = { url: f.signedRedirect(false) };
  assert.equal((await f.call('/api/account/purchase', body, 'bob')).status, 409);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM account_licenses').first()).n, 0);
  assert.equal((await f.call('/api/account/purchase', { url: body.url.replace('license_id=101', 'license_id=102') })).status, 403);
  assert.equal((await f.call('/api/account/purchase', body)).status, 200);
  assert.equal((await f.call('/api/account/purchase', body, 'bob')).status, 409);
  assert.equal(await f.accounts.getLicense('bob'), null);
});

for (const scenario of [
  { name: 'a license created even one millisecond before checkout', after: f => f.setLicense({ created: new Date(f.started - 1).toISOString() }) },
  { name: 'a license created after the one-hour checkout window', after: f => {
    f.clock(f.started + 3605000);
    f.setLicense({ created: new Date(f.started + 3600001).toISOString() });
  } },
  { name: 'a Google account with a non-authoritative external email', before: f => f.db.prepare('UPDATE accounts SET email_authoritative = 0 WHERE id = ?').bind('alice').run() },
  { name: 'Google email proof older than 24 hours at checkout', before: (f, now) => f.db.prepare('UPDATE accounts SET google_verified_at = ? WHERE id = ?').bind(now - 86400001, 'alice').run() },
  { name: 'an account email changed after checkout', after: f => f.db.prepare('UPDATE accounts SET email = ? WHERE id = ?').bind('new-owner@gmail.com', 'alice').run() },
  { name: 'a different canonical buyer email', after: f => f.setBuyer({ email: 'someone-else@gmail.com' }) },
  { name: 'a different canonical buyer identity', after: f => f.setBuyer({ id: '999' }) },
  { name: 'a sandbox license in the production environment', after: f => f.setLicense({ environment: 1, created: new Date(f.started + 2000).toISOString() }) },
  { name: 'a cancelled lifetime license', after: f => f.setLicense({ is_cancelled: true, created: new Date(f.started + 2000).toISOString() }) },
  { name: 'an invalid provider creation date', after: f => f.setLicense({ created: '2026-02-30 12:00:00' }) },
  { name: 'a checkout outside the 30-day recovery retention', after: f => f.clock(f.started + 31 * 86400000) }
]) {
  test(`webhook recovery rejects ${scenario.name}`, async t => {
    const f = await recoveryFixture(t, scenario.before);
    await scenario.after?.(f);
    assert.equal((await f.deliver()).status, 200);
    assert.equal(await f.accounts.getLicense('alice'), null);
    await f.db.prepare('UPDATE account_sessions SET expires_at = ?').bind(Date.now() + 100000).run();
    const returned = await f.call('/api/account/purchase', { url: f.signedRedirect(false) });
    assert.ok([403, 409].includes(returned.status), scenario.name);
    assert.equal(await f.accounts.getLicense('alice'), null);
  });
}

test('same email with two different Google subjects and overlapping checkout candidates fails closed', async t => {
  const f = await recoveryFixture(t, async (f, now) => {
    await f.db.prepare('UPDATE accounts SET email = ?, google_verified_at = ? WHERE id = ?').bind('alice@gmail.com', now, 'bob').run();
    await f.accounts.createCheckout('bob');
  });
  assert.equal((await f.deliver()).status, 200);
  assert.equal(await f.accounts.getLicense('alice'), null);
  assert.equal(await f.accounts.getLicense('bob'), null);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM accounts WHERE email = ?').bind('alice@gmail.com').first()).n, 2);
  assert.equal((await f.call('/api/account/purchase', { url: f.signedRedirect(false) })).status, 409);
  assert.equal(await f.accounts.getLicense('alice'), null);
});

test('late webhook delivery uses purchase creation time and keeps expired pending checkouts for 30 days', async t => {
  const f = await recoveryFixture(t);
  f.clock(f.started + 2 * 86400000);
  assert.equal(await f.accounts.getCheckout(f.state, 'alice'), null, 'normal unfinished checkout still expires after one hour');
  await f.accounts.createCheckout('bob');
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM account_checkouts WHERE user_id = ?').bind('alice').first()).n, 1);
  assert.equal((await f.deliver()).status, 200);
  assert.equal((await f.accounts.getLicense('alice')).active, true);
  assert.equal((await f.accounts.getCheckout(f.state, 'alice')).licenseId, '101');
});

test('duplicate recovery webhooks and the signed redirect race keep a single purchase owner', async t => {
  const f = await recoveryFixture(t);
  const results = await Promise.all([
    f.deliver(), f.deliver(), f.call('/api/account/purchase', { url: f.signedRedirect() })
  ]);
  assert.ok(results.every(result => result.status === 200));
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM account_licenses').first()).n, 1);
  assert.equal((await f.accounts.getLicenseById('101')).userId, 'alice');
  assert.equal((await f.accounts.getCheckout(f.state, 'alice')).licenseId, '101');
  f.setBuyer({ email: 'bob@gmail.com' });
  await f.accounts.createCheckout('bob');
  assert.equal((await f.deliver()).status, 200);
  assert.equal((await f.accounts.getLicenseById('101')).userId, 'alice', 'email changes never move an already linked license');
  assert.equal(await f.accounts.getLicense('bob'), null);
});

test('signed checkout attaches to its initiating account; retries are idempotent', async t => {
  const f = await fixture(t);
  const url = await f.redirect();
  assert.equal((await f.call('/api/account/purchase', { url }, 'bob')).status, 409);
  assert.equal((await f.call('/api/account/purchase', { url: url.replace('101', '999') })).status, 403);
  assert.equal((await f.call('/api/account/purchase', { url })).status, 200);
  assert.equal((await f.call('/api/account/purchase', { url })).status, 200);
  assert.equal((await f.accounts.getLicense('alice')).licenseId, '101');
  assert.equal(await f.accounts.getLicense('bob'), null);
});

test('a genuine signature cannot upgrade sandbox, cancelled or expiring licenses to lifetime', async t => {
  const f = await fixture(t);
  const url = await f.redirect();
  for (const invalid of [{ environment: 1 }, { is_cancelled: true }, { expiration: '2099-01-01 00:00:00' },
    { plugin_id: 'another-product' }, { user_id: 'someone-else' }, { plan_id: '999' }]) {
    f.setLicense(invalid);
    assert.equal((await f.call('/api/account/purchase', { url })).status, 403, JSON.stringify(invalid));
    assert.equal(await f.accounts.getLicense('alice'), null);
  }
});

test('billing outage during purchase is retryable and does not consume checkout or grant access', async t => {
  const f = await fixture(t);
  const url = await f.redirect();
  f.outage(true);
  assert.equal((await f.call('/api/account/purchase', { url })).status, 503);
  assert.equal(await f.accounts.getLicense('alice'), null);
  f.outage(false);
  assert.equal((await f.call('/api/account/purchase', { url })).status, 200);
});

test('legacy recovery requires exact full key and cannot transfer a license between accounts', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/account/restore', { licenseKey: 'sk_full-private-test' })).status, 403);
  assert.equal((await f.call('/api/account/restore', { licenseKey: canonical.secret_key })).status, 200);
  assert.equal((await f.call('/api/account/restore', { licenseKey: canonical.secret_key }, 'bob')).status, 409);
});

test('explicit restore immediately reactivates the same purchase after fresh canonical verification', async t => {
  const f = await fixture(t);
  await f.accounts.saveLicense('alice', { licenseId: '101', freemiusUserId: '202', active: false, verifiedAt: Date.now() - 1000 });
  const result = await f.call('/api/account/restore', { licenseKey: canonical.secret_key });
  assert.equal(result.status, 200);
  assert.equal(result.body.premium.unlocked, true);
  assert.equal((await f.accounts.getLicense('alice')).active, true);
});

test('explicit restore cannot reactivate a purchase whose canonical buyer changed', async t => {
  const f = await fixture(t);
  await f.accounts.saveLicense('alice', { licenseId: '101', freemiusUserId: '202', active: false, verifiedAt: Date.now() - 1000 });
  f.setLicense({ user_id: '303' });
  const result = await f.call('/api/account/restore', { licenseKey: canonical.secret_key });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'license_owner_changed');
  assert.equal((await f.accounts.getLicense('alice')).active, false);
});

for (const method of ['purchase', 'restore']) {
  test(`a replacement ${method} preserves revoked purchase ownership and opens the new license`, async t => {
    const f = await fixture(t);
    await f.accounts.saveLicense('alice', { licenseId: '100', freemiusUserId: '202', mode: 'production', active: false, verifiedAt: new Date().toISOString() });
    assert.equal((await f.call('/api/account/checkout')).status, 200);
    const body = method === 'purchase' ? { url: await f.redirect() } : { licenseKey: canonical.secret_key };
    const results = await Promise.all([f.call(`/api/account/${method}`, body), f.call(`/api/account/${method}`, body)]);
    assert.ok(results.every(result => result.status === 200 && result.body.premium.unlocked));
    assert.equal((await f.accounts.getLicense('alice')).licenseId, '101');
    assert.equal((await f.accounts.getLicenseById('100')).userId, 'alice');
    assert.equal((await f.accounts.getLicenseById('100')).active, false);
    assert.equal((await f.call('/api/account/restore', { licenseKey: canonical.secret_key }, 'bob')).status, 409);
    // A late cancellation of the old license cannot revoke the new purchase.
    await f.accounts.updateLicense('100', { active: false, verifiedAt: new Date().toISOString() });
    assert.equal((await f.call('/api/report/detailed', { report: { run: { id: 'repeat' }, audioMetrics: {} } })).status, 200);
  });
}

test('revoking the selected license still checks another active purchase before denying account access', async t => {
  const f = await fixture(t);
  for (const id of ['100', '101']) await f.accounts.saveLicense('alice', { licenseId: id, freemiusUserId: '202', mode: 'production', active: true, verifiedAt: 1 });
  f.setLicense({ id: '100' });
  const result = await f.call('/api/report/detailed', { report: { run: { id: 'second-purchase' }, audioMetrics: {} } });
  assert.equal(result.status, 200);
  assert.equal((await f.accounts.getLicenseById('101')).active, false);
  assert.equal((await f.accounts.getLicenseById('100')).active, true);
});

test('revoking an older license immediately verifies a pending replacement purchase', async t => {
  const f = await fixture(t);
  await f.accounts.saveLicense('alice', { licenseId: '100', freemiusUserId: '202', active: true, verifiedAt: 1 });
  await f.accounts.saveLicense('alice', { licenseId: '101', freemiusUserId: '202', active: false, verifiedAt: 0 });
  const result = await f.call('/api/report/detailed', { report: { run: { id: 'pending-replacement' }, audioMetrics: {} } });
  assert.equal(result.status, 200);
  assert.equal((await f.accounts.getLicenseById('100')).active, false);
  assert.equal((await f.accounts.getLicenseById('101')).active, true);
});

test('sandbox account checkout requires a sandbox proof before recording a purchase intent', async t => {
  const f = await fixture(t);
  const billing = createAccountBilling({ accounts: f.accounts, config: { ...config, mode: 'sandbox' },
    checkoutUrl: 'https://checkout.freemius.com/product/33850/plan/55641/', enabled: true });
  const response = await billing.handle(f.request('/api/account/checkout'));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'sandbox_token_unavailable');
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM account_checkouts').first()).n, 0);
});

for (const kind of ['purchase', 'restore']) {
  test(`a delayed ${kind} retry cannot overwrite a cancellation or report premium as active`, async t => {
    const f = await fixture(t);
    const path = `/api/account/${kind}`;
    const body = kind === 'purchase' ? { url: await f.redirect() } : { licenseKey: canonical.secret_key };
    assert.equal((await f.call(path, body)).body.premium.unlocked, true);
    const started = Promise.withResolvers();
    const delayed = Promise.withResolvers();
    const billing = createAccountBilling({ accounts: f.accounts, config, enabled: true,
      fetchImpl: () => { started.resolve(); return delayed.promise; } });
    const pending = billing.handle(f.request(path, body));
    await started.promise;
    const revokedAt = new Date().toISOString();
    await f.accounts.updateLicense('101', { active: false, verifiedAt: revokedAt });
    delayed.resolve(Response.json(kind === 'restore' ? { licenses: [canonical] } : canonical));
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).premium.unlocked, false);
    const actual = await f.accounts.getLicense('alice');
    assert.equal(actual.active, false);
    assert.equal(actual.verifiedAt, revokedAt);
  });
}

test('account detail authorization ignores anonymous bearer claims and permits repeated valid tests', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/report/detailed', { report: { audioMetrics: {} } }, 'bob', { Authorization: 'Bearer fake' })).status, 403);
  await f.call('/api/account/restore', { licenseKey: canonical.secret_key });
  for (const id of ['first', 'gain-adjusted', 'third']) {
    const result = await f.call('/api/report/detailed', { report: { run: { id }, audioMetrics: {} } });
    assert.equal(result.status, 200);
    assert.equal(result.body.detailed.reportId, id);
  }
});

test('known lifetime access survives provider outage, but confirmed cancellation and owner change revoke it', async t => {
  const f = await fixture(t);
  await f.call('/api/account/restore', { licenseKey: canonical.secret_key });
  await f.accounts.updateLicense('101', { active: true, verifiedAt: '2020-01-01T00:00:00Z' });
  f.outage(true);
  assert.equal((await f.billing.refreshLicense(await f.accounts.getLicense('alice'))).active, true);
  f.outage(false);
  f.setLicense({ is_cancelled: true });
  assert.equal((await f.billing.refreshLicense(await f.accounts.getLicense('alice'))).active, false);
  f.setLicense({ user_id: 'new-owner' });
  assert.equal((await f.billing.refreshLicense(await f.accounts.getLicense('alice'), true)).active, false);
});

test('explicit access recheck bypasses a recent inactive result without creating a purchase', async t => {
  const f = await fixture(t);
  const now = Date.now();
  await f.accounts.saveLicense('alice', { licenseId: '101', freemiusUserId: '202', active: false,
    verifiedAt: now - 1000 });
  assert.equal((await f.billing.refreshUserLicense('alice')).active, false);
  assert.equal(f.calls.length, 0, 'routine refresh retains its cache');
  assert.equal((await f.call('/api/account/purchase/recheck')).status, 200);
  assert.equal((await f.accounts.getLicense('alice')).active, true);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM account_checkouts').first()).n, 0);
  assert.ok(f.calls.every(call => call.options.method === 'GET'));
});

for (const force of [false, true]) {
  test(`a second inactive license can restore access during ${force ? 'explicit' : 'routine'} verification`, async t => {
    const f = await fixture(t);
    for (const id of ['101', '102']) await f.accounts.saveLicense('alice', { licenseId: id,
      freemiusUserId: '202', active: false, verifiedAt: '2020-01-01T00:00:00Z' });
    // 102 sorts first and is invalid; the formerly skipped 101 grants access.
    const result = await f.billing.refreshUserLicense('alice', force);
    assert.equal(result.licenseId, '101'); assert.equal(result.active, true);
    assert.equal(f.calls.length, 2);
  });
}

for (const [change, reason] of [
  [{ is_cancelled: true }, 'license_inactive'],
  [{ expiration: '2099-01-01 00:00:00' }, 'lifetime_license_required'],
  [{ user_id: '303' }, 'license_owner_changed'],
  [{ plan_id: 'another-plan' }, 'license_plan_mismatch'],
  [{ environment: 1 }, 'license_mode_mismatch']
]) {
  test(`definitive ${reason} is preserved through provider outage and cleared on recovery`, async t => {
    const f = await fixture(t);
    let now = Date.now(); t.mock.method(Date, 'now', () => now);
    await f.accounts.saveLicense('alice', { licenseId: '101', freemiusUserId: '202', active: false, verifiedAt: 0 });
    f.setLicense(change);
    assert.equal((await f.call('/api/account/purchase/recheck')).status, 200);
    let record = await f.accounts.getLicense('alice');
    assert.equal(record.active, false); assert.equal(record.inactiveReason, reason);
    const session = new Request(origin + '/api/account/session', { headers: f.request('/').headers });
    assert.equal((await (await f.accounts.handle(session)).json()).premium.inactiveReason, reason);
    f.outage(true); now++;
    assert.equal((await f.call('/api/account/purchase/recheck')).status, 503);
    assert.deepEqual(await f.accounts.getLicense('alice'), record);
    f.outage(false); f.setLicense({}); now++;
    assert.equal((await f.call('/api/account/purchase/recheck')).status, 200);
    record = await f.accounts.getLicense('alice');
    assert.equal(record.active, true); assert.equal(record.inactiveReason, '');
  });
}

test('access recheck rejects missing identity and cross-origin requests before provider calls', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/account/purchase/recheck', {}, 'nobody')).status, 401);
  assert.equal((await f.call('/api/account/purchase/recheck', {}, 'alice', { Origin: 'https://other.example' })).status, 403);
  assert.equal(f.calls.length, 0);
});

test('a cancellation arriving while another candidate is checked cannot expose stale active access', async t => {
  const f = await fixture(t);
  await f.accounts.saveLicense('alice', { licenseId: '102', freemiusUserId: '202', active: true, verifiedAt: '2020-01-01T00:00:00Z' });
  await f.accounts.saveLicense('alice', { licenseId: '101', freemiusUserId: '202', active: true, verifiedAt: '2019-01-01T00:00:00Z' });
  f.beforeResponse(async () => {
    await f.accounts.updateLicense('101', { active: false, verifiedAt: Date.now(), inactiveReason: 'license_inactive' });
  });
  assert.equal((await f.billing.refreshUserLicense('alice')).active, false);
  assert.equal(f.calls.length, 1, 'the freshly revoked second candidate is read from storage');
});

test('incomplete cancellation or expiration data never revokes known lifetime access', async t => {
  const f = await fixture(t);
  await f.call('/api/account/restore', { licenseKey: canonical.secret_key });
  for (const change of [{ is_cancelled: undefined }, { is_cancelled: null }, { expiration: undefined }]) {
    await f.accounts.updateLicense('101', { active: true, verifiedAt: '2020-01-01T00:00:00Z' });
    f.setLicense(change);
    assert.equal((await f.billing.refreshUserLicense('alice')).active, true);
    assert.equal((await f.call('/api/account/purchase/recheck')).status, 503);
    assert.equal((await f.accounts.getLicense('alice')).active, true);
  }
  f.setLicense({ is_cancelled: true, expiration: undefined });
  assert.equal((await f.call('/api/account/purchase/recheck')).status, 200);
  assert.equal((await f.accounts.getLicense('alice')).active, false, 'explicit cancellation still revokes access');
});

test('portal verifies the current buyer and creates an on-demand login using only the server-bound ID', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/account/portal')).status, 409);
  assert.equal(f.calls.length, 0);
  await f.call('/api/account/restore', { licenseKey: canonical.secret_key });
  f.setBuyer({ email: 'ALICE@gmail.com' });
  f.calls.length = 0;
  const response = await f.billing.handle(f.request('/api/account/portal', { id: '999', email: 'other@gmail.com' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { ok: true, url: 'https://customers.freemius.com/secure-example' });
  assert.equal(f.calls.length, 3);
  const login = f.calls[2];
  assert.match(login.url, /\/products\/33850\/portal\/login\.json$/);
  assert.equal(login.options.method, 'POST');
  assert.deepEqual(JSON.parse(login.options.body), { id: '202' });
  assert.equal(f.calls[0].options.signal, login.options.signal, 'The whole operation shares one deadline');
  assert.equal(login.options.redirect, 'manual');
  assert.equal((await f.accounts.getLicense('alice')).active, true);
});

for (const scenario of [
  { name: 'old Google proof', proof: Date.now() - 86400001, error: 'portal_confirmation_required' },
  { name: 'missing Google proof', proof: null, error: 'portal_confirmation_required' },
  { name: 'future Google proof', proof: Date.now() + 86400000, error: 'portal_confirmation_required' },
  { name: 'external unverified email ownership', authoritative: 0, error: 'portal_identity_unverified' }
]) test(`portal does not mint access with ${scenario.name}`, async t => {
  const f = await fixture(t);
  await f.call('/api/account/restore', { licenseKey: canonical.secret_key });
  await f.db.prepare('UPDATE accounts SET google_verified_at = ?, email_authoritative = ? WHERE id = ?')
    .bind(scenario.proof === undefined ? Date.now() : scenario.proof, scenario.authoritative ?? 1, 'alice').run();
  f.calls.length = 0;
  assert.deepEqual(await f.call('/api/account/portal'), { status: 403, body: { ok: false, error: scenario.error } });
  assert.equal(f.calls.length, 0);
});

for (const scenario of [
  { name: 'a borrowed license key', buyer: { email: 'other@gmail.com' } },
  { name: 'a changed buyer', buyer: { id: '999', email: 'alice@gmail.com' } },
  { name: 'a missing buyer email', buyer: { email: null } },
  { name: 'a transferred license', license: { user_id: '999' } },
  { name: 'a different product', license: { plugin_id: '99' } },
  { name: 'a different license', license: { id: '99' } },
  { name: 'a different environment', license: { environment: 1 } }
]) test(`portal refuses ${scenario.name} without changing Premium access`, async t => {
  const f = await fixture(t);
  await f.call('/api/account/restore', { licenseKey: canonical.secret_key });
  f.setBuyer({ email: 'alice@gmail.com', ...scenario.buyer });
  if (scenario.license) f.setLicense(scenario.license);
  f.calls.length = 0;
  const result = await f.call('/api/account/portal');
  assert.equal(result.body.error, 'portal_owner_mismatch');
  assert.equal(result.status, 403);
  assert.ok(f.calls.every(call => call.options.method === 'GET'));
  assert.equal((await f.accounts.getLicense('alice')).active, true);
});

test('a cancelled purchase can still open its rightful owner’s billing account', async t => {
  const f = await fixture(t);
  await f.call('/api/account/restore', { licenseKey: canonical.secret_key });
  f.setLicense({ is_cancelled: true }); f.setBuyer({ email: 'alice@gmail.com' });
  await f.accounts.updateLicense('101', { active: false, verifiedAt: new Date().toISOString() });
  assert.equal((await f.call('/api/account/portal')).status, 200);
  assert.equal((await f.accounts.getLicense('alice')).active, false);
  assert.equal((await f.call('/api/report/detailed', { report: { run: { id: 'cancelled-purchase' }, audioMetrics: {} } })).status, 403,
    'Opening billing does not restore Premium report access');
});

for (const value of [null, {}, { link: 'javascript:alert(1)' }, { link: 'https://freemius.com.evil.test/login' },
  { link: 'https://checkout.freemius.com/login' }, { link: 'http://customers.freemius.com/login' },
  { link: 'https://user:password@customers.freemius.com/login' }, { link: 'https://customers.freemius.com:444/login' }]) {
  test(`portal rejects an invalid provider redirect: ${JSON.stringify(value)}`, async t => {
    const f = await fixture(t);
    await f.call('/api/account/restore', { licenseKey: canonical.secret_key });
    f.setBuyer({ email: 'alice@gmail.com' }); f.setPortalReply(value);
    assert.deepEqual(await f.call('/api/account/portal'), { status: 503, body: { ok: false, error: 'portal_unavailable' } });
  });
}

test('a provider outage offers retry without returning a portal credential or changing access', async t => {
  const f = await fixture(t);
  await f.call('/api/account/restore', { licenseKey: canonical.secret_key });
  f.setBuyer({ email: 'alice@gmail.com' }); f.outage(true);
  const result = await f.call('/api/account/portal');
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { ok: false, error: 'billing_temporarily_unavailable' });
  assert.equal((await f.accounts.getLicense('alice')).active, true);
});

for (const stage of ['users', 'portal']) test(`logout during the ${stage} lookup cannot return a login link`, async t => {
  const f = await fixture(t);
  await f.call('/api/account/restore', { licenseKey: canonical.secret_key });
  f.setBuyer({ email: 'alice@gmail.com' }); f.calls.length = 0;
  f.beforeResponse(async url => {
    if (url.includes(`/${stage}/`)) await f.db.prepare('DELETE FROM account_sessions WHERE user_id = ?').bind('alice').run();
  });
  assert.deepEqual(await f.call('/api/account/portal'), { status: 401, body: { ok: false, error: 'sign_in_required' } });
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, stage === 'portal' ? 1 : 0);
});

test('a changed license association during provider lookup cannot mint portal access', async t => {
  const f = await fixture(t);
  await f.call('/api/account/restore', { licenseKey: canonical.secret_key });
  f.setBuyer({ email: 'alice@gmail.com' }); f.calls.length = 0;
  f.beforeResponse(async url => {
    if (url.includes('/users/')) await f.db.prepare('UPDATE account_licenses SET user_id = ? WHERE license_id = ?').bind('bob', '101').run();
  });
  assert.deepEqual(await f.call('/api/account/portal'), { status: 409, body: { ok: false, error: 'account_changed' } });
  assert.ok(f.calls.every(call => call.options.method === 'GET'));
});

for (const scenario of [
  { name: 'an older active response', delta: 1, status: 200 },
  { name: 'an active response from the same millisecond', delta: 0, status: 200 },
  { name: 'a delayed provider outage', delta: 1, status: 503 }
]) {
  test(`a confirmed cancellation survives ${scenario.name}`, async t => {
    const f = await fixture(t);
    await f.call('/api/account/restore', { licenseKey: canonical.secret_key });
    await f.accounts.updateLicense('101', { active: true, verifiedAt: '2020-01-01T00:00:00Z' });
    const oldRecord = await f.accounts.getLicense('alice');
    let now = Date.now() + 1000;
    t.mock.method(Date, 'now', () => now);
    const delayed = Promise.withResolvers();
    let calls = 0;
    const billing = createAccountBilling({ accounts: f.accounts, config, enabled: true,
      fetchImpl: () => ++calls === 1 ? delayed.promise : Response.json({ ...canonical, is_cancelled: true }) });
    const pending = billing.refreshLicense(oldRecord);
    assert.equal(calls, 1);
    now += scenario.delta;
    const revoked = await billing.refreshLicense(oldRecord, true);
    assert.equal(revoked.active, false);
    delayed.resolve(Response.json(canonical, { status: scenario.status }));
    assert.equal((await pending).active, false, 'the delayed request must return the actual stored entitlement');
    const stored = await f.accounts.getLicense('alice');
    assert.equal(stored.active, false);
    assert.equal(Date.parse(stored.verifiedAt), now);
  });
}

test('webhooks verify raw-body signature and fetch current state instead of replaying old grants', async t => {
  const f = await fixture(t);
  await f.call('/api/account/restore', { licenseKey: canonical.secret_key });
  const event = { type: 'license.updated', objects: { license: { id: '101', is_cancelled: false } } };
  assert.equal((await f.call('/api/freemius/webhook', event)).status, 403);
  f.setLicense({ is_cancelled: true });
  const signature = createHmac('sha256', config.productSecret).update(JSON.stringify(event)).digest('hex');
  assert.equal((await f.call('/api/freemius/webhook', event, 'alice', { 'x-signature': signature })).status, 200);
  assert.equal((await f.accounts.getLicense('alice')).active, false);
});

async function firstLinkFixture(t, kind) {
  const f = kind === 'webhook' ? await recoveryFixture(t) : await fixture(t);
  const source = { ...canonical, created: new Date((f.started || Date.now()) + 2000).toISOString() };
  const signedEvent = type => {
    const event = { type, objects: { license: { id: '101' } } };
    const signature = createHmac('sha256', config.productSecret).update(JSON.stringify(event)).digest('hex');
    return f.request('/api/freemius/webhook', event, 'alice', { 'x-signature': signature });
  };
  const url = kind === 'purchase' ? await f.redirect() : null;
  return { ...f, source, signedEvent,
    initiate: () => kind === 'webhook' ? signedEvent('license.created')
      : f.request(`/api/account/${kind}`, kind === 'purchase' ? { url } : { licenseKey: canonical.secret_key }),
    providerResponse: (url, license = source) => Response.json(String(url).includes('/users/')
      ? { id: '202', email: 'alice@gmail.com' } : String(url).includes('/licenses.json') ? { licenses: [license] } : license)
  };
}

for (const kind of ['purchase', 'restore', 'webhook']) {
  test(`a cancellation arriving before first ${kind} insertion cannot be lost`, async t => {
    const f = await firstLinkFixture(t, kind);
    const started = Promise.withResolvers();
    const delayed = Promise.withResolvers();
    let first = true;
    const billing = createAccountBilling({ accounts: f.accounts, config, enabled: true,
      fetchImpl: url => {
        if (first) { first = false; started.resolve(url); return delayed.promise; }
        return f.providerResponse(url, { ...f.source, is_cancelled: true });
      }
    });
    const pending = billing.handle(f.initiate());
    const lookup = await started.promise;
    const cancellation = await billing.handle(f.signedEvent('license.cancelled'));
    assert.equal(cancellation.status, 200);
    delayed.resolve(f.providerResponse(lookup));
    const response = await pending;
    assert.equal(response.status, 200);
    if (kind !== 'webhook') assert.equal((await response.json()).premium.unlocked, false);
    assert.equal((await f.accounts.getLicense('alice')).active, false);
  });

  test(`first ${kind} final verification fails closed on outage and resumes idempotently`, async t => {
    const f = await firstLinkFixture(t, kind);
    await f.accounts.saveLicense('alice', { licenseId: '100', freemiusUserId: '202', active: false, verifiedAt: Date.now() });
    let unavailable = true;
    const billing = createAccountBilling({ accounts: f.accounts, config, enabled: true,
      checkoutUrl: 'https://checkout.freemius.com/product/33850/plan/55641/',
      fetchImpl: async url => {
        const stored = await f.accounts.getLicenseById('101');
        if (stored && unavailable) return new Response('{}', { status: 503 });
        return f.providerResponse(url);
      }
    });
    const response = await billing.handle(f.initiate());
    assert.equal(response.status, 503);
    const pending = await f.accounts.getLicenseById('101');
    assert.equal(pending.active, false);
    assert.equal(Date.parse(pending.verifiedAt), 0);
    const intents = (await f.db.prepare('SELECT count(*) AS n FROM account_checkouts').first()).n;
    const checkout = await billing.handle(f.request('/api/account/checkout'));
    assert.equal(checkout.status, 503, 'pending verification must not invite another payment');
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM account_checkouts').first()).n, intents);
    const detail = await billing.handle(f.request('/api/report/detailed', { report: { run: { id: 'pending' }, audioMetrics: {} } }));
    assert.equal(detail.status, 503, 'pending verification is retryable rather than a missing purchase');
    unavailable = false;
    const retry = await billing.handle(f.initiate());
    assert.equal(retry.status, 200);
    assert.equal((await f.accounts.getLicense('alice')).active, true);
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM account_licenses').first()).n, 2);
    assert.equal((await f.accounts.getLicenseById('100')).active, false);
  });

  test(`first ${kind} final verification cannot overwrite a same-millisecond cancellation`, async t => {
    const f = await firstLinkFixture(t, kind);
    const now = (f.started || Date.now()) + 5000;
    if (f.clock) f.clock(now);
    else t.mock.method(Date, 'now', () => now);
    const started = Promise.withResolvers();
    const delayed = Promise.withResolvers();
    let finalCheck = false;
    const billing = createAccountBilling({ accounts: f.accounts, config, enabled: true,
      fetchImpl: async url => {
        const stored = await f.accounts.getLicenseById('101');
        if (!stored) return f.providerResponse(url);
        if (!finalCheck) { finalCheck = true; started.resolve(url); return delayed.promise; }
        return f.providerResponse(url, { ...f.source, is_cancelled: true });
      }
    });
    const pending = billing.handle(f.initiate());
    const lookup = await started.promise;
    assert.equal((await f.accounts.getLicense('alice')).active, false, 'ownership alone must not grant access');
    const cancellation = await billing.handle(f.signedEvent('license.cancelled'));
    assert.equal(cancellation.status, 200);
    delayed.resolve(f.providerResponse(lookup));
    assert.equal((await pending).status, 200);
    const revoked = await f.accounts.getLicense('alice');
    assert.equal(revoked.active, false);
    assert.equal(Date.parse(revoked.verifiedAt), now);
  });
}
