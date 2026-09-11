import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/dev.js';
import { createNodeAccountDb } from '../../server/node-account-db.mjs';

const origin = 'https://micprobe.example';

test('Worker redirects old page URLs to the canonical host, preserving path and query', async () => {
  const env = { MICPROBE_PUBLIC_ORIGIN: origin };
  for (const method of ['GET', 'HEAD']) {
    for (const path of ['/', '/app?checkout=returned', '/privacy.html', '//other.example/path?x=1']) {
      const response = await worker.fetch(new Request(`https://old.example${path}`, { method }), env);
      assert.equal(response.status, 308);
      assert.equal(response.headers.get('location'), `${origin}${path}`);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
  }
});

test('Worker serves canonical pages and keeps unconfigured development hosts usable', async () => {
  for (const publicOrigin of [origin, undefined]) {
    const env = { MICPROBE_PUBLIC_ORIGIN: publicOrigin,
      ASSETS: { fetch: async request => new Response(new URL(request.url).pathname) } };
    const response = await worker.fetch(new Request(`${origin}/privacy.html`), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('location'), null);
    assert.equal(await response.text(), '/privacy.html');
  }
});

test('Worker does not redirect page mutations between hosts', async () => {
  const response = await worker.fetch(new Request('https://old.example/privacy.html', { method: 'POST' }),
    { MICPROBE_PUBLIC_ORIGIN: origin });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('location'), null);
});

function fixture(t) {
  const db = createNodeAccountDb(':memory:');
  t.after(() => db.close());
  const env = { MICPROBE_ACCOUNTS: db, MICPROBE_GOOGLE_CLIENT_ID: 'worker-test-client',
    MICPROBE_FREEMIUS_MODE: 'sandbox', MICPROBE_PUBLIC_ORIGIN: origin };
  const send = (path, options) => worker.fetch(new Request(`${origin}${path}`, options), env);
  return { db, env, send };
}

test('Worker uses the D1 binding for a secure nonce and returns no secrets', async t => {
  const f = fixture(t);
  const response = await f.send('/api/account/config');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('set-cookie'), /HttpOnly.*SameSite=Lax.*Secure/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const body = await response.json();
  assert.equal(body.googleClientId, 'worker-test-client');
  assert.match(body.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await f.db.prepare('SELECT count(*) AS n FROM account_login_challenges').first('n'), 1);
});

test('Worker routes account errors as JSON and rejects foreign origin mutations', async t => {
  const f = fixture(t);
  const response = await f.send('/api/account/google', { method: 'POST',
    headers: { Origin: 'https://other.example', 'Content-Type': 'application/json', 'X-MicProbe-Request': '1' },
    body: JSON.stringify({ credential: 'fake' }) });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'request_origin');
  const wrongHost = await worker.fetch(new Request('https://other.example/api/account/config'), f.env);
  assert.equal(wrongHost.status, 403);
});

test('Worker cannot downgrade account mode when a D1 binding is missing', async t => {
  const f = fixture(t);
  delete f.env.MICPROBE_ACCOUNTS;
  const config = await f.send('/api/account/config');
  assert.equal(config.status, 503);
  const response = await f.send('/api/report/detailed', { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-MicProbe-Request': '1', Authorization: 'Bearer legacy' },
    body: JSON.stringify({ report: { audioMetrics: {} } }) });
  assert.notEqual(response.status, 200);
  assert.notEqual((await response.json()).error, 'invalid_entitlement');
});

test('Worker history checks the expected account before reading D1 reports', async t => {
  const f = fixture(t);
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
  await f.db.prepare('INSERT INTO accounts (id,google_sub,email,name,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .bind('user-b', 'google-b', 'b@example.com', 'B', Date.now(), Date.now()).run();
  await f.db.prepare('INSERT INTO account_sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)')
    .bind(hash, 'user-b', Date.now(), Date.now() + 60000).run();
  const headers = { Cookie: `micprobe_session=${token}`, 'X-MicProbe-Account': 'user-a' };
  const wrong = await f.send('/api/account/reports', { headers });
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json()).error, 'account_changed');
  headers['X-MicProbe-Account'] = 'user-b';
  const own = await f.send('/api/account/reports', { headers });
  assert.equal(own.status, 200);
  assert.deepEqual((await own.json()).reports, []);
});
