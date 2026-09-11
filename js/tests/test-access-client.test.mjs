import test from 'node:test';
import assert from 'node:assert/strict';
import { TestAccess } from '../modules/TestAccess.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const snapshot = { runId: 'test-run-1', accountOwnerId: null };
function fixture(request) {
  const values = new Map(), calls = [], blocked = [];
  const state = { ready: true, user: null };
  const options = { storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    account: { bootstrap: async () => state, getState: () => state, refresh: async () => state },
    onBlocked: code => blocked.push(code), locks: null,
    request: async (url, init) => { calls.push({ url, body: JSON.parse(init.body), keepalive: init.keepalive }); return request ? request(url, init) : Response.json({ ok: true }); } };
  return { access: new TestAccess(options), options, calls, blocked, state, values };
}

test('only a new matching report settles once; quota API never receives audio or the full report', async () => {
  const { access, calls } = fixture();
  assert.equal(await access.begin(snapshot), true);
  await access.complete({ run: { id: 'old-result' } });
  assert.equal(calls.length, 1);
  const report = { run: { id: snapshot.runId }, audio: new Blob(['private']), logs: ['private'],
    audioMetrics: { status: 'measured', sampleCount: 500, durationMs: 1000, signal: { rmsDb: -20, peakDb: -10 },
      clipping: { status: 'measured', method: 'sample-saturation', rate: 0 }, pcm: new Float32Array(500) } };
  await Promise.all([access.complete(report), access.complete(report)]);
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(calls[1].body), ['runId', 'evidence']);
  assert.ok(!JSON.stringify(calls).includes('private'));
  assert.ok(!JSON.stringify(calls).includes('pcm'));
});

test('pending reservations recover after reload and lost completions retry before another start', async () => {
  let offline = false;
  const f = fixture(async url => { if (offline) throw new Error('offline'); return Response.json({ ok: true }); });
  await f.access.begin(snapshot);
  const recovered = new TestAccess(f.options);
  assert.equal(await recovered.begin({ ...snapshot, runId: 'test-run-2' }), true);
  assert.ok(f.calls[1].url.endsWith('/release'));
  offline = true;
  await recovered.complete({ run: { id: 'test-run-2' } });
  assert.equal(await recovered.begin({ ...snapshot, runId: 'test-run-3' }), false);
  offline = false;
  assert.equal(await recovered.begin({ ...snapshot, runId: 'test-run-4' }), true);
  assert.ok(f.calls.at(-2).url.endsWith('/complete'));
});

test('quota refusal is a visible limit result without a microphone exception', async () => {
  const { access, blocked } = fixture(() => Response.json({ ok: false, error: 'guest_test_limit' }, { status: 429 }));
  assert.equal(await access.begin(snapshot), false);
  assert.deepEqual(blocked, ['guest_test_limit']);
  assert.equal(access.runs.size, 0);
});

test('cancel while start is pending releases only after the reservation response', async () => {
  const pending = deferred(), sent = deferred();
  const { access, calls } = fixture(async url => {
    if (url.endsWith('/start')) { sent.resolve(); await pending.promise; }
    return Response.json({ ok: true });
  });
  const starting = access.begin(snapshot);
  await sent.promise;
  const stopping = access.release(snapshot.runId);
  assert.equal(calls.length, 1);
  pending.resolve(); await starting; await stopping;
  assert.ok(calls[1].url.endsWith('/release'));
  assert.equal(access.runs.size, 0);
});

test('identity changed during the reservation cannot transfer the recording', async () => {
  const pending = deferred(), sent = deferred();
  const f = fixture(async url => { if (url.endsWith('/start')) { sent.resolve(); await pending.promise; } return Response.json({ ok: true }); });
  const starting = f.access.begin(snapshot);
  await sent.promise; f.state.user = { id: 'other-account' }; pending.resolve();
  assert.equal(await starting, false);
  assert.deepEqual(f.blocked, ['account_changed']);
  assert.ok(f.calls.at(-1).url.endsWith('/release'));
});

test('leaving the page releases unfinished capture with keepalive, but preserves a completed charge', async () => {
  const f = fixture();
  await f.access.begin(snapshot);
  await f.access.close();
  assert.ok(f.calls.at(-1).url.endsWith('/release'));
  assert.equal(f.calls.at(-1).keepalive, true);
  await f.access.begin({ ...snapshot, runId: 'completed-before-close' });
  await f.access.complete({ run: { id: 'completed-before-close' } });
  const count = f.calls.length;
  await f.access.close();
  assert.equal(f.calls.length, count, 'Closing never releases a completed test');
});

test('review access waits for the matching completion started later in the same report dispatch', async () => {
  const finished = deferred();
  const f = fixture(async url => { if (url.endsWith('/complete')) await finished.promise; return Response.json({ ok: true }); });
  await f.access.begin(snapshot);
  let settled = false;
  const checking = f.access.waitForCompletion(snapshot.runId).then(() => { settled = true; });
  const complete = f.access.complete({ run: { id: snapshot.runId } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false);
  finished.resolve(); await checking; await complete;
  assert.equal(f.calls.filter(call => call.url.endsWith('/complete')).length, 1);
});
