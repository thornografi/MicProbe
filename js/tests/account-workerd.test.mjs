import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { unstable_splitSqlQuery } from 'wrangler';
import { reviewReport } from './review-fixtures.mjs';

// The real Worker and D1 execute in workerd. Only Google's public-key service
// and portal provider responses are replaced; signatures, fetch, cookies and D1 stay real.
test('workerd verifies Google signatures, recovers from key outages and enforces session ownership', { timeout: 60000 }, async t => {
  const origin = 'https://micprobe.example';
  const clientId = 'workerd-test.apps.googleusercontent.com';
  const keypair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', keypair.publicKey), kid: 'runtime-test', alg: 'RS256', use: 'sig' };
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../../worker/dev.js', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  let keyStatus = 503, keyRequests = 0;
  let allowBilling = false, redirectPortal = false;
  const portalCalls = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-08', d1Databases: ['MICPROBE_ACCOUNTS'],
    bindings: { MICPROBE_PUBLIC_ORIGIN: origin, MICPROBE_GOOGLE_CLIENT_ID: clientId, MICPROBE_FREEMIUS_MODE: 'sandbox',
      MICPROBE_FREEMIUS_SANDBOX_PRODUCT_ID: '33850', MICPROBE_FREEMIUS_SANDBOX_API_TOKEN: 'runtime-test-api-token' },
    outboundService: async request => {
      if (allowBilling && request.url.startsWith('https://api.freemius.com/v1/products/33850/')) {
        assert.equal(request.headers.get('Authorization'), 'Bearer runtime-test-api-token');
        portalCalls.push(request.url);
        if (request.url.includes('/licenses/101.json')) return Response.json({ id: 101, plugin_id: 33850, user_id: 202, environment: 1 });
        if (request.url.includes('/users/202.json')) return Response.json({ id: 202, email: 'runtime@gmail.com' });
        assert.equal(request.url, 'https://api.freemius.com/v1/products/33850/portal/login.json');
        assert.equal(request.method, 'POST'); assert.deepEqual(await request.json(), { id: '202' });
        return redirectPortal ? new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/portal' } })
          : Response.json({ link: 'https://customers.freemius.com/login/?token=runtime-fixture-token', token: 'runtime-fixture-token' }, { status: 201 });
      }
      assert.equal(request.url, 'https://www.googleapis.com/oauth2/v3/certs', 'Never follow a provider redirect or make unexpected requests');
      keyRequests++;
      return new Response(keyStatus === 200 ? JSON.stringify({ keys: [jwk] }) : null,
        { status: keyStatus, headers: { 'Cache-Control': 'max-age=0', ...(keyStatus === 302 ? { Location: 'https://untrusted.example/keys' } : {}) } });
    }
  }));
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database('MICPROBE_ACCOUNTS');
  const directory = new URL('../../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    const sql = (await readFile(new URL(name, directory), 'utf8')).replace(/--[^\n]*/g, '');
    await db.batch(unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)));
  }
  const request = (path, { body, cookie = '', owner, method } = {}) => runtime.dispatchFetch(origin + path, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    ...(method ? { method } : {}),
    headers: { Cookie: cookie, 'CF-Connecting-IP': '203.0.113.70', ...(owner ? { 'X-MicProbe-Account': owner } : {}),
      ...(body === undefined ? {} : { Origin: origin, 'X-MicProbe-Request': '1', 'Content-Type': 'application/json' }) }
  });
  const measured = { status: 'measured', sampleCount: 48000, durationMs: 1000,
    signal: { rmsDb: -24, peakDb: -12 }, clipping: { status: 'measured', method: 'sample-saturation', rate: 0 } };
  const guestRun = { runId: 'workerd-guest-test' };
  const guestStart = await request('/api/tests/start', { body: guestRun, owner: 'anonymous' });
  assert.equal(guestStart.status, 200, await guestStart.clone().text());
  const visitor = guestStart.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await request('/api/tests/complete', { body: { ...guestRun, evidence: measured }, cookie: visitor })).status, 200);
  const reviewAssessment = await request('/api/reviews/assess', {
    body: { report: reviewReport(guestRun.runId) }, cookie: visitor, owner: 'anonymous' });
  assert.equal(reviewAssessment.status, 200, await reviewAssessment.clone().text());
  const reviewDecision = await reviewAssessment.json();
  assert.equal(reviewDecision.summary.assessment.status, 'limited');
  assert.equal(reviewDecision.summary.ai, undefined);
  assert.equal(reviewDecision.summary.findings, undefined, 'Worker does not expose private findings to a guest');
  assert.equal((await request('/api/tests/start', { body: { runId: 'workerd-guest-blocked' }, cookie: visitor, owner: 'anonymous' })).status, 429);
  assert.equal((await request('/api/tests/start', { body: { runId: 'workerd-new-cookie-blocked' }, owner: 'anonymous' })).status, 429);
  const challenge = await request('/api/account/config');
  const { nonce } = await challenge.json();
  const proof = challenge.headers.getSetCookie()[0].split(';')[0];
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({
    sub: 'runtime-owner', aud: clientId, iss: 'https://accounts.google.com', nonce,
    email: 'runtime@example.test', email_verified: true, name: 'Runtime test',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600
  })}`;
  const signature = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keypair.privateKey, new TextEncoder().encode(payload))).toString('base64url');
  const body = { credential: `${payload}.${signature}`, rememberMe: true };
  for (const status of [503, 302]) {
    keyStatus = status;
    const failed = await request('/api/account/google', { body, cookie: proof });
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error, 'google_temporarily_unavailable');
    assert.equal(await db.prepare('SELECT count(*) AS n FROM account_sessions').first('n'), 0);
  }
  keyStatus = 200;
  const signedIn = await request('/api/account/google', { body, cookie: proof });
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
  const { user } = await signedIn.json();
  const sessionHeader = signedIn.headers.getSetCookie().find(value => value.startsWith('micprobe_session='));
  assert.match(sessionHeader, /HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
  const session = sessionHeader.split(';')[0];
  const redirectStart = await request('/api/account/google/redirect/start', { body: { confirming: true }, cookie: session, owner: user.id });
  assert.equal(redirectStart.status, 200);
  const redirectConfig = await redirectStart.json();
  const redirectPayload = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({
    sub: 'runtime-owner', aud: clientId, iss: 'https://accounts.google.com', nonce: redirectConfig.nonce,
    email: 'runtime@example.test', email_verified: true,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600
  })}`;
  const redirectSignature = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keypair.privateKey, new TextEncoder().encode(redirectPayload))).toString('base64url');
  const redirectCredential = `${redirectPayload}.${redirectSignature}`;
  const relay = await runtime.dispatchFetch(origin + '/api/account/google/redirect', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'g_csrf_token=runtime-csrf', Origin: 'https://accounts.google.com' },
    body: new URLSearchParams({ credential: redirectCredential, g_csrf_token: 'runtime-csrf' }).toString() });
  assert.equal(relay.status, 200);
  assert.equal(relay.headers.get('Cache-Control'), 'no-store');
  assert.equal(relay.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(relay.headers.get('Content-Security-Policy'), /default-src 'none'/);
  assert.ok(!relay.headers.get('Location'));
  const googleReturned = await request('/api/account/google/redirect/finish', {
    body: { credential: redirectCredential }, cookie: `${session}; ${redirectStart.headers.getSetCookie()[0].split(';')[0]}` });
  assert.equal(googleReturned.status, 200, await googleReturned.clone().text());
  assert.equal((await googleReturned.json()).user.id, user.id);
  assert.ok(googleReturned.headers.getSetCookie().every(value => !value.startsWith('micprobe_session=')));
  const quotaCookie = `${session}; ${visitor}`;
  for (let i = 0; i < 4; i++) {
    const run = { runId: `workerd-account-test-${i}` };
    assert.equal((await request('/api/tests/start', { body: run, cookie: quotaCookie, owner: user.id })).status, 200);
    assert.equal((await request('/api/tests/complete', { body: { ...run, evidence: measured }, cookie: quotaCookie, owner: user.id })).status, 200);
  }
  assert.equal((await request('/api/tests/start', { body: { runId: 'workerd-account-blocked' }, cookie: quotaCookie, owner: user.id })).status, 429);
  assert.equal(await db.prepare("SELECT count(*) AS n FROM test_runs WHERE state = 'completed' AND user_id = ?").bind(user.id).first('n'), 5);
  assert.equal((await (await request('/api/account/session', { cookie: session })).json()).user.id, user.id);
  assert.equal((await request('/api/account/google', { body, cookie: proof })).status, 401, 'Nonce is single-use');
  assert.equal((await request('/api/account/reports', { cookie: session, owner: 'other-account' })).status, 409);
  const freeSave = await request('/api/account/reports', { cookie: session, owner: user.id, body: {
    report: { version: '2.0', generatedAt: new Date().toISOString(), run: { id: 'free-denied', type: 'test', accountOwnerId: user.id } }
  } });
  assert.equal(freeSave.status, 403);
  await db.prepare('INSERT INTO account_licenses (user_id, mode, license_id, freemius_user_id, active, verified_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(user.id, 'sandbox', '101', '202', 1, Date.now()).run();
  for (let i = 0; i < 200; i++) {
    const saved = await request('/api/account/reports', { cookie: session, owner: user.id, body: {
      report: { version: '2.0', generatedAt: new Date().toISOString(), run: { id: `stored-${i}`, type: 'test', accountOwnerId: user.id } }, note: ''
    } });
    assert.equal(saved.status, 200, await saved.clone().text());
  }
  const overflow = await request('/api/account/reports', { cookie: session, owner: user.id, body: {
    report: { version: '2.0', generatedAt: new Date().toISOString(), run: { id: 'stored-overflow', type: 'test', accountOwnerId: user.id } }, note: ''
  } });
  assert.equal(overflow.status, 409);
  assert.equal((await overflow.json()).error, 'report_storage_full');
  const history = await (await request('/api/account/reports', { cookie: session, owner: user.id })).json();
  assert.equal(history.storage.reportCount, 200);
  assert.equal(history.storage.maxReports, 200);
  assert.equal((await request(`/api/account/reports/${history.reports[0].id}`, {
    cookie: session, owner: user.id, method: 'DELETE', body: {}
  })).status, 200);
  // A fresh, signed Google confirmation updates proof without replacing this
  // persistent session; the real Worker then mints a scoped portal link.
  await db.prepare("UPDATE account_licenses SET active = 0, verified_at = ? WHERE user_id = ? AND license_id = '101'").bind(Date.now(), user.id).run();
  await db.prepare('UPDATE accounts SET google_verified_at = ? WHERE id = ?').bind(Date.now() - 86400001, user.id).run();
  const stale = await request('/api/account/portal', { cookie: session, owner: user.id, body: {} });
  assert.equal(stale.status, 403); assert.equal((await stale.json()).error, 'portal_confirmation_required');
  assert.equal(portalCalls.length, 0);
  const confirmChallenge = await request('/api/account/config');
  const confirmNonce = (await confirmChallenge.json()).nonce;
  const confirmProof = confirmChallenge.headers.getSetCookie()[0].split(';')[0];
  const confirmPayload = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({
    sub: 'runtime-owner', aud: clientId, iss: 'https://accounts.google.com', nonce: confirmNonce,
    email: 'runtime@gmail.com', email_verified: true, name: 'Runtime test',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600
  })}`;
  const confirmSignature = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keypair.privateKey, new TextEncoder().encode(confirmPayload))).toString('base64url');
  const confirmed = await request('/api/account/google/confirm', { cookie: `${session}; ${confirmProof}`, owner: user.id,
    body: { credential: `${confirmPayload}.${confirmSignature}` } });
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  assert.ok(confirmed.headers.getSetCookie().every(value => !value.startsWith('micprobe_session=')));
  allowBilling = true;
  const portal = await request('/api/account/portal', { cookie: session, owner: user.id, body: {} });
  assert.equal(portal.status, 200, await portal.clone().text());
  assert.equal(portal.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await portal.json(), { ok: true, url: 'https://customers.freemius.com/login/?token=runtime-fixture-token' });
  assert.equal(portalCalls.length, 3);
  redirectPortal = true;
  const redirected = await request('/api/account/portal', { cookie: session, owner: user.id, body: {} });
  assert.equal(redirected.status, 503);
  assert.equal((await redirected.json()).error, 'billing_temporarily_unavailable');
  assert.equal((await request('/api/account/logout', { body: {}, cookie: session, owner: user.id })).status, 200);
  assert.equal((await (await request('/api/account/session', { cookie: session })).json()).user, null);
  assert.ok(keyRequests >= 3, 'JWKS fetch must actually execute inside workerd');
});
