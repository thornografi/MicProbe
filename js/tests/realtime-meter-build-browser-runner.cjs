// Serve compiled artifacts through a private test proxy at the normal localhost
// URL. Worklet fetches bypass Playwright route interception in Chromium, so a
// real HTTP response is required; the user's server stays untouched.
const { chromium } = require('playwright');
const { readFile } = require('node:fs/promises');
const { resolve, sep, extname } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const BASE = 'http://localhost:8080', assets = resolve('.tmp/cloudflare-dev-assets');

(async () => {
  const policy = (await fetch(BASE)).headers.get('content-security-policy');
  const servedWorklets = [];
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
  const proxy = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, BASE);
      if (url.origin !== BASE) { response.writeHead(404).end(); return; }
      const entry = /^\/app\/?$/.test(url.pathname) ? '/app.html' : url.pathname === '/' ? '/index.html' : url.pathname;
      const path = resolve(assets, '.' + entry);
      if (!path.startsWith(assets + sep)) { response.writeHead(404).end(); return; }
      const data = await readFile(path);
      if (/\/assets\/meter-processor-.*\.js$/.test(url.pathname)) servedWorklets.push(url.pathname);
      response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream',
        ...(policy && extname(path) === '.html' ? { 'content-security-policy': policy } : {}) }).end(data);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true,
      proxy: { server: `http://127.0.0.1:${proxy.address().port}` },
      args: ['--proxy-bypass-list=<-loopback>', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage(), errors = [], consoleErrors = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await require('./scenario-browser-helpers.cjs').allowTestAccess(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.origin !== BASE, route => route.fulfill({ body: '', contentType: 'text/css' }));
    await page.route('**/api/account/**', route => route.fulfill({ json: { ok: true, configured: false, user: null } }));
    await page.route('**/api/freemius/config', route => route.fulfill({ json: { configured: false } }));
    await page.addInitScript(() => {
      window.__meterNodes = [];
      window.__workletFailures = [];
      const addModule = AudioWorklet.prototype.addModule;
      AudioWorklet.prototype.addModule = async function (...args) {
        try { return await addModule.apply(this, args); }
        catch (error) { window.__workletFailures.push({ url: String(args[0]), name: error.name, message: error.message }); throw error; }
      };
      const NativeNode = window.AudioWorkletNode;
      window.AudioWorkletNode = class extends NativeNode {
        constructor(...args) {
          super(...args);
          if (args[1] !== 'meter-processor') return;
          const entry = { messages: 0, closed: false, errors: 0 };
          window.__meterNodes.push(entry);
          this.port.addEventListener('message', () => entry.messages++);
          this.addEventListener('processorerror', () => entry.errors++);
          const close = this.port.close.bind(this.port);
          this.port.close = () => { entry.closed = true; close(); };
        }
      };
    });
    await page.goto(`${BASE}/app`);
    assert.equal(await page.locator('script[src^="/assets/index-"]').count(), 1);
    for (const [profile, action] of [['raw', '#recordToggle'], ['telegram-voice', '#recordToggle'], ['discord', '#testBtn']]) {
      await require('./scenario-browser-helpers.cjs').selectScenario(page, profile);
      const before = await page.evaluate(() => window.__meterNodes.length);
      await page.locator(action).click();
      await page.waitForFunction(() => ['recording', 'testing'].includes(document.body.dataset.appState)).catch(async error => {
        console.error('Compiled capture diagnostics', await page.evaluate(() => ({ state: document.body.dataset.appState,
          meters: window.__meterNodes, workletFailures: window.__workletFailures, status: document.querySelector('#micActivityStatus')?.textContent,
          messages: document.body.innerText.slice(-2500) })), errors);
        throw error;
      });
      const count = profile === 'discord' ? 2 : 1;
      await page.waitForFunction(({ before, count }) => {
        const nodes = window.__meterNodes.slice(before);
        return nodes.length === count && nodes.every(node => node.messages > 5 && !node.errors);
      }, { before, count });
      // Give native Call encoding enough captured audio to produce a decodable
      // short file; receiving the first meter packet alone does not ensure that.
      await page.waitForTimeout(1000);
      await page.locator(action).click();
      await page.waitForFunction(() => document.body.dataset.appState === 'idle');
      assert(await page.evaluate(() => window.__meterNodes.every(node => node.closed && !node.errors)));
      console.log(`PASS compiled ${profile}: ${count} continuous meter(s), hashed worklet, port data and stop cleanup`);
    }
    assert(servedWorklets.length > 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(consoleErrors, []);
  } finally {
    await browser?.close();
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
