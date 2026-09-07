import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import worker from '../../worker/dev.js';
import { createNodeAccountDb } from '../../server/node-account-db.mjs';
import { createLegacyPremium } from '../../server/legacy-premium.mjs';

const require = createRequire(import.meta.url);
const realFetch = globalThis.fetch;
const origin = 'https://micprobe.example';
const user = 'guidance-owner';
const sessionToken = 'x'.repeat(43);
const license = { id: '101', plugin_id: '33850', plan_id: '55641', user_id: '202',
  environment: 0, is_cancelled: false, expiration: null, secret_key: 'sk_guidance-entitlement-fixture' };
const report = {
  version: '2.0', generatedAt: '2026-09-05T12:00:00Z', run: { id: 'help-without-recording', type: 'troubleshooting' },
  troubleshooting: { version: 1, usage: 'voice-call', os: 'windows', osSource: 'user-selected', symptom: 'no-input' },
  audioMetrics: null, deepAnalysis: null, system: null
};

async function adapter(t, kind, accountMode) {
  let directory, db;
  const env = {
    MICPROBE_FREEMIUS_MODE: 'production', MICPROBE_FREEMIUS_PRODUCTION_PRODUCT_ID: '33850',
    MICPROBE_FREEMIUS_PRODUCTION_PLAN_ID: '55641', MICPROBE_FREEMIUS_PRODUCTION_PRICING_ID: '',
    MICPROBE_FREEMIUS_PRODUCTION_PRODUCT_SECRET: 'test-secret', MICPROBE_FREEMIUS_PRODUCTION_API_TOKEN: 'test-api',
    MICPROBE_FREEMIUS_PRODUCTION_SUCCESS_URL: origin + '/app', MICPROBE_PUBLIC_ORIGIN: '',
    MICPROBE_GOOGLE_CLIENT_ID: accountMode ? 'fixture-client' : ''
  };
  if (accountMode) {
    if (kind === 'Node') {
      const root = resolve('.tmp');
      mkdirSync(root, { recursive: true });
      directory = mkdtempSync(join(root, 'report-detail-regression-'));
      env.MICPROBE_ACCOUNT_DB_PATH = join(directory, 'accounts.sqlite');
    }
    db = createNodeAccountDb(env.MICPROBE_ACCOUNT_DB_PATH || ':memory:');
    await db.prepare('INSERT INTO accounts (id,google_sub,email,name,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .bind(user, 'fixture-sub', 'fixture@example.com', 'Fixture', Date.now(), Date.now()).run();
    await db.prepare('INSERT INTO account_sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)')
      .bind(createHash('sha256').update(sessionToken).digest('base64url'), user, Date.now(), Date.now() + 60000).run();
    await db.prepare('INSERT INTO account_licenses (user_id,mode,license_id,freemius_user_id,active,verified_at) VALUES (?,?,?,?,?,?)')
      .bind(user, 'production', '101', '202', 1, Date.now()).run();
  }
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(new URL(url).hostname, 'api.freemius.com');
    return Response.json(String(url).includes('/licenses.json') ? { licenses: [license] } : license);
  });
  const entitlement = !accountMode && await createLegacyPremium({ mode: 'production', productId: '33850', planId: '55641',
    productSecret: 'test-secret', apiToken: 'test-api' }).restore(license.secret_key);
  let send;
  if (kind === 'Worker') {
    if (db) env.MICPROBE_ACCOUNTS = db;
    send = (body, authorized = true) => worker.fetch(new Request(origin + '/api/report/detailed', {
      method: 'POST', headers: headers(origin, authorized), body: JSON.stringify({ report: body })
    }), env);
    t.after(() => db?.close());
  } else {
    // The endpoint opens its own connection to this same fixture database.
    db?.close();
    const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    delete require.cache[require.resolve('../../server.js')];
    const { server } = require('../../server.js');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const local = `http://127.0.0.1:${server.address().port}`;
    send = (body, authorized = true) => realFetch(local + '/api/report/detailed', {
      method: 'POST', headers: headers(local, authorized), body: JSON.stringify({ report: body })
    });
    t.after(async () => {
      await new Promise(resolve => server.close(resolve));
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      // Windows keeps the Node account connection open for the process lifetime;
      // this small fixture stays under .tmp until process exit.
    });
  }
  function headers(requestOrigin, authorized) {
    return { Origin: requestOrigin, 'X-MicProbe-Request': '1', 'Content-Type': 'application/json',
      ...(accountMode ? { 'X-MicProbe-Account': user, ...(authorized ? { Cookie: `micprobe_session=${sessionToken}` } : {}) }
        : { Authorization: `Bearer ${authorized ? entitlement.accessToken : 'invalid-token'}` }) };
  }
  return send;
}

for (const kind of ['Node', 'Worker']) for (const accountMode of [false, true]) {
  test(`${kind} ${accountMode ? 'account' : 'legacy'} detailed endpoint accepts guidance without inventing measurements and preserves authorization`, async t => {
    const send = await adapter(t, kind, accountMode);
    assert.equal((await send(report, false)).status, accountMode ? 401 : 403);
    const response = await send(report);
    assert.equal(response.status, 200, await response.clone().text());
    const { detailed } = await response.json();
    assert.deepEqual(detailed.metrics, []);
    assert.equal(detailed.recommendations[0].id, 'GUIDE_WINDOWS_INPUT');
    const injected = await send({ ...report, audioMetrics: { status: 'measured', sampleCount: 48000, durationMs: 1000,
      signal: { rmsDb: -80, peakDb: -70 }, clipping: { status: 'measured', method: 'sample-saturation', rate: 0.9 } },
      system: { correlation: { findings: [{ id: 'CPU_LIKELY' }] } }, deepAnalysis: { status: 'ready' } });
    assert.equal(injected.status, 200);
    assert.deepEqual((await injected.json()).detailed, detailed);
    for (const invalid of [null, [], {}, { ...report, troubleshooting: null }, { ...report, troubleshooting: [] },
      { ...report, troubleshooting: { version: 2 } }, { ...report, run: { type: 'troubleshooting' } },
      { ...report, run: { id: 'measured', type: 'record' } }, { audioMetrics: [] }, { audioMetrics: 'invalid' }]) {
      const rejected = await send(invalid);
      assert.equal(rejected.status, 400, JSON.stringify(invalid));
      assert.equal((await rejected.json()).error, 'missing_report');
    }
    const measured = await send({ run: { id: 'measured', type: 'record' }, audioMetrics: {} });
    assert.equal(measured.status, 200);
    assert.equal((await measured.json()).detailed.recommendations[0].id, 'INSUFFICIENT_AUDIO');
  });
}
