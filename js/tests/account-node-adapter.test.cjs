const test = require('node:test');
const assert = require('node:assert/strict');

process.env.MICPROBE_GOOGLE_CLIENT_ID = 'adapter-test-client';
process.env.MICPROBE_ACCOUNT_DB_PATH = ':memory:';
const { server } = require('../../server.js');
let origin;
test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

test('Node adapter serves account config and browser-bound nonce without exposing secrets', async () => {
  const response = await fetch(`${origin}/api/account/config`);
  const body = await response.json();
  assert.equal(body.configured, true);
  assert.equal(body.googleClientId, 'adapter-test-client');
  assert.match(body.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.match(response.headers.get('set-cookie'), /micprobe_login_nonce_[A-Za-z0-9_-]{43}=.*HttpOnly.*SameSite=Lax/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(body.productSecret, undefined);
  assert.equal(body.apiToken, undefined);
});

test('Node account session is anonymous until verified login; API misses remain JSON', async () => {
  const session = await (await fetch(`${origin}/api/account/session`)).json();
  assert.equal(session.user, null);
  assert.equal(session.premium.unlocked, false);
  const response = await fetch(`${origin}/api/account/does-not-exist`);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.notEqual(response.status, 200);
});

test('Node adapter streams auth/report bodies to common service and enforces CSRF', async () => {
  const foreign = await fetch(`${origin}/api/account/google`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example', 'X-MicProbe-Request': '1' },
    body: JSON.stringify({ credential: 'fake' })
  });
  assert.equal(foreign.status, 403);
  const detailed = await fetch(`${origin}/api/report/detailed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-MicProbe-Request': '1', Authorization: 'Bearer fake' },
    body: JSON.stringify({ report: { audioMetrics: {} } })
  });
  assert.equal(detailed.status, 401);
  assert.equal((await detailed.json()).error, 'sign_in_required');
});

test('Node proxy deployment uses the configured HTTPS origin for cookies and billing CSRF', async () => {
  process.env.MICPROBE_PUBLIC_ORIGIN = 'https://micprobe.example';
  try {
    const response = await fetch(`${origin}/api/account/config`);
    assert.match(response.headers.get('set-cookie'), /; Secure/);
    const detailed = await fetch(`${origin}/api/report/detailed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://micprobe.example', 'X-MicProbe-Request': '1' },
      body: JSON.stringify({ report: { audioMetrics: {} } })
    });
    assert.equal(detailed.status, 401);
    assert.equal((await detailed.json()).error, 'sign_in_required');
  } finally { delete process.env.MICPROBE_PUBLIC_ORIGIN; }
});
