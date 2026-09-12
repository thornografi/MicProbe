// Native Chrome codecs/decoder + synthetic WebAudio input; no physical microphone or account writes.
const { chromium } = require('playwright');
const { selectScenario } = require('./scenario-browser-helpers.cjs');
const assert = require('node:assert/strict');
const BASE = 'http://localhost:8080';

async function checkCardLayout(page, label) {
  const layout = await page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const input = box('.console-card--primary'), guide = box('.console-card--secondary');
    const result = box('#resultCard'), desktop = matchMedia('(min-width: 1200px)').matches;
    return {
      contained: document.documentElement.scrollWidth <= innerWidth,
      aligned: !desktop || (Math.abs(input.top - guide.top) < 1 && Math.abs(input.bottom - guide.bottom) < 1),
      result: !result.height || (desktop
        ? result.top >= Math.max(input.bottom, guide.bottom) && Math.abs(result.left - input.left) < 1 && Math.abs(result.right - guide.right) < 1
        : result.top >= input.bottom && guide.top >= result.bottom)
    };
  });
  assert.deepEqual(layout, { contained: true, aligned: true, result: true }, `${label}: capture, guide and result layout`);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(), errors = [];
    await require('./scenario-browser-helpers.cjs').allowTestAccess(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.origin !== BASE, route => route.fulfill({ body: '', contentType: 'text/css' }));
    await page.route('**/api/account/**', route => route.fulfill({ json: { ok: true, configured: false, user: null } }));
    await page.route('**/api/freemius/config', route => route.fulfill({ json: { configured: false, mode: 'sandbox' } }));
    await page.goto(`${BASE}/app`);
    await page.locator('#scenarioChoices [data-profile="raw"]').click();
    await page.waitForFunction(() => document.querySelector('#captureSampleText')?.textContent.length > 0);
    await page.evaluate(async () => {
      const bus = (await import('/js/modules/EventBus.js')).default;
      const { EVENTS } = await import('/js/modules/constants.js');
      const MeterSource = (await import('/js/modules/MeterSource.js')).default;
      const read = MeterSource.prototype.read;
      window.__meterSources = new Set();
      MeterSource.prototype.read = function () { window.__meterSources.add(this); return read.call(this); };
      window.__reports = []; window.__guideStages = []; window.__sources = [];
      bus.on(EVENTS.DIAGNOSTIC_REPORT_READY, report => window.__reports.push(report));
      bus.on(EVENTS.CAPTURE_GUIDE_CHANGED, state => {
        window.__guideStages.push(state.stage);
        const source = window.__sources.at(-1);
        if (source) source.gain.gain.value = state.stage === 'quiet' ? 0 : 0.1;
      });
      navigator.mediaDevices.getUserMedia = async ({ audio }) => {
        const ac = new AudioContext({ sampleRate: 48000 });
        const destination = ac.createMediaStreamDestination();
        const noise = ac.createBufferSource(), buffer = ac.createBuffer(1, 48000, 48000);
        let seed = 7;
        for (let i = 0; i < 48000; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; buffer.getChannelData(0)[i] = (seed / 4294967296 * 2 - 1) * 0.01; }
        noise.buffer = buffer; noise.loop = true; noise.connect(destination); noise.start();
        const voice = ac.createBufferSource(), gain = ac.createGain();
        voice.buffer = await ac.decodeAudioData(await (await fetch('/js/tests/fixtures/capture-speech.wav')).arrayBuffer());
        voice.loop = true; gain.gain.value = 0.1;
        voice.connect(gain).connect(destination); voice.start(); await ac.resume();
        const track = destination.stream.getAudioTracks()[0], originalSettings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...originalSettings(), autoGainControl: audio.autoGainControl ?? false,
          noiseSuppression: audio.noiseSuppression ?? false, echoCancellation: audio.echoCancellation ?? false });
        window.__sources.push({ ac, gain, track, voice });
        return destination.stream;
      };
    });
    assert.equal(await page.locator('#guidedNoiseTest').count(), 0, 'The test must not ask users to configure noise measurement');
    for (const profile of ['raw', 'telegram-voice', 'discord']) {
      await selectScenario(page, profile);
      await checkCardLayout(page, `${profile} idle`);
      const before = await page.evaluate(() => window.__reports.length);
      const action = profile === 'discord' ? '#testBtn' : '#recordToggle';
      await page.locator(action).click();
      await page.waitForFunction(() => document.body.dataset.appState === 'preparing');
      await page.waitForFunction(() => /Getting|Input detected/.test(document.querySelector('#captureGuideStatus').textContent));
      assert.match(await page.locator('#captureGuideStatus').innerText(), /Getting|Input detected/);
      assert.match(await page.locator('#recordingTimer').innerText(), /Starting in [12]s/);
      await checkCardLayout(page, `${profile} preparing`);
      await page.waitForFunction(() => window.__guideStages.at(-1) === 'quiet', null, { timeout: 15000 });
      await checkCardLayout(page, `${profile} quiet`);
      assert.match(await page.locator('#recordingTimer').innerText(), /Finishes in (10|9|8)s/);
      assert.equal(await page.locator(`${action} .btn-text`).innerText(), 'Stop early');
      await page.waitForFunction(() => window.__guideStages.at(-1) === 'speak');
      assert.equal(await page.locator('.capture-sample > summary').innerText(), 'Read this aloud');
      await checkCardLayout(page, `${profile} speaking`);
      assert.match(await page.locator('#recordingTimer').innerText(), /Finishes in [1-7]s/);
      assert.doesNotMatch(await page.locator('#captureHint').innerText(), /Listen to your sample/);
      assert(await page.evaluate(() => document.querySelector('#captureGuideStatus').getBoundingClientRect().bottom
        <= document.querySelector('#captureSampleText').getBoundingClientRect().top), 'Instruction precedes the sentence');
      await page.waitForFunction(count => window.__reports.length > count, before, { timeout: 25000 });
      const report = await page.evaluate(() => window.__reports.at(-1));
      assert.equal(report.profile.id, profile);
      assert.equal(report.audioMetrics.speechActivity.status, 'measured', `${profile}: offline VAD loaded`);
      assert.equal(report.audioMetrics.speechActivity.detection, 'detected', `${profile}: speech-like fixture detected`);
      assert.equal(report.recording.stopReason, 'guided-complete');
      assert.equal(report.audioMetrics.guidedNoise.status, 'measured', `${profile}: ${JSON.stringify(report.audioMetrics.guidedNoise)}`);
      assert.ok(report.recording.guidedSegments.speaking.startMs > 3000);
      assert.ok(report.recording.durationMs >= 9500 && report.recording.durationMs < 11500, 'preparation must not be saved');
      assert.equal(report.audioMetrics.snr.status, profile === 'raw' ? 'measured' : 'unavailable');
      assert.equal(await page.locator(action).isEnabled(), true);
      assert.equal(await page.evaluate(() => window.__sources.at(-1).track.readyState), 'ended');
      const meters = await page.evaluate(() => Array.from(window.__meterSources, source => ({ mode: source.mode, closed: source.closed, connected: !!source.node })));
      assert(meters.length > 0 && meters.every(source => source.mode === 'worklet' && source.closed && !source.connected),
        `${profile}: continuous local/remote meters ran and released every sidechain`);
      assert.equal(await page.locator('#captureSampleText').isVisible(), false);
      assert.equal(await page.locator('#recordingTimer').isVisible(), false);
      await checkCardLayout(page, `${profile} result`);
      await page.evaluate(async () => { await Promise.all(window.__sources.filter(source => source.ac.state !== 'closed').map(source => source.ac.close())); });
      console.log(`PASS ${profile}: preparation, guided cues, native encoding, decoded measurement, report and cleanup`);
    }
    for (const profile of ['raw', 'telegram-voice', 'discord']) {
      await selectScenario(page, profile);
      const action = profile === 'discord' ? '#testBtn' : '#recordToggle';
      const before = await page.evaluate(() => window.__reports.length);
      await page.locator(action).click();
      await page.waitForFunction(() => window.__guideStages.at(-1) === 'quiet');
      await page.waitForTimeout(650);
      await page.locator(action).click();
      await page.waitForFunction(count => window.__reports.length > count, before, { timeout: 15000 });
      const result = await page.evaluate(async () => {
        const report = window.__reports.at(-1);
        const { countsAsCompletedTest } = await import('/js/modules/MeasurementValidity.js');
        return { counted: countsAsCompletedTest(report), reason: report.recording.stopReason,
          noise: report.audioMetrics.snr.status, blobReady: !document.querySelector('#resultCard').hidden };
      });
      assert.deepEqual(result, { counted: false, reason: 'user', noise: 'unavailable', blobReady: true });
      assert.equal(await page.locator('#inlineResultTitle').innerText(), 'Test incomplete');
      assert.equal(await page.locator('#recordingTimer').isVisible(), false);
      const previous = await page.locator('#resultCard').getAttribute('data-run-id');
      await page.locator(action).click();
      await page.waitForFunction(() => document.body.dataset.appState === 'preparing'
        && ['prepare', 'input-detected'].includes(window.__guideStages.at(-1)));
      await page.locator(action).click();
      await page.waitForFunction(() => document.body.dataset.appState === 'idle');
      assert.equal(await page.locator('#resultCard').getAttribute('data-run-id'), previous);
      assert.equal(await page.locator('#recordingTimer').isVisible(), false);
      console.log(`PASS ${profile}: incomplete sample, no quota, cancellation preserves previous audio`);
    }

    await selectScenario(page, 'raw');
    await page.locator('#recordToggle').click();
    await page.waitForFunction(() => window.__guideStages.at(-1) === 'speak');
    // The color test needs fixed peaks, independent of pauses in the speech fixture.
    await page.evaluate(() => {
      const source = window.__sources.at(-1);
      source.voice.stop();
      const tone = source.ac.createOscillator(); tone.frequency.value = 220;
      tone.connect(source.gain); tone.start();
    });
    for (const [gain, state] of [[0.1, 'detected'], [0.65, 'high'], [1, 'clipping']]) {
      await page.evaluate(value => { window.__sources.at(-1).gain.gain.value = value; }, gain);
      await page.waitForFunction(expected => document.querySelector('#micActivityBar').dataset.state === expected, state);
      const presentation = await page.evaluate(() => ({
        main: getComputedStyle(document.querySelector('#micActivityBar')).backgroundColor,
        detailed: getComputedStyle(document.querySelector('#vuMeterBar')).backgroundColor,
        status: getComputedStyle(document.querySelector('#micActivityStatus'), '::before').backgroundColor
      }));
      assert.equal(presentation.main, presentation.detailed);
      assert.equal(presentation.main, presentation.status);
      assert.notEqual(presentation.main, 'rgba(0, 0, 0, 0)', 'continuous signal color resolves in CSS');
    }
    assert.match(await page.locator('#micActivityStatus').innerText(), /Input too high/);
    if (process.env.MICPROBE_CAPTURE_SCREENSHOT) await page.screenshot({ path: process.env.MICPROBE_CAPTURE_SCREENSHOT, fullPage: true });
    await page.evaluate(() => { window.__sources.at(-1).gain.gain.value = 0.1; });
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#micActivityBar').getAttribute('data-state'), 'clipping', 'brief peaks remain visible');
    await page.waitForFunction(() => document.querySelector('#micActivityBar').dataset.state === 'detected');
    const beforeMeterStop = await page.evaluate(() => window.__reports.length);
    await page.locator('#recordToggle').click();
    await page.waitForFunction(count => window.__reports.length > count, beforeMeterStop);
    console.log('PASS shared continuous signal colors, peak warning and hold');

    // Dismissing an exit warning must not run the accepted-navigation cleanup.
    await selectScenario(page, 'discord');
    await page.locator('#testBtn').click();
    await page.waitForFunction(() => window.__guideStages.at(-1) === 'quiet');
    const dialogHandled = new Promise(resolve => page.once('dialog', async dialog => {
      assert.equal(dialog.type(), 'beforeunload'); await dialog.dismiss(); resolve();
    }));
    await page.reload({ timeout: 5000 }).catch(error => assert.match(error.message, /ERR_ABORTED|Timeout|interrupted/));
    await dialogHandled;
    assert.equal(await page.evaluate(() => window.__sources.at(-1).track.readyState), 'live');
    const countBeforeStop = await page.evaluate(() => window.__reports.length);
    await page.locator('#testBtn').click();
    await page.waitForFunction(count => window.__reports.length > count, countBeforeStop);
    console.log('PASS dismissed page-exit warning preserves capture and normal completion');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await checkCardLayout(page, 'mobile result');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(await page.locator('#captureGuideStatus').isVisible(), false);
    console.log('PASS mobile guidance and no horizontal overflow');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
