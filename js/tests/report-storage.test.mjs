import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeAccountDb } from '../../server/node-account-db.mjs';
import { AccountStore, REPORT_STORAGE_LIMITS } from '../../server/account-store.mjs';

async function fixture(t, paid = true) {
  const db = createNodeAccountDb(':memory:');
  t.after(() => db.close());
  const store = new AccountStore(db, 'sandbox');
  db.prepare("INSERT INTO accounts(id, google_sub, email, name, created_at, updated_at) VALUES ('owner', 'sub', 'owner@example.com', '', 0, 0)").run();
  if (paid) await store.saveLicense("owner", { licenseId: "1", freemiusUserId: "1", active: true, verifiedAt: Date.now() });
  const report = id => ({ version: '2.0', generatedAt: new Date().toISOString(), run: { id } });
  return { db, store, report };
}

test('history admission is atomic, idempotent at capacity, and deletion restores space', async t => {
  const { store, report } = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 208 }, (_, i) => store.saveReport('owner', report(`r${i}`), '')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, REPORT_STORAGE_LIMITS.premium.reports);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'report_storage_full'));
  const existing = results.find(r => r.status === 'fulfilled').value;
  assert.equal((await store.saveReport('owner', existing.report, 'different note')).id, existing.id);
  assert.equal((await store.saveReport('owner', existing.report, '')).note, '', 'Original snapshot remains immutable');
  await store.updateReportNote('owner', existing.id, '😀'.repeat(250));
  assert.equal((await store.listReports('owner', 200)).reports.length, 200);
  await store.deleteReport('owner', existing.id);
  assert.ok((await store.saveReport('owner', report('after-delete'), '')).id);
});

test('history byte limit counts UTF-8 bytes and reserves room for later note edits', async t => {
  const { store, report } = await fixture(t);
  // Several separately valid strings emulate a large normalized measurement report.
  const large = id => ({ ...report(id), logs: Array.from({ length: 12 }, () => 'ü'.repeat(7000)) });
  let accepted = 0;
  for (; accepted < 200; accepted++) {
    try { await store.saveReport('owner', large(`large${accepted}`), ''); }
    catch (error) { assert.equal(error.code, 'report_storage_full'); break; }
  }
  await assert.rejects(store.saveReport('owner', large('overflow'), ''), { code: 'report_storage_full' });
  const usage = await store.getReportStorage('owner');
  assert.equal(usage.reportCount, accepted);
  assert.ok(accepted > 0 && accepted < 200, 'Byte limit fills before the report-count limit');
  assert.ok(usage.bytes <= usage.maxBytes);
  assert.equal(usage.maxBytes, REPORT_STORAGE_LIMITS.premium.bytes);
});

test('only a verified active license in the current environment increases history capacity; downgrade preserves data', async t => {
  const { db, store, report } = await fixture(t, false);
  for (let i = 0; i < 20; i++) await db.prepare('INSERT INTO account_reports(id,user_id,run_id,report_json,note,created_at) VALUES (?,?,?,?,?,?)')
    .bind(`legacy${i}`, 'owner', `free${i}`, JSON.stringify(report(`free${i}`)), '', i).run();
  const production = new AccountStore(db, 'production');
  await production.saveLicense('owner', { licenseId: 'prod', freemiusUserId: '1', active: true, verifiedAt: Date.now() });
  await assert.rejects(store.saveReport('owner', report('wrong-mode'), ''), { code: 'premium_access_required' });
  await store.saveLicense('owner', { licenseId: 'paid', freemiusUserId: '1', active: true, verifiedAt: Date.now() });
  const saved = await store.saveReport('owner', report('paid'), 'kept');
  assert.equal((await store.getReportStorage('owner')).maxReports, 200);
  await store.updateLicense('paid', { active: false, verifiedAt: Date.now() });
  assert.equal((await store.listReports('owner', 50)).reports.length, 21);
  assert.equal((await store.getReport('owner', saved.id)).note, 'kept');
  await assert.rejects(store.saveReport('owner', saved.report, ''), { code: 'premium_access_required' });
  await assert.rejects(store.saveReport('owner', report('after-downgrade'), ''), { code: 'premium_access_required' });
});
