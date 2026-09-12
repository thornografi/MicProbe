const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture({ request, refresh, purchase } = {}) {
  const state = { ready: true, configured: true, user: { id: 'A' }, premium: { unlocked: true }, error: '' };
  const saved = new Map();
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  const messages = []; const requests = []; const refreshes = []; const rejections = [];
  const account = {
    getState: () => state, subscribe() {},
    async bootstrap() { return state; },
    requireSignIn() { return !!state.user; },
    async refresh(options) { refreshes.push(options); await refresh?.(state); },
    async refreshRejectedAccess(code, owner) {
      rejections.push({ code, owner });
      if (['sign_in_required', 'account_changed', 'premium_access_required'].includes(code)) await this.refresh({ sessionOnly: true });
    },
    async api(path, options) { return purchase?.(state, path, options) || { ok: true, premium: { unlocked: true } }; }
  };
  const source = fs.readFileSync(require.resolve('../modules/PremiumAccess.js'), 'utf8').replace(/^import .*;$/gm, '')
    .replace('export default premiumAccess;', 'premiumAccess;');
  const premium = vm.runInNewContext(source, {
    projectArchiveReport: require('../modules/ArchiveReport.js').projectArchiveReport,
    URL, Date, AbortSignal, localStorage: storage, sessionStorage: storage, accountAccess: account,
    fetch: async (url, options) => { requests.push({ url, options }); return request(url, options); },
    document: { title: 'MicProbe' },
    window: { location: { href: 'https://micprobe.example/app', origin: 'https://micprobe.example' }, history: { replaceState() {} } },
    log: { warning() {}, ui() {}, error() {} }, eventBus: { emit: (event, payload) => messages.push(payload) }, EVENTS: {}
  });
  return { premium, state, saved, messages, requests, refreshes, rejections };
}

test('linked inactive purchase has one explicit provider recheck and picks up the refreshed session', async () => {
  let calls = 0;
  const env = fixture({ purchase: async (state, path) => {
    calls++; assert.equal(path, '/purchase/recheck'); state.premium.unlocked = true;
    return { ok: true };
  } });
  env.state.premium.unlocked = false; env.state.purchaseLinked = true;
  const first = env.premium.retryPurchaseVerification();
  assert.equal(env.premium.retryPurchaseVerification(), first);
  await first;
  assert.equal(calls, 1); assert.equal(env.premium.isUnlocked(), true);
  assert.equal(env.refreshes.length, 2);
});

test('a switched or unreachable account never triggers a provider recheck', async () => {
  for (const changed of [true, false]) {
    let calls = 0;
    const env = fixture({ refresh: state => {
      if (changed) state.user = { id: 'B' }; else state.error = 'network_unavailable';
    }, purchase: () => { calls++; } });
    env.state.purchaseLinked = true; env.state.premium.unlocked = false;
    await env.premium.retryPurchaseVerification();
    assert.equal(calls, 0);
  }
});

test('hosted checkout without state uses account verification and announces Premium only after a confirmed session refresh', async () => {
  const purchases = [];
  const env = fixture({
    request: async url => {
      assert.equal(url, '/api/freemius/config', 'account mode must not enter legacy verification');
      return Response.json({ configured: true, mode: 'sandbox' });
    },
    purchase: async (state, path, options) => { purchases.push({ path, options }); },
    refresh: state => { state.premium.unlocked = true; }
  });
  env.state.premium.unlocked = false;
  env.premium.redirectHref = 'https://micprobe.example/app?license_id=101&user_id=202&signature=signed';
  await env.premium.bootstrap();
  assert.equal(purchases[0].path, '/purchase');
  assert.equal(purchases[0].options.body.url, env.premium.redirectHref);
  assert.equal(env.premium.isUnlocked(), true);
  assert.match(env.messages[0].message, /linked to your account/);
  assert.equal(env.saved.has('micprobe:premium-access:v1'), false);
});

test('a hosted return that cannot link remains retryable and never announces Premium', async () => {
  const env = fixture({ request: async () => Response.json({ configured: true }),
    purchase: async () => { throw new Error('checkout_not_found'); } });
  env.state.premium.unlocked = false;
  env.premium.redirectHref = 'https://micprobe.example/app?license_id=101&signature=signed';
  await env.premium.bootstrap();
  assert.equal(env.premium.isUnlocked(), false);
  assert.equal(env.premium.pendingPurchase, env.premium.redirectHref);
  assert.equal(env.messages[0].tone, 'warning');
  assert.equal(env.saved.has('micprobe:premium-access:v1'), false);
  assert.equal(env.premium.getState().pending, true);
  await assert.rejects(env.premium.startCheckout(), /purchase_verification_pending/);
});

test('retrying an unlinked return checks the session then retries the existing purchase once', async () => {
  let attempts = 0;
  const env = fixture({ purchase: async state => { attempts++; state.premium.unlocked = true; } });
  env.state.premium.unlocked = false;
  env.premium.pendingPurchase = 'https://micprobe.example/app?signature=pending';
  await env.premium.retryPurchaseVerification();
  assert.equal(attempts, 1);
  assert.equal(env.premium.getState().pending, false);
  assert.equal(env.premium.isUnlocked(), true);
});

test('verification retry must not send the old return when the session changes account', async () => {
  let attempts = 0;
  const env = fixture({ refresh: state => { state.user = { id: 'B' }; }, purchase: async () => { attempts++; } });
  env.state.premium.unlocked = false;
  env.premium.pendingPurchase = 'https://micprobe.example/app?signature=account-A';
  await env.premium.retryPurchaseVerification();
  assert.equal(attempts, 0);
  assert.ok(env.premium.pendingPurchase);
});

test('a linked pending purchase confirmed by the session clears recovery without a purchase replay', async () => {
  let attempts = 0;
  const env = fixture({ refresh: state => { state.premium = { unlocked: true }; }, purchase: async () => { attempts++; } });
  env.state.premium = { unlocked: false, pending: true };
  env.premium.pendingPurchase = 'https://micprobe.example/app?signature=already-linked';
  await env.premium.retryPurchaseVerification();
  assert.equal(attempts, 0);
  assert.equal(env.premium.pendingPurchase, '');
  assert.equal(env.premium.getState().pending, false);
});

test('expired sessions and confirmed revocations refresh access without resending a report', async () => {
  for (const [error, status] of [['sign_in_required', 401], ['premium_access_required', 403], ['account_changed', 409]]) {
    const env = fixture({
      request: async () => Response.json({ ok: false, error }, { status }),
      refresh: state => { state.premium.unlocked = false; if (status === 401) state.user = null; }
    });
    await assert.rejects(env.premium.fetchDetailedReport({ run: { accountOwnerId: 'A' } }), new RegExp(error));
    assert.equal(env.premium.isUnlocked(), false);
    assert.equal(env.refreshes.length, 1);
    assert.equal(env.refreshes[0].sessionOnly, true);
    assert.deepEqual(env.rejections, [{ code: error, owner: 'A' }]);
    assert.equal(env.requests.length, 1);
    assert.equal(env.requests[0].options.headers['X-MicProbe-Account'], 'A');
    assert.ok(env.requests[0].options.signal);
  }
});

test('a temporary detail outage preserves access and does not trigger another account request', async () => {
  const env = fixture({ request: async () => Response.json({ ok: false, error: 'billing_temporarily_unavailable' }, { status: 503 }) });
  await assert.rejects(env.premium.fetchDetailedReport({}), /billing_temporarily_unavailable/);
  assert.equal(env.premium.isUnlocked(), true);
  assert.equal(env.refreshes.length, 0);
});

test('a successful old report response cannot be delivered after switching accounts', async () => {
  let finish;
  const env = fixture({ request: () => new Promise(resolve => { finish = resolve; }) });
  const pending = env.premium.fetchDetailedReport({ run: { accountOwnerId: 'A' } });
  env.state.user = { id: 'B' };
  finish(Response.json({ ok: true, detailed: { privateAccountA: true } }));
  await assert.rejects(pending, /account_changed/);
});

test('a completed return for a cancelled purchase does not announce active lifetime access', async () => {
  const env = fixture({
    purchase: async () => ({ ok: true, premium: { unlocked: false } }),
    refresh: state => { state.premium.unlocked = false; }
  });
  env.premium.pendingPurchase = 'https://micprobe.example/app?checkout_state=old';
  await env.premium._completeAccountPurchase();
  assert.equal(env.premium.pendingPurchase, '');
  assert.equal(env.messages.length, 1);
  assert.equal(env.messages[0].tone, 'warning');
  assert.match(env.messages[0].message, /no longer active/);
});

test('a completed old return still recognizes a newer active replacement purchase', async () => {
  const env = fixture({ purchase: async () => ({ ok: true, premium: { unlocked: false } }) });
  env.premium.pendingPurchase = 'https://micprobe.example/app?checkout_state=old';
  await env.premium._completeAccountPurchase();
  assert.equal(env.messages[0].tone, 'success');
});

test('checkout completion preserves a return if another account replaced its owner while awaiting the response', async () => {
  let finish;
  const env = fixture({ purchase: () => new Promise(resolve => { finish = resolve; }) });
  const url = 'https://micprobe.example/app?checkout_state=pending-A';
  env.premium.pendingPurchase = url;
  const pending = env.premium._completeAccountPurchase();
  env.state.user = { id: 'B' };
  finish({ ok: true, premium: { unlocked: true } });
  await pending;
  assert.equal(env.premium.pendingPurchase, url);
  assert.equal(env.refreshes.length, 0);
  assert.equal(env.messages.length, 0);
});

test('a failed checkout response cannot announce another account purchase error', async () => {
  let reject;
  const env = fixture({ purchase: () => new Promise((_resolve, fail) => { reject = fail; }) });
  env.premium.pendingPurchase = 'https://micprobe.example/app?checkout_state=pending-A';
  const pending = env.premium._completeAccountPurchase();
  env.state.user = { id: 'B' };
  reject(new Error('offline'));
  await pending;
  assert.equal(env.messages.length, 0);
});
