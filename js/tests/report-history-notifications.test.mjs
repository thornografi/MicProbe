import test from 'node:test';
import assert from 'node:assert/strict';
import { ReportHistory } from '../modules/ReportHistory.js';

test('Premium gain announces access and loading once each without uploading an old pending report', async t => {
  let accountChanged, finishLoad;
  const calls = [], notifications = [];
  const pending = { id: 'pending-run', note: 'Keep this note', pending: true,
    report: { run: { id: 'pending-run', accountOwnerId: 'owner' } } };
  const account = {
    subscribe(listener) {
      accountChanged = listener;
      listener({ user: { id: 'owner' }, premium: { unlocked: false } });
      return () => {};
    },
    api(path, options) {
      calls.push({ path, method: options?.method || 'GET' });
      return new Promise(resolve => { finishLoad = resolve; });
    }
  };
  const history = new ReportHistory({ account,
    storage: { getItem: () => JSON.stringify({ pending: { owner: [pending] } }) } });
  t.after(() => history.destroy());
  finishLoad({ reports: [] });
  await new Promise(setImmediate);
  history.subscribe(state => notifications.push(state));
  notifications.length = 0;
  calls.length = 0;

  accountChanged({ user: { id: 'owner' }, premium: { unlocked: true } });
  assert.deepEqual(notifications.map(({ premium, loading }) => ({ premium, loading })), [
    { premium: true, loading: false }, { premium: true, loading: true }
  ]);
  assert.deepEqual(calls, [{ path: '/reports', method: 'GET' }]);
  assert.ok(notifications.every(state => state.userId === 'owner' && state.pendingCount === 1));
  finishLoad({ reports: [] });
  await new Promise(setImmediate);
  assert.equal(notifications.length, 3);
  assert.equal(notifications.at(-1).loading, false);
  assert.equal(history.getState().pendingCount, 1);
  assert.deepEqual(history.getState().reports[0].report, pending.report);
  assert.deepEqual(calls, [{ path: '/reports', method: 'GET' }]);
});
