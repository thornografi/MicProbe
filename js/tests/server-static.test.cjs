const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { gunzipSync } = require('node:zlib');
const { server } = require('../../server.js');

let port;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

function request(path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('static requests cannot read private repo files or escape public directories', async () => {
  for (const path of [
    '/server.js', '/server/premium-report-evaluator.js', '/worker/dev.js', '/package.json',
    '/.env', '/.env.local', '/.git/config', '/js-private/server.js',
    '/js/../server.js', '/js/%2e%2e/server.js', '/js/..%2fserver.js',
    '/js/%2e%2e%5cserver.js', '/js\\..\\server.js', '/js/%2f..%2fserver.js',
    '/js/modules/EventBus.js::$DATA', '/js/%00invalid', '/js/%ZZ'
  ]) {
    const response = await request(path);
    assert.equal(response.status, 403, path);
    assert.equal(response.body.toString(), '403 Forbidden', path);
  }
});

test('public pages, browser fixtures, encoder assets and worklets remain accessible', async () => {
  for (const [path, contentType] of [
    ['/index.html', 'text/html'], ['/micprobe.html', 'text/html'],
    ['/privacy.html', 'text/html'], ['/terms.html', 'text/html'],
    ['/css/style.css', 'text/css'], ['/assets/micprobe-mark.svg', 'image/svg+xml'],
    ['/js/tests/audio-audit-browser.html', 'text/html'],
    ['/js/tests/audio-audit-browser.js', 'text/javascript'],
    ['/js/worklets/passthrough-processor.js', 'text/javascript'],
    ['/js/workers/spectral-analysis-worker.js', 'text/javascript'],
    ['/js/lib/opus/encoderWorker.min.js', 'text/javascript'],
    ['/js/modules/%45ventBus.js', 'text/javascript']
  ]) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers['content-type'].startsWith(contentType), path);
    assert.ok(response.body.length > 0, path);
  }
  assert.equal((await request('/js/missing.wasm')).status, 404);
  assert.equal((await request('/favicon.ico')).status, 204);
});

test('extensionless SPA routes serve the public entry point without reading private paths', async () => {
  const index = await request('/index.html');
  for (const path of ['/', '/app', '/app/report', '/server', '/server/premium-report-evaluator', '/js/missing-route']) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['content-type'], index.headers['content-type'], path);
    assert.deepEqual(response.body, index.body, path);
  }
});

test('public HEAD, conditional cache and gzip behavior is preserved', async () => {
  const get = await request('/index.html');
  const head = await request('/index.html', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['content-length']), get.body.length);
  assert.equal(head.headers.etag, get.headers.etag);
  assert.equal(head.headers['cache-control'], 'no-cache');
  assert.ok(head.headers['content-security-policy']);

  for (const headers of [
    { 'if-none-match': get.headers.etag },
    { 'if-modified-since': get.headers['last-modified'] }
  ]) {
    const response = await request('/index.html', { headers });
    assert.equal(response.status, 304);
    assert.equal(response.body.length, 0);
    assert.equal(response.headers.etag, get.headers.etag);
  }

  const compressed = await request('/index.html', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(compressed.body), get.body);
  assert.equal((await request('/index.html', { method: 'PUT' })).status, 405);
});
