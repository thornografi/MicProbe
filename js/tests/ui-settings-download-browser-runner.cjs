// Real Chrome capture with its synthetic microphone; no physical audio or external account writes.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const BASE = 'http://localhost:8080';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    await require('./scenario-browser-helpers.cjs').allowTestAccess(page);
    const errors = [], failedAssets = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.url().startsWith(BASE) && /\.(css|js)(\?|$)/.test(response.url()) && !response.ok()) failedAssets.push(response.url());
    });
    await page.route(url => url.origin !== BASE, route => route.fulfill({ body: '', contentType: 'text/css' }));
    await page.route('**/api/account/**', route => route.fulfill({ json: { ok: true, configured: false, user: null } }));
    await page.route('**/api/freemius/config', route => route.fulfill({ json: { configured: false, mode: 'sandbox' } }));
    await page.goto(`${BASE}/app/`);
    await page.locator('#scenarioChoices [data-profile="discord"]').click();
    await page.waitForFunction(() => document.body.classList.contains('app-mode') && document.querySelector('#customSettingsGrid select'));
    assert.deepEqual(failedAssets, [], '/app/ must load every startup asset');
    assert(await page.locator('link[href="/css/player.css"]').evaluate(node => !!node.sheet));
    console.log('PASS /app/ startup and lazy styles');
    assert.equal(await page.locator('#resultCard').isVisible(), false);
    assert.match(await page.locator('#captureHint').innerText(), /stops automatically/);
    assert.equal(await page.locator('#audioDetails').evaluate(node => node.open), false);
    assert.equal(await page.locator('#remoteVuContainer').isVisible(), false);
    assert.doesNotMatch(await page.locator('.console-card-section--meters').innerText(), /dBFS|After processing/);

    async function assertMetersStopped() {
      assert.equal(await page.locator('#micActivityStatus').innerText(), 'Not measuring yet');
      assert.equal(await page.locator('#micActivityBar').evaluate(node => node.style.width || '0%'), '0%');
      for (const id of ['vuMeterReading', 'remoteVuReading']) {
        assert.equal(await page.locator(`#${id}`).textContent(), '—');
      }
      for (const meter of await page.locator('.vu-meter').all()) {
        assert.equal(await meter.getAttribute('aria-valuetext'), 'Not measuring');
        assert.equal(await meter.locator('.vu-meter-peak').isVisible(), false);
      }
    }
    await assertMetersStopped();

    async function selectProfile(id) {
      await page.evaluate(async profile => {
        (await import('/js/ui/ReportPanelUI.js')).default.close();
        await (await import('/js/ui/ProfileUIManager.js')).default.handleProfileSelect(profile);
      }, id);
      const expanded = await page.locator('#customSettingsToggle').getAttribute('aria-expanded');
      if (expanded !== 'true') await page.locator('#customSettingsToggle').click();
    }
    await selectProfile('raw');
    const controls = await page.locator('#customSettingsGrid [data-setting]').evaluateAll(nodes => nodes.map(node => ({
      key: node.dataset.setting, label: node.labels?.[0]?.textContent, options: node.tagName === 'SELECT' ? [...node.options].map(o => o.value) : []
    })));
    assert(controls.every(control => control.label?.trim()), 'Every custom control has an accessible label');
    const backing = await page.evaluate(async () => {
      const { SETTINGS } = await import('/js/modules/Config.js');
      return Object.fromEntries(Object.entries(SETTINGS).filter(([, setting]) => setting.ui?.type === 'radio')
        .map(([key, setting]) => [key, [...document.querySelectorAll(`input[name="${setting.ui.name}"]`)].map(input => input.value)]));
    });
    for (const control of controls) for (const value of control.options) assert(backing[control.key]?.includes(value), `${control.key}=${value} has no capture control`);
    await page.evaluate(async () => {
      window.__uiCaptures = []; window.__uiReports = [];
      const bus = (await import('/js/modules/EventBus.js')).default;
      const { EVENTS } = await import('/js/modules/constants.js');
      bus.on(EVENTS.RECORDING_COMPLETED, data => window.__uiCaptures.push(data));
      bus.on(EVENTS.DIAGNOSTIC_REPORT_READY, report => window.__uiReports.push(report));
      bus.on(EVENTS.VUMETER_REMOTE_LEVEL, level => window.__uiRemoteLevel = level);
    });
    const rate = page.locator('#custom-setting-sampleRate');
    for (const value of ['16000', '24000', '44100', '48000']) {
      await rate.selectOption(value);
      assert.equal(await page.locator('input[name="sampleRate"]:checked').inputValue(), value);
    }
    await rate.selectOption('44100');
    assert.equal(await page.locator('#settingsModified').isVisible(), true);
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click();
    assert.equal(await rate.inputValue(), '48000');
    assert.equal(await page.locator('#settingsModified').isVisible(), false);
    await rate.selectOption('44100');
    await page.locator('#custom-setting-channelCount').selectOption('2');
    await page.locator('#recordToggle').click();
    await page.waitForFunction(() => document.body.dataset.appState === 'recording');
    await page.waitForTimeout(1200);
    await page.waitForFunction(() => document.querySelector('#micActivityStatus').textContent === 'Sound detected');
    assert.equal(await page.locator('#vuMeterReading').isVisible(), false, 'Technical readings stay optional during capture');
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert(await page.locator('.console-card-section--meters').evaluate(section => {
        const track = section.querySelector('.mic-activity-meter').getBoundingClientRect();
        return track.height === 32 && track.left >= 0 && track.right <= innerWidth
          && document.documentElement.scrollWidth <= innerWidth;
      }), `${width}: microphone activity must fit`);
      if (width !== 320) await page.locator('.console-card-section--meters').screenshot({ path: `.tmp/signal-meter-${width}.png` });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#audioDetails > summary').click();
    assert.match(await page.locator('#vuMeterReading').innerText(), /−\d+\.\d/);
    assert.equal(await page.locator('#vuMeterPeak').isVisible(), true);
    assert.equal(await page.locator('#remoteVuContainer').isVisible(), false, 'Raw capture has no codec-output channel');
    await page.locator('#recordToggle').click();
    await page.waitForFunction(() => window.__uiReports.length === 1);
    await assertMetersStopped();
    assert.equal(await page.locator('#reportPanel').evaluate(node => node.open), false, 'Fresh results must not interrupt playback with a modal');
    assert.equal(await page.locator('#inlineResult').isVisible(), true);
    assert.equal(await page.locator('#playerFilename').innerText(), 'Microphone check');
    assert.doesNotMatch(await page.locator('#playerMeta').innerText(), /audio\/|KB/);
    assert.match(await page.locator('#captureHint').innerText(), /Listen to your sample/);
    await page.getByRole('button', { name: 'Open test report', exact: true }).click();
    assert.equal(await page.locator('#reportPanel').evaluate(node => node.open), true);
    await page.getByRole('button', { name: 'Close report', exact: true }).click();
    const resultText = await page.locator('#inlineResult').innerText();
    await page.locator('#playBtn').click();
    assert.equal(await page.locator('#playBtn').getAttribute('aria-label'), 'Pause');
    await page.locator('#changeScenarioBtn').click();
    assert.equal(await page.locator('#playBtn').getAttribute('aria-label'), 'Play', 'The hidden sample must stop playing');
    await page.locator('#scenarioChoices [data-profile="raw"]').click();
    assert(await page.locator('#recordingPlayer').isVisible(), 'Choosing the current scenario preserves its player');
    assert.equal(await page.locator('#inlineResult').innerText(), resultText);
    assert(await page.locator('#inlineResult').isVisible(), 'Choosing the current scenario preserves its result');
    const recorded = await page.evaluate(async () => {
      const data = window.__uiCaptures.at(-1);
      return { snapshot: data.runSnapshot, bytes: [...new Uint8Array(await data.blob.arrayBuffer())], name: data.filename, mime: data.blob.type };
    });
    assert.equal(recorded.snapshot.requestedSettings.sampleRate, 44100);
    assert.equal(recorded.snapshot.requestedSettings.channelCount, 2);
    assert.equal(Buffer.from(recorded.bytes).toString('ascii', 0, 4), 'RIFF');
    console.log('PASS custom settings, labels and requested 44.1 kHz stereo capture');
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click();
    assert.equal(await page.locator('#recordingPlayer').isVisible(), true, 'Restoring settings must preserve the recorded sample for comparison');
    assert.equal(await page.locator('#settingsModified').isVisible(), false);
    await page.evaluate(async () => (await import('/js/ui/ReportPanelUI.js')).default.close());
    const originalPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download original' }).click();
    const original = await originalPromise;
    assert.equal(original.suggestedFilename(), recorded.name);
    assert.deepEqual(await fs.readFile(await original.path()), Buffer.from(recorded.bytes), 'Original download must preserve the exact measured file');
    const mp3Promise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'MP3', exact: true }).click();
    const mp3 = await mp3Promise;
    assert.match(mp3.suggestedFilename(), /\.mp3$/);
    const mp3Bytes = await fs.readFile(await mp3.path());
    assert(mp3Bytes.length > 100 && !mp3Bytes.equals(Buffer.from(recorded.bytes)));
    const decoded = await page.evaluate(async ({ original, mp3 }) => {
      const context = new AudioContext();
      try {
        const source = await context.decodeAudioData(new Uint8Array(original).buffer);
        const exported = await context.decodeAudioData(new Uint8Array(mp3).buffer);
        return { original: source.duration, mp3: exported.duration };
      }
      finally { await context.close(); }
    }, { original: recorded.bytes, mp3: [...mp3Bytes] });
    // Headless capture startup can consume part of the wall-clock wait. Check the
    // measured file, allowing MP3 frame padding, rather than assuming a capture length.
    assert(decoded.original > 0 && decoded.mp3 > 0, 'Both downloads must contain decodable audio');
    assert(decoded.mp3 >= decoded.original - 0.02 && decoded.mp3 <= decoded.original + 0.1,
      `MP3 duration must preserve the source (original ${decoded.original.toFixed(3)} s, MP3 ${decoded.mp3.toFixed(3)} s)`);
    console.log('PASS byte-identical original WAV and independently playable MP3');

    await page.setViewportSize({ width: 375, height: 812 });
    await page.locator('.player-downloads').scrollIntoViewIfNeeded();
    const layout = await page.locator('.player-downloads').evaluate(node => ({
      left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: innerWidth,
      buttons: [...node.querySelectorAll('a')].map(child => { const r = child.getBoundingClientRect(); return { left: r.left, right: r.right, scroll: child.scrollWidth, client: child.clientWidth }; })
    }));
    assert(layout.left >= 0 && layout.right <= layout.width);
    assert(layout.buttons[0].right <= layout.buttons[1].left, 'Download controls must not overlap');
    assert(layout.buttons.every(button => button.scroll <= button.client + 1), 'Download labels must fit');
    await page.locator('#recordingPlayer').screenshot({ path: '.tmp/ui-download-mobile.png' });
    for (const width of [320, 390, 768, 1100, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const boxes = await page.evaluate(() => {
        const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
        return { controls: box('.console-card--primary'), result: box('#resultCard'), info: box('.console-card--secondary'), width: innerWidth, scroll: document.documentElement.scrollWidth };
      });
      assert(boxes.result.top >= boxes.controls.bottom, `${width}: result follows capture`);
      if (width <= 1100) assert(boxes.info.top >= boxes.result.bottom, `${width}: result precedes technical details`);
      assert(boxes.result.left >= 0 && boxes.result.right <= width && boxes.scroll <= width, `${width}: no horizontal overflow`);
    }
    await page.locator('#resultCard').screenshot({ path: '.tmp/workflow-result-desktop.png' });
    console.log('PASS inline result, explicit report, non-destructive reset and 320–1280px result order');
    await page.setViewportSize({ width: 1280, height: 900 });
    await selectProfile('discord');
    await page.locator('#custom-setting-bitrate').selectOption('96000');
    assert.equal(await page.locator('#infoTargetBitrate').innerText(), 'Max 96 kbps');
    await page.locator('#testBtn').click();
    // Meters also run during preparation. Wait for capture before using Finish,
    // otherwise the same button correctly cancels setup and publishes no report.
    await page.waitForFunction(() => document.body.dataset.appState === 'testing');
    await page.waitForFunction(() => [...document.querySelectorAll('.vu-meter')]
      .every(meter => Number(meter.getAttribute('aria-valuenow')) > -80));
    assert.match(await page.locator('#remoteVuReading').innerText(), /−\d+\.\d/);
    assert.equal(await page.locator('#remoteVuPeak').isVisible(), true);
    await page.locator('#audioDetails > summary').click();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.locator('#audioDetails > summary').click();
    await page.waitForFunction(() => {
      const peak = document.querySelector('#remoteVuPeak'), track = peak.parentElement;
      const expected = Math.min(window.__uiRemoteLevel.peak / 100 * track.clientWidth, track.clientWidth - 2);
      return Math.abs(peak.getBoundingClientRect().left - track.getBoundingClientRect().left - expected) < 1;
    });
    await page.locator('#audioDetails').screenshot({ path: '.tmp/signal-details-mobile.png' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('.console-card-section--meters').screenshot({ path: '.tmp/signal-meter-both.png' });
    await page.locator('#testBtn').click();
    await page.waitForFunction(() => window.__uiReports.length === 2);
    await assertMetersStopped();
    console.log('PASS simple activity, optional live details, disclosure resize and capture-stop reset');
    await selectProfile('telegram-voice');
    await page.locator('#custom-setting-mediaBitrate').selectOption('24000');
    assert.equal(await page.locator('#infoTargetBitrate').innerText(), '24 kbps');
    await page.locator('#custom-setting-mediaBitrate').selectOption('0');
    assert.equal(await page.locator('#infoTargetBitrate').innerText(), 'Auto');
    assert.equal(await page.locator('#custom-setting-mediaBitrate option:checked').innerText(), 'Auto');
    console.log('PASS 375px player layout and call/record bitrate cards');
    assert.deepEqual(errors, []);
    assert.deepEqual(failedAssets, []);
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
