import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewAccess } from '../modules/ReviewAccess.js';
import { reviewReport } from './review-fixtures.mjs';

test('review client deduplicates explicit actions and never sends raw audio or arbitrary report fields', async () => {
  let calls = 0, finish, sent;
  const client = new ReviewAccess({ account: { getState: () => ({ user: { id: 'owner' } }) },
    request: async (url, options) => { calls++; sent = JSON.parse(options.body); await new Promise(resolve => { finish = resolve; });
      return Response.json({ ok: true, review: { id: 'saved' } }); } });
  const report = reviewReport(); report.pcm = [1, 2, 3]; report.note = 'private text';
  const first = client.archive(report), second = client.archive(report);
  assert.equal(calls, 1); assert.equal(sent.intent, undefined); assert.equal(sent.adoptGuest, true);
  assert.equal(sent.report.pcm, undefined); assert.doesNotMatch(JSON.stringify(sent), /private text/);
  finish(); assert.deepEqual(await first, await second);
});

test('late results cannot transfer to a changed account and failed updates are not automatically replayed', async () => {
  let owner = 'A', resolve, calls = 0;
  const account = { getState: () => ({ user: { id: owner } }), refreshRejectedAccess: async () => {} };
  const client = new ReviewAccess({ account, request: async () => { calls++; return new Promise(yes => { resolve = yes; }); } });
  const pending = client.assess(reviewReport('some-run')); owner = 'B'; resolve(Response.json({ ok: true, review: { private: 'A' } }));
  await assert.rejects(pending, /account_changed/); assert.equal(calls, 1);
  const failed = client.archive(reviewReport('some-run'));
  resolve(Response.json({ ok: false, error: 'review_changed' }, { status: 409 }));
  await assert.rejects(failed, /review_changed/); assert.equal(calls, 2);
});
