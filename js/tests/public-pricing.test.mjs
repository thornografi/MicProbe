import test from 'node:test';
import assert from 'node:assert/strict';
import { publicPricingResponse } from '../../server/public-pricing.mjs';
import worker from '../../worker/dev.js';

const config = { productId: '33850', planId: '55641', apiToken: 'private-fixture-token', mode: 'sandbox', billingCycle: 'lifetime' };
const tier = { id: '73203', plan_id: '55641', currency: 'usd', licenses: 1, lifetime_price: 7.99, is_hidden: false };
const reply = pricing => async () => Response.json({ pricing });

test('public price comes from the checkout plan and exposes only amount, currency and billing cycle', async () => {
  const response = await publicPricingResponse(config, { fetchImpl: async (url, options) => {
    assert.equal(url.origin, 'https://api.freemius.com');
    assert.equal(url.pathname, '/v1/products/33850/plans/55641/pricing.json');
    assert.equal(url.searchParams.get('currency'), 'usd');
    assert.equal(options.headers.Authorization, 'Bearer private-fixture-token');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ pricing: [{ ...tier, secret: 'never-public' }] });
  } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { amount: 7.99, currency: 'USD', billingCycle: 'lifetime' });
});

test('configured checkout currency and tier select the matching public lifetime price', async () => {
  const checkoutUrl = 'https://checkout.freemius.com/product/33850/plan/55641/?currency=eur&licenses=3&pricing_id=44';
  const response = await publicPricingResponse({ ...config, checkoutUrl }, { fetchImpl: reply([
    tier, { ...tier, id: '44', currency: 'eur', licenses: 3, lifetime_price: '22.50' }
  ]) });
  assert.deepEqual(await response.json(), { amount: 22.5, currency: 'EUR', billingCycle: 'lifetime' });
});

test('hidden, ambiguous, unavailable or wrong-plan prices never become a free or invented offer', async () => {
  for (const rows of [[], [tier, { ...tier, id: 'other' }], [{ ...tier, is_hidden: true }],
    [{ ...tier, plan_id: 'other' }], [{ ...tier, currency: 'eur' }], [{ ...tier, licenses: 3 }],
    ...[null, '', ' ', 'invalid', 0, -1, false, {}].map(value => [{ ...tier, lifetime_price: value }])]) {
    const response = await publicPricingResponse(config, { fetchImpl: reply(rows) });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'pricing_unavailable' });
  }
});

test('configuration mismatches fail before contacting the provider', async () => {
  for (const change of [{ apiToken: '' }, { planId: '' }, { billingCycle: 'monthly' },
    { checkoutUrl: 'https://other.example/product/33850/plan/55641/' },
    { checkoutUrl: 'https://checkout.freemius.com/product/33850/plan/999/' },
    { pricingId: '1', checkoutUrl: 'https://checkout.freemius.com/product/33850/plan/55641/?pricing_id=2' }]) {
    const response = await publicPricingResponse({ ...config, ...change }, {
      fetchImpl: () => { assert.fail('No fetch for incompatible configuration'); }
    });
    assert.equal(response.status, 503);
  }
});

test('provider errors, redirects, oversized and malformed replies have a safe retryable response', async () => {
  for (const fetchImpl of [async () => { throw new Error('network private-fixture-token'); },
    async () => new Response('', { status: 401 }), async () => new Response('', { status: 302, headers: { Location: 'https://other.example' } }),
    async () => new Response('bad json'), async () => new Response('x'.repeat(256 * 1024 + 1))]) {
    const response = await publicPricingResponse(config, { fetchImpl });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'pricing_unavailable' });
  }
});

test('only verified public prices are cached and the key isolates plan, mode and tier', async () => {
  const saved = new Map();
  let requests = 0;
  const cache = { async match(key) { return saved.get(key.url)?.clone(); }, async put(key, value) { saved.set(key.url, value); } };
  const options = { cache, origin: 'https://micprobe.example', fetchImpl: async () => { requests++; return Response.json({ pricing: [tier] }); } };
  await publicPricingResponse(config, options);
  await publicPricingResponse(config, options);
  assert.equal(requests, 1);
  await publicPricingResponse({ ...config, mode: 'production' }, options);
  assert.equal(requests, 2);
  assert.ok([...saved.keys()].every(key => !key.includes('token')));
  const error = await publicPricingResponse({ ...config, planId: '999' }, options);
  assert.equal(error.status, 503);
  assert.equal(saved.size, 2);
});

test('Node and Worker expose the same public price without accounts, cookies or query overrides', async t => {
  const keys = { MICPROBE_FREEMIUS_MODE: 'sandbox', MICPROBE_FREEMIUS_SANDBOX_PRODUCT_ID: '33850',
    MICPROBE_FREEMIUS_SANDBOX_PLAN_ID: '55641', MICPROBE_FREEMIUS_SANDBOX_API_TOKEN: 'private-fixture-token' };
  const originals = Object.fromEntries(Object.keys(keys).map(key => [key, process.env[key]]));
  Object.assign(process.env, keys);
  t.after(() => { for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => new URL(url).hostname === 'api.freemius.com'
    ? reply([tier])(url, options) : nativeFetch(url, options));
  const { server } = await import('../../server.js');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const query = '?product=other&plan=other&currency=eur';
  const nodeResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/pricing${query}`);
  const workerResponse = await worker.fetch(new Request(`https://micprobe.example/api/pricing${query}`, { headers: { Cookie: 'private-session' } }), keys);
  for (const response of [nodeResponse, workerResponse]) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
    assert.deepEqual(await response.json(), { amount: 7.99, currency: 'USD', billingCycle: 'lifetime' });
  }
});
