import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateIndependentReport } from '../../server/independent-report.js';
import { usableReport, countsAsCompletedTest } from '../modules/MeasurementValidity.js';
import { createNodeAccountDb } from '../../server/node-account-db.mjs';
import { AccountStore } from '../../server/account-store.mjs';
import { ReportHistory } from '../modules/ReportHistory.js';
import { reviewReport } from './review-fixtures.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function database(t) {
  const db = createNodeAccountDb(':memory:'); t.after(() => db.close());
  const store = new AccountStore(db, 'sandbox');
  const user = await store.upsertUser({ sub: 'owner', email: 'owner@example.com', name: 'Owner' });
  const premium = async active => active ? store.saveLicense(user.id, { licenseId: '1', freemiusUserId: '1', active, verifiedAt: Date.now() })
    : store.updateLicense('1', { active: false, verifiedAt: Date.now() });
  return { db, store, user, premium };
}

test('independent missing metrics preserve valid low-level and peak findings without changing daily accounting', () => {
  const low = reviewReport('low'); delete low.audioMetrics.clipping;
  assert.equal(usableReport(low).valid, true);
  assert.equal(countsAsCompletedTest(low), false);
  const result = evaluateIndependentReport(low);
  assert.equal(result.public.summary, 'The recording has a low sound level.');
  assert.ok(result.detailed.findings.some(item => item.id === 'WEAK_SIGNAL'));
  assert.equal(result.detailed.metrics.find(item => item.key === 'clipping').value, null);
  const peak = reviewReport('peak', { signal: { rmsDb: -25, peakDb: 0 }, clipping: { status: 'measured', method: 'sample-saturation', rate: 0.0000003 } });
  assert.ok(Math.abs(evaluateIndependentReport(peak).detailed.metrics.find(item => item.key === 'clipping').value - 0.00003) < 1e-15);
  assert.ok(evaluateIndependentReport(peak).detailed.findings.some(item => item.id === 'CLIPPING'));
  peak.audioMetrics.signal.rmsDb = 1;
  assert.equal(evaluateIndependentReport(peak).public.assessment.status, 'insufficient');
});

test('near-silence and inconsistent evidence never open the future AI explanation gate', () => {
  for (const patch of [{ signal: { rmsDb: -80, peakDb: -70 } }, { source: 'live-analyser' }, { signal: { rmsDb: -10, peakDb: -20 } }]) {
    const result = evaluateIndependentReport(reviewReport('uncertain', patch));
    assert.equal(result.explanation.ai.available, false);
    assert.equal(result.explanation.ai.evidenceEligible, false);
    assert.ok(!JSON.stringify(result).includes('Were you speaking'));
  }
});

test('a valid level with simultaneous peak risk never recommends increasing gain', () => {
  const report = reviewReport('mixed', { signal: { rmsDb: -50, peakDb: 0 }, lufs: { status: 'measured', integratedStatus: 'measured', integrated: -48 },
    clipping: { status: 'measured', method: 'sample-saturation', rate: 0.01 } });
  const result = evaluateIndependentReport(report);
  assert.match(result.detailed.recommendations.find(item => item.id === 'LOW_RECORDED_LEVEL').action, /could worsen/);
  assert.ok(result.detailed.findings.some(item => item.id === 'CLIPPING'));
});

test('archive results are immutable, list responses are small, and history never enters the evaluation', async t => {
  const { store, user, premium } = await database(t); await premium(true);
  const report = reviewReport('one'); report.run.accountOwnerId = user.id;
  const first = await store.saveReport(user.id, report, 'Personal label');
  for (let i = 0; i < 4; i++) await store.saveReport(user.id, reviewReport(`unrelated${i}`, { signal: { rmsDb: -70, peakDb: -60 } }), '');
  const changed = structuredClone(report); changed.audioMetrics.signal.rmsDb = -20;
  const duplicate = await store.saveReport(user.id, changed, 'Different label');
  assert.deepEqual(duplicate, first, 'Reopening and retrying use the accepted snapshot');
  const list = await store.listReports(user.id, 20);
  assert.equal(list.reports.length, 5);
  assert.ok(list.reports.every(entry => entry.summaryOnly && !entry.report.audioMetrics && !entry.evaluation));
  assert.equal(list.reports.find(entry => entry.id === first.id).report.result.summary, first.evaluation.public.summary);
  const current = evaluateIndependentReport(report); delete current.evaluatedAt;
  const accepted = structuredClone(first.evaluation); delete accepted.evaluatedAt;
  assert.deepEqual(current, accepted);
});

test('free, pending, revoked and wrong-mode licenses cannot save new reports; old data stays readable and deletable', async t => {
  const { db, store, user, premium } = await database(t);
  await assert.rejects(store.saveReport(user.id, reviewReport('free'), ''), { code: 'premium_access_required' });
  const production = new AccountStore(db, 'production');
  await production.saveLicense(user.id, { licenseId: '2', freemiusUserId: null, active: true, verifiedAt: Date.now() });
  await assert.rejects(store.saveReport(user.id, reviewReport('wrong-mode'), ''), { code: 'premium_access_required' });
  await premium(true); const saved = await store.saveReport(user.id, reviewReport('paid'), '');
  await premium(false);
  assert.equal((await store.getReport(user.id, saved.id)).id, saved.id);
  await assert.rejects(store.saveReport(user.id, saved.report, ''), { code: 'premium_access_required' });
  await assert.rejects(store.saveReport(user.id, reviewReport('revoked'), ''), { code: 'premium_access_required' });
  assert.equal(await store.deleteReport(user.id, saved.id), true);
  await premium(true);
  await assert.rejects(store.saveReport(user.id, saved.report, ''), { code: 'report_deleted' });
});

test('deleting an uncommitted report prevents a late save, without affecting another account', async t => {
  const { store, user, premium } = await database(t); await premium(true);
  await store.deleteReport(user.id, 'in-flight', { byRun: true });
  await assert.rejects(store.saveReport(user.id, reviewReport('in-flight'), ''), { code: 'report_deleted' });
  const other = await store.upsertUser({ sub: 'other', email: 'other@example.com', name: 'Other' });
  await store.saveLicense(other.id, { licenseId: '3', freemiusUserId: '3', active: true, verifiedAt: Date.now() });
  assert.ok((await store.saveReport(other.id, reviewReport('in-flight'), '')).id);
});

test('legacy measurements and review answers survive migration, while deleted-report comparisons are removed', async t => {
  const { db, store, user, premium } = await database(t); await premium(true);
  const legacy = reviewReport('legacy');
  await db.prepare('INSERT INTO account_reports(id,user_id,run_id,report_json,note,created_at) VALUES (?,?,?,?,?,?)')
    .bind('legacy-row', user.id, legacy.run.id, JSON.stringify(legacy), 'old note', 1).run();
  const old = await store.getReport(user.id, 'legacy-row'); assert.equal(old.evaluation, null);
  const accepted = await store.freezeLegacyEvaluation(user.id, old);
  assert.deepEqual(accepted.report, legacy); assert.equal(accepted.evaluation.legacy, true);
  assert.ok(accepted.evaluation.public.scope.includes('prepared when it was reopened'));
  assert.deepEqual((await store.freezeLegacyEvaluation(user.id, old)).evaluation, accepted.evaluation);
  const other = await store.saveReport(user.id, reviewReport('other'), '');
  await store.createReview(user.id, other.id, { answers: { spoke: 'yes' }, decision: { title: 'Old finding' },
    comparison: { runId: 'legacy', differences: [{ before: 1, after: 2 }] }, history: [{ comparison: { runId: 'legacy' }, answers: { spoke: 'unknown' } }] });
  await store.deleteReport(user.id, old.id);
  const state = JSON.parse((await store.getReviewByRun(user.id, 'other')).state_json);
  assert.equal(state.comparison, null); assert.equal(state.history[0].comparison, undefined);
  assert.deepEqual(state.answers, { spoke: 'yes' });
});

test('free captures never enqueue; same-owner Premium loss invalidates an in-flight save and preserves pending ownership', async () => {
  let listener, finish; const calls = [], values = new Map();
  const state = { user: { id: 'owner' }, premium: { unlocked: false } };
  const account = { subscribe(fn) { listener = fn; fn(state); return () => {}; }, api(path, options) {
    calls.push({ path, options });
    if (options?.method === 'POST') return new Promise(resolve => { finish = resolve; });
    return Promise.resolve({ reports: [] });
  } };
  const history = new ReportHistory({ account, storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) } });
  await tick(); const report = reviewReport('free'); report.run.accountOwnerId = 'owner'; history.capture(report);
  assert.equal(history.getState().pendingCount, 0); assert.equal(values.size, 0);
  listener({ ...state, premium: { unlocked: true } }); await tick(); history.capture(report);
  assert.equal(history.getState().pendingCount, 1);
  listener(state); finish({ report: { id: 'late', report, note: '' } }); await tick();
  assert.equal(history.getState().pendingCount, 1); assert.ok(history.getState().reports.every(entry => entry.id !== 'late'));
  const before = calls.length; await history.retry(); assert.equal(calls.length, before);
  listener({ user: { id: 'other' }, premium: { unlocked: true } }); await tick();
  assert.equal(history.getState().reports.length, 0); history.destroy();
});
