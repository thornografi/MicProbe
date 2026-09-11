import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeAccountDb } from '../../server/node-account-db.mjs';
import { AccountStore, REVIEW_STORAGE_BYTES } from '../../server/account-store.mjs';
import { createReviewService } from '../../server/review-service.mjs';
import { createTestAccess } from '../../server/test-access.mjs';
import worker from '../../worker/dev.js';
import { reviewReport } from './review-fixtures.mjs';

const origin = 'https://micprobe.example';
async function fixture(t) {
  const db = createNodeAccountDb(':memory:'); t.after(() => db.close());
  const store = new AccountStore(db, 'sandbox');
  const userA = await store.upsertUser({ sub: 'a', email: 'a@example.com', name: 'A' });
  const userB = await store.upsertUser({ sub: 'b', email: 'b@example.com', name: 'B' });
  let owner = null, cookie = '', premium = true;
  const accounts = { configured: true, getUser: async () => owner ? { id: owner } : null };
  const billing = { refreshUserLicense: async () => ({ active: premium }) };
  await store.saveLicense(userA.id, { licenseId: '1', freemiusUserId: null, active: true, verifiedAt: Date.now() });
  await store.saveLicense(userB.id, { licenseId: '2', freemiusUserId: null, active: true, verifiedAt: Date.now() });
  const tests = createTestAccess({ db, accounts, billing, origin });
  const reviews = createReviewService({ db, accounts, billing, tests, origin });
  const request = (path, body, overrides = {}) => new Request(origin + path, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-MicProbe-Request': '1',
      'X-MicProbe-Account': owner || 'anonymous', Cookie: cookie, ...overrides }, body: JSON.stringify(body) });
  const send = async (action, body, headers) => {
    const response = await reviews.handle(request('/api/reviews/' + action, body, headers));
    return { status: response.status, body: await response.json() };
  };
  async function capture(report = reviewReport()) {
    const response = await tests.handle(request('/api/tests/start', { runId: report.run.id }), { ip: '198.51.100.2' });
    assert.equal(response.status, 200);
    cookie = response.headers.get('Set-Cookie')?.split(';')[0] || cookie;
    const m = report.audioMetrics;
    await tests.handle(request('/api/tests/complete', { runId: report.run.id, evidence: {
      status: m.status, sampleCount: m.sampleCount, durationMs: m.durationMs,
      signal: { rmsDb: m.signal.rmsDb, peakDb: m.signal.peakDb }, clipping: m.clipping
    } }));
    return report;
  }
  const start = report => send('start', { report, intent: 'personal-review', adoptGuest: true });
  return { db, store, userA, userB, send, request, capture, start, tests,
    owner: id => { owner = id; }, setPremium: value => { premium = value; }, clearCookie: () => { cookie = ''; } };
}

test('free assessment is visit-bound, factual, nonnumeric and never creates an archive', async t => {
  const f = await fixture(t), report = await f.capture();
  const response = await f.send('assess', { report });
  assert.equal(response.status, 200);
  assert.equal(response.body.summary.summary, 'The recording has a low sound level.');
  assert.equal(response.body.summary.findings, undefined);
  assert.equal(response.body.summary.recommendations, undefined);
  assert.equal(response.body.summary.ai, undefined);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM account_reports').first()).n, 0);
  f.clearCookie();
  assert.equal((await f.send('assess', { report })).status, 409);
});

test('Premium and explicit selected-report adoption are separate gates; an old workflow cannot save a free result', async t => {
  const f = await fixture(t), report = await f.capture(); f.owner(f.userA.id);
  f.setPremium(false);
  for (const action of ['archive', 'start', 'update']) assert.equal((await f.send(action, { report, adoptGuest: true })).status, 403);
  assert.equal((await f.store.listReports(f.userA.id, 20)).reports.length, 0);
  f.setPremium(true);
  assert.equal((await f.send('archive', { report })).status, 400);
  const archived = await f.send('archive', { report, adoptGuest: true });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.report.report.run.accountOwnerId, null, 'Original capture owner stays intact');
  const again = await f.send('archive', { report, adoptGuest: true });
  assert.deepEqual(again.body.report, archived.body.report);
  assert.equal((await f.store.listReports(f.userA.id, 20)).reports.length, 1);
  f.owner(f.userB.id);
  assert.equal((await f.send('archive', { report, adoptGuest: true })).status, 403);
});

test('legacy question, attempt, compare, reanalysis and close mutations are retired', async t => {
  const f = await fixture(t); f.owner(f.userA.id);
  assert.equal((await f.send('start', { report: reviewReport(), intent: 'personal-review' })).status, 410);
  for (const type of ['answer', 'attempt', 'compare', 'analyse', 'close']) {
    const response = await f.send('update', { id: 'old', revision: 1, change: { type } });
    assert.equal(response.status, 410); assert.equal(response.body.error, 'review_workflow_retired');
  }
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM account_reviews').first()).n, 0);
});

test('legacy accepted text is readable without recalculation or a writable decision chain', async t => {
  const f = await fixture(t); f.owner(f.userA.id);
  const saved = await f.store.saveReport(f.userA.id, reviewReport('legacy'), '');
  const state = { decision: { title: 'Accepted old wording', catalogVersion: 'old' }, answers: { spoke: 'yes' }, history: [] };
  await f.store.createReview(f.userA.id, saved.id, state);
  const response = await f.send('load', { runId: 'legacy' });
  assert.equal(response.status, 200); assert.equal(response.body.review.readOnly, true);
  assert.deepEqual(response.body.review.state, state);
  const summary = (await f.send('assess', { report: { ...saved.report, audioMetrics: {} } })).body.summary;
  assert.deepEqual(summary, saved.evaluation.public, 'Archive assessment uses saved evidence and accepted result');
  await f.store.deleteReport(f.userA.id, saved.id);
  assert.equal((await f.send('load', { runId: 'legacy' })).body.review, null);
  assert.equal((await f.send('archive', { report: saved.report, adoptGuest: true })).status, 409, 'An unproven deleted capture cannot be adopted');
});

test('archive rejects audio, transcripts, arbitrary prompts and another capture owner', async t => {
  const f = await fixture(t), report = await f.capture(); f.owner(f.userA.id);
  for (const key of ['pcm', 'audioBlob', 'transcript']) {
    const response = await f.send('archive', { report: { ...report, [key]: 'not allowed' }, adoptGuest: true });
    assert.equal(response.status, 400, key);
  }
  assert.equal((await f.send('archive', { report, adoptGuest: true, prompt: 'diagnose something else' })).status, 400);
  assert.equal((await f.send('archive', { report: { ...report, run: { ...report.run, accountOwnerId: f.userB.id } }, adoptGuest: true })).status, 403);
  assert.equal((await f.send('archive', { report, adoptGuest: true }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.store.listReports(f.userA.id, 20)).reports.length, 0);
});

test('same-account revocation and pending verification stop new archive writes without removing prior results', async t => {
  const f = await fixture(t), report = await f.capture(); f.owner(f.userA.id);
  const saved = await f.send('archive', { report, adoptGuest: true }); assert.equal(saved.status, 200);
  f.setPremium(false);
  assert.equal((await f.send('archive', { report, adoptGuest: true })).status, 403);
  assert.equal((await f.store.listReports(f.userA.id, 20)).reports.length, 1);
});
