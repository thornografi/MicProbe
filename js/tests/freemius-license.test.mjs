import test from 'node:test';
import assert from 'node:assert/strict';
import { createFreemiusLicenses } from '../../server/freemius-license.mjs';

test('Freemius requests use Worker-compatible redirect handling and reject redirected results', async () => {
  let calls = 0;
  const licenses = createFreemiusLicenses({ apiToken: 'test-only', productId: '123', mode: 'sandbox' }, async (url, options) => {
    calls++;
    assert.equal(url.origin, 'https://api.freemius.com');
    assert.equal(options.redirect, 'manual');
    if (calls === 1) return Response.json({ id: '456' });
    return new Response(null, { status: 302, headers: { Location: 'https://other.example/licenses' } });
  });
  assert.deepEqual(await licenses.api('licenses/456.json'), { id: '456' });
  await assert.rejects(licenses.api('licenses/456.json'), { code: 'billing_temporarily_unavailable', status: 503 });
  assert.equal(calls, 2);
});
