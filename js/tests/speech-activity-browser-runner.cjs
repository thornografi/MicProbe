// Source and compiled module-worker/WASM checks, under the real local CSP.
// Generated PCM avoids microphone access and also runs on Windows WebKit.
const { chromium, firefox, webkit } = require('playwright');
const { readFile, readdir } = require('node:fs/promises');
const { resolve, sep, extname } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const BASE = 'http://localhost:8080', built = process.argv.includes('--built');

(async () => {
  const { speechFixture, guidedSegments } = await import('./speech-fixture.mjs');
  let proxy, rejectVad = false, workerPath = '/js/workers/spectral-analysis-worker.js';
  const policy = (await fetch(`${BASE}/404.html`)).headers.get('content-security-policy');
  const assets = resolve('.tmp/cloudflare-dev-assets'), requests = [];
  if (built) {
    workerPath = '/assets/' + (await readdir(resolve(assets, 'assets'))).find(name => /^spectral-analysis-worker-.*\.js$/.test(name));
    assert(!workerPath.endsWith('undefined'), 'compiled analysis worker exists');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.svg': 'image/svg+xml' };
    proxy = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, BASE), path = resolve(assets, '.' + url.pathname);
        if (url.origin !== BASE || !path.startsWith(assets + sep)) return response.writeHead(404).end();
        if (rejectVad && extname(path) === '.wasm') return response.writeHead(404).end();
        const data = await readFile(path);
        if (extname(path) === '.wasm') requests.push(path);
        response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream',
          ...(policy && extname(path) === '.html' ? { 'content-security-policy': policy } : {}) }).end(data);
      } catch { response.writeHead(404).end(); }
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  }
  try {
    for (const [name, engine] of Object.entries({ chrome: chromium, firefox, webkit })) {
      if (built && name !== 'chrome') continue;
      const browser = await engine.launch({ headless: true, ...(name === 'chrome' ? { channel: 'chrome' } : {}),
        ...(proxy ? { proxy: { server: `http://127.0.0.1:${proxy.address().port}` }, args: ['--proxy-bypass-list=<-loopback>'] } : {}) });
      try {
        const page = await browser.newPage();
        await page.goto(`${BASE}/404.html`);
        const baseline = speechFixture(), disturbed = baseline.slice(), silentVoice = speechFixture(16000, { voiceGain: 0 });
        for (let i = 8000; i < 12800; i++) disturbed[i] += 0.15 * Math.sin(i * Math.PI * 2 * 700 / 16000);
        for (const [label, pcm] of [['speech', baseline], ['brief-disturbance', disturbed], ['no-speech', silentVoice],
          ...(built ? [['no-detector', baseline]] : [])]) {
          rejectVad = label === 'no-detector';
          const result = await page.evaluate(async ({ samples, ranges, url }) => {
            const worker = new Worker(url, { type: 'module' });
            return new Promise((resolve, reject) => {
              const timeout = setTimeout(() => { worker.terminate(); reject(new Error('analysis timed out')); }, 8000);
              const finish = () => { clearTimeout(timeout); worker.terminate(); };
              worker.onerror = event => { finish(); reject(new Error(event.message)); };
              worker.onmessage = ({ data }) => {
                if (data.type === 'done') { finish(); resolve(data.result.audioMetrics); }
                else if (data.type === 'error') { finish(); reject(new Error(data.reason)); }
              };
              const input = Float32Array.from(samples);
              worker.postMessage({ type: 'analyze', runId: 'browser-vad', channels: [input.buffer], sampleRate: 16000,
                fftSize: 1024, hopSize: 512, outputBins: 24, guidedSegments: ranges }, [input.buffer]);
            });
          }, { samples: Array.from(pcm), ranges: guidedSegments(), url: workerPath });
          assert.equal(result.status, 'measured');
          assert.equal(result.speechActivity.status, rejectVad ? 'unavailable' : 'measured', `${name} ${label}: optional WASM`);
          if (!rejectVad) assert.equal(result.speechActivity.detection, label === 'no-speech' ? 'uncertain' : 'detected');
          assert.equal(result.noiseFloor.status, 'measured');
          assert.equal(result.snr.status, label === 'no-speech' ? 'unavailable' : 'measured');
          assert.equal(result.durationMs, 10000);
          if (label === 'brief-disturbance') assert.equal(result.guidedNoise.excludedQuietMs, 500);
          console.log(`${name} ${built ? 'compiled' : 'source'} ${label}: PASS (${rejectVad
            ? 'other PCM checks preserved' : `${result.speechActivity.detectedSpeechMs} ms detected`})`);
        }
      } finally { await browser.close(); }
    }
    if (built) assert(requests.some(path => /libfvad-.*\.wasm$/.test(path)), 'hashed WASM delivered under CSP');
  } finally { if (proxy) await new Promise(resolve => proxy.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
