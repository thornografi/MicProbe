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
    URL, Date, AbortSignal, localStorage: storage, sessionStorage: storage, accountAccess: account,
    fetch: async (url, options) => { requests.push({ url, options }); return request(url, options); },
    window: { location: { href: 'https://micprobe.example/app', origin: 'https://micprobe.example' } },
    log: { warning() {}, ui() {}, error() {} }, eventBus: { emit: (event, payload) => messages.push(payload) }, EVENTS: {}
  });
  return { premium, state, saved, messages, requests, refreshes, rejections };
}

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
