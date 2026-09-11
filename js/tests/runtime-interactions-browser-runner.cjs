// Controlled async boundaries against the real app; no physical microphone or account is used.
const { chromium } = require('playwright');
const { selectScenario } = require('./scenario-browser-helpers.cjs');
const assert = require('node:assert/strict');
const BASE = 'http://localhost:8080';
function gate() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function savedReport(owner) {
  return { version: 1, generatedAt: new Date().toISOString(), sessionId: 'runtime-saved',
    run: { id: 'runtime-saved', type: 'record', accountOwnerId: owner },
    profile: { id: 'raw', label: 'Raw Recording', category: 'record' }, recording: { durationMs: 1000 },
    audioMetrics: null, deepAnalysis: null, loopback: null, system: {}, sanity: {} };
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  async function open({ profile, accountGate, checkout = false, owner = null, storageBlocked = false, route = '/app' } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ profile, checkout, owner, report, storageBlocked }) => {
      if (profile) localStorage.setItem('micprobe.lastScenario', profile);
      if (checkout) sessionStorage.setItem('micprobe:checkout-snapshot:v1', JSON.stringify({
        ownerId: owner, profileId: 'raw', report, savedAt: Date.now()
      }));
      if (storageBlocked) {
        for (const method of ['getItem', 'setItem', 'removeItem']) Storage.prototype[method] = () => {
          throw new DOMException('Storage denied', 'SecurityError');
        };
      }
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.__tracks = []; window.__requests = 0; window.__resolved = 0;
      navigator.mediaDevices.getUserMedia = async constraints => {
        window.__requests++;
        if (window.__holdNextCapture) {
          window.__holdNextCapture = false;
          await new Promise(resolve => { window.__grantOldCapture = resolve; });
        }
        const stream = await capture(constraints);
        window.__tracks.push(...stream.getTracks()); window.__resolved++;
        return stream;
      };
    }, { profile, checkout, owner, report: savedReport(owner), storageBlocked });
    const page = await context.newPage();
    await require('./scenario-browser-helpers.cjs').allowTestAccess(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.origin !== BASE, request => request.fulfill({ status: 200, body: '' }));
    await page.route('**/api/account/**', async request => {
      if (accountGate) await accountGate.promise;
      return request.fulfill({ json: { ok: true, configured: !!owner, user: owner ? { id: owner } : null,
        premium: { unlocked: false }, reports: [] } });
    });
    await page.route('**/api/freemius/config', request => request.fulfill({ json: { configured: false, mode: 'sandbox' } }));
    const navigate = async () => {
      await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
      if (route !== '/') await page.waitForFunction(() => document.body.classList.contains('app-mode'));
    };
    return { context, page, navigate };
  }
  async function observe(page) {
    await page.evaluate(async () => {
      const bus = (await import('/js/modules/EventBus.js')).default;
      const { EVENTS } = await import('/js/modules/constants.js');
      window.__starts = []; window.__reports = []; window.__guide = '';
      for (const event of [EVENTS.RECORDING_STARTED, EVENTS.TEST_RECORDING_STARTED]) bus.on(event, data => window.__starts.push(data.runSnapshot));
      bus.on(EVENTS.DIAGNOSTIC_REPORT_READY, report => window.__reports.push(report));
      bus.on(EVENTS.CAPTURE_GUIDE_CHANGED, data => { window.__guide = data.stage; });
    });
  }
  async function waitIdle(page) { await page.waitForFunction(() => document.body.dataset.appState === 'idle'); }
  async function state(page) {
    return page.evaluate(async () => ({
      mode: (await import('/js/app/AppState.js')).getCurrentMode(),
      profile: (await import('/js/controllers/ProfileController.js')).default.getCurrentProfileId(),
      reportId: (await import('/js/modules/DiagnosticReportBuilder.js')).default.getLastReport()?.run?.id || null,
      active: window.__tracks.filter(track => track.readyState === 'live').length,
      reportOpen: document.querySelector('#reportPanel').open
    }));
  }
  try {
    for (const reopen of [false, true]) {
      const { context, page, navigate } = await open({ route: '/' }); const css = gate(), requested = gate();
      await page.route('**/css/report.css', async request => { requested.resolve(); await css.promise; await request.continue(); });
      await navigate(); await page.locator('#heroLaunchBtn').click(); await requested.promise;
      await page.locator('#navbarBrand').click();
      if (reopen) await page.locator('#heroLaunchBtn').click();
      css.resolve(); await page.waitForLoadState('networkidle');
      assert.equal(await page.evaluate(() => document.body.classList.contains('app-mode')), reopen);
      assert.equal(new URL(page.url()).pathname, reopen ? '/app' : '/');
      await context.close();
    }
    console.log('PASS latest navigation wins during delayed loading, including reopen');

    for (const [profile, button, phase] of [['raw', '#recordToggle', 'recording'], ['discord', '#testBtn', 'testing']]) {
      const { context, page, navigate } = await open({ profile }); await navigate(); await observe(page);
      await page.evaluate(() => { window.__holdNextCapture = true; });
      await page.locator(button).click(); await page.waitForFunction(() => !!window.__grantOldCapture);
      assert.match(await page.locator(button).getAttribute('aria-label'), /Cancel.*preparation/);
      await page.locator(button).click(); await waitIdle(page);
      assert.equal(await page.locator('#changeScenarioBtn').isEnabled(), true);
      // Start a replacement before the cancelled permission request returns.
      await page.locator(button).click();
      await page.waitForFunction(phase => document.body.dataset.appState === phase, phase);
      await page.evaluate(() => window.__grantOldCapture());
      await page.waitForFunction(() => window.__resolved === 2 && window.__tracks.filter(track => track.readyState === 'live').length === 1);
      assert.equal(await page.evaluate(() => window.__starts.length), 1);
      assert.equal((await state(page)).profile, profile);
      await page.locator(button).click();
      await page.waitForFunction(() => window.__reports.length === 1); await waitIdle(page);
      assert.equal((await state(page)).active, 0);
      // The same Cancel action works after permission, during guided preparation.
      await page.evaluate(() => { window.__guide = ''; });
      await page.locator(button).click(); await page.waitForFunction(() => window.__guide === 'prepare');
      await page.locator(button).click(); await waitIdle(page);
      assert.equal((await state(page)).active, 0);
      assert.equal(await page.evaluate(() => window.__starts.length), 1);
      await context.close();
    }
    console.log('PASS Call and Record cancel before/after permission, retry immediately and discard late streams');

    for (const owner of [null, 'runtime-owner']) {
      const account = gate();
      const { context, page, navigate } = await open({ profile: 'discord', checkout: true, owner, accountGate: account });
      await navigate(); await observe(page); await page.locator('#testBtn').click();
      await page.waitForFunction(() => document.body.dataset.appState === 'preparing');
      assert.equal(await page.evaluate(() => window.__requests), 0, 'Admission waits for account identity');
      account.resolve();
      await page.waitForFunction(async () => (await import('/js/modules/AccountAccess.js')).default.getState().ready);
      if (owner) {
        await page.locator('#testAccessDialog[open]').waitFor();
        await page.locator('#testAccessDialog [aria-label="Close"]').click();
        await page.locator('#testBtn').click();
      }
      await page.waitForFunction(() => document.body.dataset.appState === 'testing');
      assert.equal((await state(page)).profile, 'discord'); assert.equal((await state(page)).reportOpen, false);
      await page.locator('#testBtn').click();
      await page.waitForFunction(() => window.__reports.length === 1); await waitIdle(page);
      const result = await state(page);
      assert.notEqual(result.reportId, 'runtime-saved'); assert.equal(result.active, 0); assert.equal(result.reportOpen, false);
      await context.close();
    }
    // An untouched return still restores; an explicit new scenario supersedes it while idle.
    for (const newScenario of [false, true]) {
      const account = gate();
      const { context, page, navigate } = await open({ profile: 'discord', checkout: true, accountGate: account });
      await navigate();
      if (newScenario) await selectScenario(page, 'telegram-voice');
      account.resolve();
      await page.waitForFunction(async () => (await import('/js/modules/AccountAccess.js')).default.getState().ready);
      const result = await state(page);
      assert.equal(result.profile, newScenario ? 'telegram-voice' : 'raw');
      assert.equal(result.reportId, newScenario ? null : 'runtime-saved');
      assert.equal(result.reportOpen, !newScenario); await context.close();
    }
    console.log('PASS delayed checkout preserves active/new work and untouched checkout still restores');

    {
      const { context, page, navigate } = await open({ profile: 'raw' }); await navigate();
      await page.evaluate(async () => {
        const bus = (await import('/js/modules/EventBus.js')).default;
        const { EVENTS } = await import('/js/modules/constants.js');
        const { createWavBlob } = await import('/js/modules/utils/wav.js');
        const blob = await createWavBlob([new Float32Array(48000)], 48000, 1);
        bus.emit(EVENTS.RECORDING_COMPLETED, { blob, mimeType: 'audio/wav', filename: 'runtime.wav', durationMs: 1000,
          runSnapshot: { runId: 'runtime-play', profileLabel: 'Raw Recording' } });
        document.querySelector('#playBtn').click(); document.querySelector('#recordToggle').click();
      });
      await page.waitForFunction(() => document.body.dataset.appState === 'recording');
      await page.locator('#recordToggle').click(); await waitIdle(page);
      await context.close();
    }
    console.log('PASS native Play interruption by Record does not escape as an unhandled rejection');

    {
      const { context, page, navigate } = await open({ storageBlocked: true }); await navigate();
      await page.locator('#scenarioChoices [data-profile="raw"]').click();
      // Exercise read/write/removal failures through DeviceInfo without changing capture ownership.
      const result = await page.evaluate(async () => {
        const DeviceInfo = (await import('/js/modules/DeviceInfo.js')).default;
        const info = new DeviceInfo();
        info.initMicSelector({ micSelector: document.createElement('select') });
        info.buildMicrophoneDropdown([{ kind: 'audioinput', deviceId: 'runtime-device', label: 'Runtime device' }]);
        info.micSelector.value = 'runtime-device'; info.micSelector.dispatchEvent(new Event('change'));
        const selected = info.getSelectedDeviceId();
        info.buildMicrophoneDropdown([]); const fallback = info.getSelectedDeviceId(); info.destroy();
        return { selected, fallback };
      });
      assert.deepEqual(result, { selected: 'runtime-device', fallback: '' });
      assert.equal((await state(page)).profile, 'raw'); await context.close();
    }
    console.log('PASS storage failures preserve app startup, scenario selection and microphone fallback');
    assert.deepEqual(errors, []);
    console.log('PASS no uncaught browser errors across runtime interaction scenarios');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
