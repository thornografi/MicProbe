const test = require('node:test');
const assert = require('node:assert/strict');

// Isolated HTTP adapter test; does not touch the existing localhost:8080 app,
// a real account database, external auth, billing, email or an AI provider.
process.env.MICPROBE_ACCOUNT_DB_PATH = ':memory:';
process.env.MICPROBE_GOOGLE_CLIENT_ID = '';
process.env.MICPROBE_PUBLIC_ORIGIN = 'http://localhost:8080';
const { server } = require('../../server.js');

test('Node HTTP routes a visit-bound review through the same private decision service', async t => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { reviewReport } = await import('./review-fixtures.mjs');
  const report = reviewReport('node-http-review');
  let cookie = '';
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: {
    Origin: 'http://localhost:8080', 'X-MicProbe-Request': '1', 'X-MicProbe-Account': 'anonymous',
    'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  const start = await post('/api/tests/start', { runId: report.run.id });
  assert.equal(start.status, 200);
  cookie = start.headers.get('Set-Cookie').split(';')[0];
  const m = report.audioMetrics;
  assert.equal((await post('/api/tests/complete', { runId: report.run.id, evidence: {
    status: m.status, sampleCount: m.sampleCount, durationMs: m.durationMs,
    signal: { rmsDb: m.signal.rmsDb, peakDb: m.signal.peakDb }, clipping: m.clipping
  } })).status, 200);
  const result = await post('/api/reviews/assess', { report });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.summary.assessment.status, 'limited'); assert.equal(body.summary.summary, 'The recording has a low sound level.');
  assert.equal(body.summary.findings, undefined);
  const denied = await post('/api/reviews/start', { report, intent: 'personal-review' });
  assert.equal(denied.status, 403);
});
