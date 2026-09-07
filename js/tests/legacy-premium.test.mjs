import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import worker from '../../worker/dev.js';
import { createLegacyPremium } from '../../server/legacy-premium.mjs';

const require = createRequire(import.meta.url);
const origin = 'https://micprobe.example';
const canonical = { id: '101', plugin_id: '33850', plan_id: '55641', pricing_id: '17', user_id: '202',
  environment: 0, is_cancelled: false, expiration: null, secret_key: 'sk_complete-legacy-purchase-key' };
const production = { MICPROBE_FREEMIUS_MODE: 'production', MICPROBE_FREEMIUS_PRODUCTION_PRODUCT_ID: '33850',
  MICPROBE_FREEMIUS_PRODUCTION_PLAN_ID: '55641', MICPROBE_FREEMIUS_PRODUCTION_PRICING_ID: '17',
  MICPROBE_FREEMIUS_PRODUCTION_PRODUCT_SECRET: 'test-secret', MICPROBE_FREEMIUS_PRODUCTION_API_TOKEN: 'test-api',
  MICPROBE_FREEMIUS_PRODUCTION_SUCCESS_URL: origin + '/app', MICPROBE_GOOGLE_CLIENT_ID: '' };
const realFetch = globalThis.fetch;

async function adapter(t, kind, env = production) {
  if (kind === 'Worker') return (path, options = {}) => worker.fetch(new Request(origin + path, options), env);
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../../server.js')];
  const { server } = require('../../server.js');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const local = `http://127.0.0.1:${server.address().port}`;
  return (path, options = {}) => realFetch(local + path, { ...options,
    headers: { ...options.headers, ...(options.method === 'POST' ? { Origin: local } : {}) } });
}

for (const kind of ['Node', 'Worker']) {
  test(`${kind} explicit checkout URLs still require every canonical verification credential`, async t => {
    for (const [field, issue] of [['PRODUCT_ID', 'missing_product_id'], ['API_TOKEN', 'missing_api_token'], ['PRODUCT_SECRET', 'missing_product_secret']]) {
      await t.test(field, async child => {
        const send = await adapter(child, kind, { ...production,
          MICPROBE_FREEMIUS_PRODUCTION_CHECKOUT_URL: 'https://checkout.freemius.com/product/33850/plan/55641/',
          [`MICPROBE_FREEMIUS_PRODUCTION_${field}`]: '' });
        const config = await (await send('/api/freemius/config')).json();
        assert.equal(config.configured, false, field);
        assert(config.issues.includes(issue), JSON.stringify(config.issues));
      });
    }
  });

  test(`${kind} legacy verification rejects the wrong canonical environment, owner, plan and expiration`, async t => {
    const send = await adapter(t, kind);
    let license = { ...canonical };
    t.mock.method(globalThis, 'fetch', async url => {
      assert.equal(new URL(url).hostname, 'api.freemius.com');
      return Response.json(license);
    });
    const raw = origin + '/app?license_id=101&user_id=202&plan_id=55641&pricing_id=17';
    const signed = raw + '&signature=' + createHmac('sha256', 'test-secret').update(raw).digest('hex');
    for (const patch of [{ environment: 1 }, { environment: null }, { user_id: 999 }, { plan_id: 'wrong' },
      { pricing_id: 'wrong' }, { expiration: 'not-a-date' }, { is_cancelled: true }]) {
      license = { ...canonical, ...patch };
      const response = await send('/api/freemius/verify?url=' + encodeURIComponent(signed));
      assert.equal(response.status, 403, JSON.stringify(patch));
    }
    license = { ...canonical };
    assert.equal((await send('/api/freemius/verify?url=' + encodeURIComponent(signed))).status, 200);
  });

  test(`${kind} legacy access rechecks cancellation, renews valid purchases, and offers a key migration for old tokens`, async t => {
    const send = await adapter(t, kind);
    let license = { ...canonical }, calls = 0, outage = false;
    t.mock.method(globalThis, 'fetch', async url => {
      calls++;
      if (outage) return new Response('', { status: 503 });
      return Response.json(String(url).includes('/licenses.json') ? { licenses: [license] } : license);
    });
    const restore = key => send('/api/freemius/restore', { method: 'POST', headers: {
      Origin: origin, 'X-MicProbe-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ licenseKey: key }) });
    const detail = token => send('/api/report/detailed', { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ report: { run: { id: 'legacy' }, audioMetrics: {} } }) });
    assert.equal((await restore('sk_complete-legacy')).status, 403);
    const restored = await restore(canonical.secret_key);
    assert.equal(restored.status, 200);
    const { entitlement } = await restored.json();
    const token = JSON.parse(Buffer.from(entitlement.accessToken.split('.')[0], 'base64url'));
    assert.equal(token.v, 2); assert.equal(token.licenseId, '101');
    assert.equal(Date.parse(token.expiresAt) - token.iat, 3600000);
    assert.equal((await detail(entitlement.accessToken)).status, 200);
    outage = true;
    assert.equal((await detail(entitlement.accessToken)).status, 503);
    outage = false; license.is_cancelled = true;
    const before = calls;
    assert.equal((await detail(entitlement.accessToken)).status, 403);
    assert.equal(calls, before + 1, 'revocation is checked even immediately after token issuance');
    const old = Buffer.from(JSON.stringify({ v: 1, mode: 'production', planId: '55641', pricingId: '17', iat: Date.now() })).toString('base64url');
    const oldToken = old + '.' + createHmac('sha256', 'test-secret').update(old).digest('base64url');
    assert.equal((await (await detail(oldToken)).json()).error, 'license_restore_required');
    license.is_cancelled = false;
    assert.equal((await restore(canonical.secret_key)).status, 200, 'old purchases can restore without paying again');
  });

  test(`${kind} sandbox configuration fails closed without a checkout signer`, async t => {
    const sandbox = { ...production, MICPROBE_FREEMIUS_MODE: 'sandbox', MICPROBE_FREEMIUS_SANDBOX_PRODUCT_ID: '33850',
      MICPROBE_FREEMIUS_SANDBOX_PLAN_ID: '55641', MICPROBE_FREEMIUS_SANDBOX_PRODUCT_SECRET: 'test-secret',
      MICPROBE_FREEMIUS_SANDBOX_API_TOKEN: 'test-api', MICPROBE_FREEMIUS_SANDBOX_PUBLIC_KEY: '',
      MICPROBE_FREEMIUS_PUBLIC_KEY: '', FREEMIUS_PUBLIC_KEY: '', MICPROBE_FREEMIUS_SANDBOX_TOKEN: '', MICPROBE_FREEMIUS_SANDBOX_CTX: '' };
    const send = await adapter(t, kind, sandbox);
    const config = await (await send('/api/freemius/config')).json();
    assert.equal(config.configured, false); assert.equal(config.sandboxActive, false);
    assert.equal(config.checkoutUrl, ''); assert.ok(config.issues.includes('sandbox_token_unavailable'));
  });
}

test('an expired signed reference renews only while its canonical purchase is active', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let license = { ...canonical }, calls = 0;
  const service = createLegacyPremium({ mode: 'production', productId: '33850', planId: '55641', pricingId: '17',
    productSecret: 'test-secret', apiToken: 'test-api' }, async () => { calls++; return Response.json({ licenses: [license] }); });
  const initial = await service.restore(canonical.secret_key);
  const refresh = createLegacyPremium({ mode: 'production', productId: '33850', planId: '55641', pricingId: '17',
    productSecret: 'test-secret', apiToken: 'test-api' }, async () => { calls++; return Response.json(license); });
  now += 2 * 3600000;
  const renewed = await refresh.authorize(initial.accessToken);
  assert.ok(Date.parse(renewed.tokenExpiresAt) > now);
  license.is_cancelled = true;
  await assert.rejects(refresh.authorize(initial.accessToken), { code: 'license_inactive' });
  assert.equal(calls, 3);
});
