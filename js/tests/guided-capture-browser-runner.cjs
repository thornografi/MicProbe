// Native Chrome codecs/decoder + synthetic WebAudio input; no physical microphone or account writes.
const { chromium } = require('playwright');
const { selectScenario } = require('./scenario-browser-helpers.cjs');
const assert = require('node:assert/strict');
const BASE = 'http://localhost:8080';

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
        const voice = ac.createOscillator(), gain = ac.createGain();
        voice.frequency.value = 220; gain.gain.value = 0.1;
        voice.connect(gain).connect(destination); voice.start(); await ac.resume();
        const track = destination.stream.getAudioTracks()[0], originalSettings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...originalSettings(), autoGainControl: audio.autoGainControl ?? false,
          noiseSuppression: audio.noiseSuppression ?? false, echoCancellation: audio.echoCancellation ?? false });
        window.__sources.push({ ac, gain, track });
        return destination.stream;
      };
    });
    assert.equal(await page.locator('#guidedNoiseTest').count(), 0, 'The test must not ask users to configure noise measurement');
    for (const profile of ['raw', 'telegram-voice', 'discord']) {
      await selectScenario(page, profile);
      const before = await page.evaluate(() => window.__reports.length);
      const action = profile === 'discord' ? '#testBtn' : '#recordToggle';
      await page.locator(action).click();
      await page.waitForFunction(() => document.body.dataset.appState === 'preparing');
      await page.waitForFunction(() => /Getting|Input detected/.test(document.querySelector('#captureGuideStatus').textContent));
      assert.match(await page.locator('#captureGuideStatus').innerText(), /Getting|Input detected/);
      await page.waitForFunction(() => window.__guideStages.at(-1) === 'quiet', null, { timeout: 15000 });
      await page.waitForFunction(() => window.__guideStages.at(-1) === 'speak');
      assert.equal(await page.locator('.capture-sample > summary').innerText(), 'Read this aloud');
      assert(await page.evaluate(() => document.querySelector('#captureGuideStatus').getBoundingClientRect().bottom
        <= document.querySelector('#captureSampleText').getBoundingClientRect().top), 'Instruction precedes the sentence');
      await page.waitForFunction(count => window.__reports.length > count, before, { timeout: 25000 });
      const report = await page.evaluate(() => window.__reports.at(-1));
      assert.equal(report.profile.id, profile);
      assert.equal(report.audioMetrics.guidedNoise.status, 'measured', `${profile}: ${JSON.stringify(report.audioMetrics.guidedNoise)}`);
      assert.ok(report.recording.guidedSegments.speaking.startMs > 3000);
      assert.ok(report.recording.durationMs >= 9500 && report.recording.durationMs < 11500, 'preparation must not be saved');
      assert.equal(report.audioMetrics.snr.status, profile === 'raw' ? 'measured' : 'unavailable');
      assert.equal(await page.locator(action).isEnabled(), true);
      assert.equal(await page.evaluate(() => window.__sources.at(-1).track.readyState), 'ended');
      assert.equal(await page.locator('#captureSampleText').isVisible(), false);
      await page.evaluate(async () => { await Promise.all(window.__sources.filter(source => source.ac.state !== 'closed').map(source => source.ac.close())); });
      console.log(`PASS ${profile}: preparation, guided cues, native encoding, decoded measurement, report and cleanup`);
    }
    // Ending the quiet phase early must keep the sample but not create noise/SNR claims.
    const before = await page.evaluate(() => window.__reports.length);
    await page.locator('#testBtn').click();
    await page.waitForFunction(() => window.__guideStages.at(-1) === 'quiet');
    await page.waitForTimeout(650);
    await page.locator('#testBtn').click();
    await page.waitForFunction(count => window.__reports.length > count, before, { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.__reports.at(-1).audioMetrics.snr.status), 'unavailable');
    console.log('PASS early Finish rejects incomplete guided segments');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(await page.locator('#captureGuideStatus').isVisible(), false);
    console.log('PASS mobile guidance and no horizontal overflow');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
