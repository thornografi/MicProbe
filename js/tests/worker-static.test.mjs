import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/dev.js';

test('Worker routes only known app entries and keeps signed queries intact', async () => {
  for (const path of ['/', '/app', '/app/']) {
    let forwarded;
    const response = await worker.fetch(new Request(`https://micprobe.example${path}?signature=test&checkout_state=owned`), {
      ASSETS: { fetch(request) { forwarded = new URL(request.url); return new Response('<html>app</html>', { headers: { 'Content-Type': 'text/html' } }); } }
    });
    assert.equal(forwarded.pathname, path === '/' ? '/index.html' : '/app.html');
    assert.equal(forwarded.search, '?signature=test&checkout_state=owned');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.ok(response.headers.get('content-security-policy'));
  }
});

test('Worker preserves missing-route status and caches successful hashed assets', async () => {
  for (const [path, status, type, cache] of [
    ['/unknown', 404, 'text/html', 'no-cache'],
    ['/assets/app-hash.js', 200, 'text/javascript', 'public, max-age=31536000, immutable'],
    ['/assets/missing.js', 404, 'text/plain', null]
  ]) {
    const response = await worker.fetch(new Request(`https://micprobe.example${path}`), {
      ASSETS: { fetch(request) {
        assert.equal(new URL(request.url).pathname, path);
        return new Response('content', { status, headers: { 'Content-Type': type } });
      } }
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), cache);
  }
});

test('Worker serves favicon variants and touch icons through the assets binding', async () => {
  for (const [path, type] of [
    ['/favicon.ico', 'image/x-icon'], ['/favicon.ico?v=2', 'image/x-icon'],
    ['/favicon.svg?v=2', 'image/svg+xml'], ['/favicon-96.png?v=2', 'image/png'],
    ['/apple-touch-icon.png?v=2', 'image/png']
  ]) {
    let forwarded;
    const bytes = new Uint8Array([0, 0, 1, 0, 3, 0]);
    const response = await worker.fetch(new Request(`https://micprobe.example${path}`), {
      ASSETS: { fetch(request) {
        forwarded = new URL(request.url);
        return new Response(bytes, { headers: { 'Content-Type': type } });
      } }
    });
    assert.equal(response.status, 200, path);
    assert.equal(forwarded.pathname + forwarded.search, path);
    assert.equal(response.headers.get('content-type'), type);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  }
});
