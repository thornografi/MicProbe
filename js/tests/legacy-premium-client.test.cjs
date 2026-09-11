const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(request = async () => Response.json({ ok: true })) {
  const state = { ready: true, configured: false, user: null };
  const saved = new Map();
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  const messages = [];
  const source = fs.readFileSync(require.resolve('../modules/PremiumAccess.js'), 'utf8').replace(/^import .*;$/gm, '')
    .replace('export default premiumAccess;', 'premiumAccess;');
  const premium = vm.runInNewContext(source, {
    projectArchiveReport: require("../modules/ArchiveReport.js").projectArchiveReport,
    URL, Date, AbortSignal, fetch: request, localStorage: storage, sessionStorage: storage,
    window: { location: { href: 'https://micprobe.example/app', origin: 'https://micprobe.example' } },
    log: { warning() {}, ui() {}, error() {} }, eventBus: { emit: (...args) => messages.push(args) }, EVENTS: {},
    accountAccess: { getState: () => state, subscribe() {}, bootstrap: async () => state }
  });
  premium.entitlement = { verified: true, accessToken: 'old-reference', mode: 'production' };
  return { premium, saved, messages, state };
}

test('legacy checkout blocks a missing sandbox proof and rejects foreign checkout hosts', () => {
  const { premium } = fixture();
  const config = { configured: true, mode: 'sandbox', productId: '1', planId: '2' };
  assert.equal(premium._buildCheckoutUrl(config), '');
  assert.equal(premium._buildCheckoutUrl({ ...config, sandboxActive: true }), '');
  const valid = 'https://checkout.freemius.com/product/1/plan/2/?sandbox=' + 'a'.repeat(32) + '&s_ctx_ts=1788612000';
  assert.ok(premium._buildCheckoutUrl({ ...config, sandboxActive: true, checkoutUrl: valid }));
  assert.equal(premium._buildCheckoutUrl({ configured: true, mode: 'production', checkoutUrl: 'https://other.example/' }), '');
});

test('old legacy token rejection explains key migration, and restoring clears the error without persisting the key', async () => {
  const calls = [];
  const { premium, saved } = fixture(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/detailed')) return Response.json({ ok: false, error: 'license_restore_required' }, { status: 403 });
    return Response.json({ ok: true, entitlement: { mode: 'production', accessToken: 'restored-reference' } });
  });
  await assert.rejects(premium.fetchDetailedReport({ audioMetrics: {} }), /license_restore_required/);
  assert.equal(premium.isUnlocked(), false);
  assert.match(premium.getState().lastError, /Open Sign in.*Restore an earlier purchase/);
  await premium.restoreLegacyPurchase('sk_previous-complete-purchase');
  assert.equal(premium.isUnlocked(), true); assert.equal(premium.getState().lastError, '');
  assert.equal(calls[1].options.credentials, 'same-origin');
  assert.equal(calls[1].options.headers['X-MicProbe-Request'], '1');
  assert.ok(!JSON.stringify([...saved]).includes('sk_previous-complete-purchase'));
});

test('a temporary provider failure preserves a legacy purchase for retry', async () => {
  const { premium } = fixture(async () => Response.json({ ok: false, error: 'billing_temporarily_unavailable' }, { status: 503 }));
  await assert.rejects(premium.fetchDetailedReport({ audioMetrics: {} }), /billing_temporarily_unavailable/);
  assert.equal(premium.isUnlocked(), true);
});

test('an old detail rejection cannot clear a purchase restored while that request was pending', async () => {
  let finish;
  const { premium } = fixture((url) => url.endsWith('/detailed') ? new Promise(resolve => { finish = resolve; })
    : Response.json({ ok: true, entitlement: { mode: 'production', accessToken: 'new-reference' } }));
  const oldRequest = premium.fetchDetailedReport({ audioMetrics: {} });
  await premium.restoreLegacyPurchase('sk_previous-complete-purchase');
  finish(Response.json({ ok: false, error: 'license_inactive' }, { status: 403 }));
  await assert.rejects(oldRequest, /license_inactive/);
  assert.equal(premium.entitlement.accessToken, 'new-reference');
  assert.equal(premium.isUnlocked(), true);
});
