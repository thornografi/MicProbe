import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeAccountDb } from '../../server/node-account-db.mjs';
import { createTestAccess } from '../../server/test-access.mjs';

const origin = 'https://micprobe.example';
const evidence = { status: 'measured', sampleCount: 48000, durationMs: 1000,
  signal: { rmsDb: -24, peakDb: -12 }, clipping: { status: 'measured', method: 'sample-saturation', rate: 0 } };

function fixture(t, options = {}) {
  const db = createNodeAccountDb(':memory:');
  t.after(() => db.close());
  let time = Date.parse('2026-09-11T12:00:00Z'), n = 0;
  const premiums = new Set();
  const accounts = { configured: true, getUser: async request => {
    const id = request.headers.get('Cookie')?.match(/session=([\w-]+)/)?.[1];
    return id ? { id } : null;
  } };
  const service = createTestAccess({ db, accounts, billing: { refreshUserLicense: async id => ({ active: premiums.has(id) }) },
    origin, now: () => time, ...options });
  function browser(owner = null) {
    const visitor = { owner, cookie: '' };
    visitor.send = async (action, body, extra = {}) => {
      const response = await service.handle(new Request(`${origin}/api/tests/${action}`, { method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', 'X-MicProbe-Request': '1',
          'X-MicProbe-Account': visitor.owner || 'anonymous',
          Cookie: [visitor.cookie, visitor.owner ? `session=${visitor.owner}` : ''].filter(Boolean).join('; '), ...extra.headers },
        body: JSON.stringify(body) }), { ip: extra.ip || '203.0.113.1' });
      const cookie = response.headers.get('Set-Cookie');
      if (cookie) visitor.cookie = cookie.split(';')[0];
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
    visitor.start = (id = `test-run-${++n}`) => visitor.send('start', { runId: id }).then(result => ({ ...result, id }));
    visitor.complete = id => visitor.send('complete', { runId: id, evidence });
    return visitor;
  }
  return { db, browser, premiums, setTime: value => { time = value; }, advance: ms => { time += ms; } };
}

test('guest has two completed tests; repeats are idempotent and a third requires sign-in', async t => {
  const { browser, db } = fixture(t), guest = browser();
  const first = await guest.start();
  assert.equal(first.status, 200);
  assert.match(first.headers.get('Set-Cookie'), /HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
  const second = await guest.start();
  assert.equal(second.status, 200);
  assert.equal((await guest.start()).body.error, 'guest_test_limit', 'Two reservations occupy capacity');
  await guest.complete(first.id);
  await guest.complete(first.id);
  assert.equal((await guest.start(first.id)).body.error, 'test_run_finished', 'Cannot replay a completed run to start again');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM test_runs WHERE state = 'completed'").first()).n, 1);
  await guest.complete(second.id);
  assert.equal((await guest.start()).body.error, 'guest_test_limit');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM account_reports').first()).n, 0, 'No guest report persisted');
});

test('two guest tests carry into five total account tests across tabs/devices', async t => {
  const { browser, premiums } = fixture(t), a = browser();
  const first = await a.start(); await a.complete(first.id);
  const second = await a.start(); await a.complete(second.id);
  a.owner = 'account-a';
  for (let i = 0; i < 3; i++) { const run = await a.start(); assert.equal(run.status, 200); await a.complete(run.id); }
  assert.equal((await a.start()).body.error, 'free_test_limit');
  assert.equal((await browser('account-a').start()).body.error, 'free_test_limit', 'A fresh device cannot reset account usage');
  a.owner = null;
  assert.equal((await a.start()).body.error, 'guest_test_limit');
  a.owner = 'account-a';
  assert.equal((await a.start()).body.error, 'free_test_limit');
  assert.equal((await browser('account-b').start()).status, 200, 'Different account keeps its own quota');
  premiums.add('account-a');
  for (let i = 0; i < 8; i++) { const run = await a.start(); assert.equal(run.status, 200); await a.complete(run.id); }
});

test('releases, short samples and missing analysis do not consume quota; failed starts cannot fake a grant', async t => {
  const { browser } = fixture(t), a = browser();
  const first = await a.start();
  await a.send('release', { runId: first.id });
  await a.complete(first.id); // late completion cannot resurrect cancellation
  for (const patch of [{ durationMs: 100 }, { status: 'unavailable' }, { signal: { rmsDb: null, peakDb: null } }]) {
    const run = await a.start(); assert.equal(run.status, 200);
    assert.equal((await a.send('complete', { runId: run.id, evidence: { ...evidence, ...patch } })).status, 200);
  }
  const run = await a.start(); assert.equal(run.status, 200);
  assert.equal((await browser().complete(run.id)).status, 409, 'Another visitor cannot settle the reservation');
});

test('atomic reservations enforce five under concurrency; expired leases and UTC rollover recover capacity', async t => {
  const { browser, advance, setTime } = fixture(t), a = browser('a');
  const first = await a.start(); await a.send('release', { runId: first.id });
  const results = await Promise.all(Array.from({ length: 12 }, () => a.start()));
  assert.equal(results.filter(result => result.status === 200).length, 5);
  advance(10 * 60000 + 1);
  const recovered = await a.start(); assert.equal(recovered.status, 200);
  await a.complete(recovered.id);
  setTime(Date.parse('2026-09-12T00:00:00Z'));
  const next = await Promise.all(Array.from({ length: 6 }, () => a.start()));
  assert.equal(next.filter(result => result.status === 200).length, 5);
});

test('visitor-creation burst never blocks authenticated accounts; releases restore network capacity', async t => {
  const { browser, db, advance } = fixture(t, { visitorBurst: 3 });
  for (let i = 0; i < 3; i++) {
    const guest = browser(), run = await guest.start();
    assert.equal(run.status, 200);
    await guest.send('release', { runId: run.id });
  }
  assert.equal((await browser().start()).body.error, 'test_access_busy');
  assert.equal((await browser('signed-in').start()).status, 200);
  const rows = (await db.prepare('SELECT * FROM test_visitor_rates').all()).results;
  assert.ok(rows.every(row => !JSON.stringify(row).includes('203.0.113.1')));
  advance(3600000);
  assert.equal((await browser().start()).status, 200);
});

test('clearing cookies cannot reset the daily anonymous IP allowance; account quotas stay independent', async t => {
  const { browser, db, advance } = fixture(t);
  const first = browser(), run = await first.start();
  const second = await first.start();
  assert.equal(second.status, 200);
  assert.equal((await browser().start()).body.error, 'guest_test_limit', 'Another browser shares active reservation');
  await first.complete(run.id);
  await first.complete(second.id);
  first.cookie = '';
  assert.equal((await first.start()).body.error, 'guest_test_limit', 'Cookie reset cannot reset network quota');
  for (const user of ['household-a', 'household-b']) {
    const account = browser(user);
    for (let i = 0; i < 5; i++) { const item = await account.start(); assert.equal(item.status, 200); await account.complete(item.id); }
    assert.equal((await account.start()).body.error, 'free_test_limit');
  }
  assert.equal((await browser().send('start', { runId: 'different-network' }, { ip: '203.0.113.2' })).status, 200);
  const rows = (await db.prepare('SELECT guest_network_hash FROM test_runs').all()).results;
  assert.ok(rows.some(row => /^[a-f0-9]{64}$/.test(row.guest_network_hash)));
  assert.ok(rows.every(row => !JSON.stringify(row).includes('203.0.113.')));
  advance(86400000);
  assert.equal((await browser().start()).status, 200, 'UTC day has a fresh salt and allowance');
});

test('simultaneous fresh visitors cannot race past the anonymous network allowance', async t => {
  const { browser, advance } = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => browser().start()));
  assert.equal(results.filter(result => result.status === 200).length, 2);
  advance(10 * 60000 + 1);
  assert.equal((await browser().start()).status, 200, 'An abandoned reservation releases network capacity');
});

test('strict origin, ownership, body allowlist and missing database fail closed', async t => {
  const { browser } = fixture(t), a = browser('a');
  assert.equal((await a.send('start', { runId: 'valid-run' }, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await a.send('start', { runId: 'valid-run' }, { headers: { 'X-MicProbe-Account': 'b' } })).body.error, 'account_changed');
  assert.equal((await a.send('start', { runId: 'valid-run', audio: 'never' })).status, 400);
  const first = await a.start();
  assert.equal((await a.send('complete', { runId: first.id, evidence: { ...evidence, pcm: [0, 1] } })).status, 400);
  const unavailable = createTestAccess({ accounts: {}, billing: {} });
  assert.equal((await unavailable.handle(new Request(`${origin}/api/tests/start`, { method: 'POST' }))).status, 503);
});

test('guided early/incomplete and hidden captures release quota; sufficient early speech still counts', async t => {
  const { browser } = fixture(t), visitor = browser();
  for (const [durationMs, interrupted] of [[1000, false], [4000, false], [6500, false], [10000, true]]) {
    const run = await visitor.start(); assert.equal(run.status, 200);
    const recording = { stopReason: 'user', guidedSegments: { version: 1, method: 'user-guided-file-segments', interrupted,
      quiet: durationMs < 3000 ? null : { startMs: 500, endMs: 2500 },
      speaking: durationMs < 3000 ? null : { startMs: 3500, endMs: durationMs - 500 } } };
    assert.equal((await visitor.send('complete', { runId: run.id, evidence: { ...evidence, durationMs, recording } })).status, 200);
  }
  const recording = { stopReason: 'user', guidedSegments: { version: 1, method: 'user-guided-file-segments', interrupted: false,
    quiet: { startMs: 500, endMs: 2500 }, speaking: { startMs: 3500, endMs: 6500 } } };
  for (let i = 0; i < 2; i++) {
    const run = await visitor.start(); assert.equal(run.status, 200);
    assert.equal((await visitor.send('complete', { runId: run.id,
      evidence: { ...evidence, durationMs: 7000, recording } })).status, 200);
  }
  assert.equal((await visitor.start()).status, 429);
});
