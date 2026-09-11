import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

test('Node HTTP adapter routes guest admission and settles without an account configuration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'micprobe-quota-'));
  process.env.MICPROBE_ACCOUNT_DB_PATH = join(directory, 'accounts.sqlite');
  // server.js loads .env.local before reading runtime configuration. This test
  // explicitly disables identity/billing after import, before the first API call.
  const { server } = await import('../../server.js');
  process.env.MICPROBE_GOOGLE_CLIENT_ID = '';
  process.env.MICPROBE_PUBLIC_ORIGIN = '';
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const send = async (action, body) => {
    const response = await fetch(`${origin}/api/tests/${action}`, { method: 'POST', headers: {
      Origin: origin, 'Content-Type': 'application/json', 'X-MicProbe-Request': '1',
      'X-MicProbe-Account': 'anonymous', Cookie: cookie }, body: JSON.stringify(body) });
    cookie = response.headers.getSetCookie()[0]?.split(';')[0] || cookie;
    return { status: response.status, value: await response.json() };
  };
  try {
    assert.equal((await send('start', { runId: 'node-first-test' })).status, 200);
    assert.equal((await send('complete', { runId: 'node-first-test', evidence: {
      status: 'measured', sampleCount: 48000, durationMs: 1000, signal: { rmsDb: -20, peakDb: -10 },
      clipping: { status: 'measured', method: 'sample-saturation', rate: 0 }
    } })).status, 200);
    assert.equal((await send('start', { runId: 'node-second-test' })).value.error, 'guest_test_limit');
  } finally {
    await new Promise(resolve => server.close(resolve));
    // SQLite is held by the adapter until this test process exits on Windows.
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()), 'Only remove this test-owned temporary directory');
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* OS temp cleanup */ }
  }
});
