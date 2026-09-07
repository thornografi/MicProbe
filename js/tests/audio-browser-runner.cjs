// Requires Playwright (installed locally or made available via NODE_PATH) and localhost:8080.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://localhost:8080/js/tests/audio-audit-browser.html');
    await page.locator('#results:not([data-status="running"])').waitFor({ timeout: 60000 });
    console.log(await page.locator('#results').innerText());
    assert.equal(await page.locator('#results').getAttribute('data-status'), 'passed');
    await context.addInitScript(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.__testTracks = [];
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await original(constraints);
        window.__testTracks.push(...stream.getTracks());
        return stream;
      };
    });
    await page.goto('http://localhost:8080/#app');
    await page.waitForFunction(() => document.body.classList.contains('app-mode'), null, { timeout: 15000 });
    await page.evaluate(async () => {
      window.__reports = [];
      const bus = (await import('/js/modules/EventBus.js')).default;
      const { EVENTS } = await import('/js/modules/constants.js');
      bus.on(EVENTS.DIAGNOSTIC_REPORT_READY, r => window.__reports.push(r));
    });
    const profiles = await page.evaluate(async () => Object.values((await import('/js/modules/Config.js')).PROFILES)
      .map(profile => ({ id: profile.id, canTest: profile.canTest, values: profile.values, evidence: profile.evidence })));
    for (const { id: profile, canTest: call, values, evidence } of profiles) {
      await page.evaluate(async id => {
        (await import('/js/ui/ReportPanelUI.js')).default.close?.();
        // Use the same handler as scenario buttons so the settings panel is refreshed too.
        await (await import('/js/ui/ProfileUIManager.js')).default.handleProfileSelect(id);
      }, profile);
      const settings = await page.evaluate(async id => {
        const { PROFILES, SETTINGS } = await import('/js/modules/Config.js');
        const selected = PROFILES[id];
        const fixedRows = [...document.querySelectorAll('#customSettingsGrid .profile-specifications dl > div')];
        const locked = selected.lockedSettings.map(key => {
          const control = document.querySelector(`#customSettingsGrid [data-setting="${key}"]`);
          const ui = SETTINGS[key].ui;
          const backing = ui?.type === 'radio'
            ? [...document.querySelectorAll(`input[name="${ui.name}"]`)] : [document.getElementById(ui.id)].filter(Boolean);
          const row = fixedRows.find(row => row.querySelector('dt')?.textContent === SETTINGS[key].label);
          return { key, interactive: !!control, specified: !!row?.querySelector('dd')?.textContent.trim(),
            backingPresent: backing.length > 0, backingDisabled: backing.every(input => input.disabled) };
        });
        return { locked,
          editable: [...document.querySelectorAll('#customSettingsGrid [data-setting]')].map(control => control.dataset.setting).sort(),
          expectedEditable: selected.editableSettings.filter(key => !selected.lockedSettings.includes(key)).sort() };
      }, profile);
      // Fixed scenario settings are readable specifications, while only editable settings are controls.
      for (const setting of settings.locked) {
        assert.equal(setting.interactive, false, `${profile}: fixed ${setting.key} became an interactive control`);
        assert.equal(setting.specified, true, `${profile}: missing ${setting.key} specification`);
        assert.equal(setting.backingPresent, true, `${profile}: missing ${setting.key} capture setting`);
        assert.equal(setting.backingDisabled, true, `${profile}: ${setting.key} drawer lock was removed`);
      }
      assert.deepEqual(settings.editable, settings.expectedEditable, `${profile}: editable scenario controls`);
      const before = await page.evaluate(() => window.__reports.length);
      const selector = call ? '#testBtn' : '#recordToggle';
      await page.locator(selector).click();
      await page.waitForFunction(expected => document.body.dataset.appState === expected,
        call ? 'testing' : 'recording', { timeout: 15000 });
      // Call scenarios exercise the complete timed test; recordings are stopped manually.
      if (!call) {
        await page.waitForTimeout(1500);
        await page.locator(selector).click();
      }
      try {
        await page.waitForFunction(count => window.__reports.length > count, before, { timeout: 20000 });
      } catch (error) {
        console.error(await page.evaluate(async () => ({ message: document.querySelector('#userMessage')?.textContent,
          mode: (await import('/js/app/AppState.js')).getCurrentMode(),
          errors: (await import('/js/modules/LogManager.js')).default.getByCategory('error').slice(-5) })));
        throw error;
      }
      const result = await page.evaluate(async () => {
        const report = window.__reports.at(-1);
        const evaluator = (await import('/js/modules/ReportEvaluator.js')).default;
        return { profile: report.profile, run: report.run, deepStatus: report.deepAnalysis?.status,
          deepReason: report.deepAnalysis?.reason,
          metrics: { status: report.audioMetrics?.status, source: report.audioMetrics?.source,
            sampleCount: report.audioMetrics?.sampleCount, durationMs: report.audioMetrics?.durationMs,
            channels: report.audioMetrics?.channels?.length }, recording: report.recording,
          loopback: report.loopback, summary: evaluator.evaluateFree(report).overall,
          liveTracks: window.__testTracks.filter(t => t.readyState !== 'ended').length,
          mode: (await import('/js/app/AppState.js')).getCurrentMode() };
      });
      console.log(JSON.stringify({ test: 'profile-roundtrip', profile, encoder: result.profile.encoder,
        applied: result.profile.appliedConstraints, deepStatus: result.deepStatus, deepReason: result.deepReason,
        metrics: result.metrics, bitrateMode: result.recording?.bitrateMode,
        pipeline: result.profile.pipeline, fileMime: result.recording?.mimeType,
        senderCodec: result.loopback?.senderCodec, receiverCodec: result.loopback?.receiverCodec,
        evidenceVerifiedAt: result.profile.evidence?.verifiedAt,
        receivedPackets: result.loopback?.receive?.packetsReceived, liveTracks: result.liveTracks, mode: result.mode }));
      assert.equal(result.profile.id, profile);
      assert.equal(result.deepStatus, 'ready');
      assert.equal(result.metrics.status, 'measured');
      assert.equal(result.metrics.source, 'decoded-file-pcm');
      assert.ok(result.metrics.sampleCount > 0);
      assert.equal(result.liveTracks, 0);
      assert.equal(result.mode, null);
      assert.deepEqual(result.profile.evidence, evidence, `${profile}: captured evidence must survive the real report path`);
      if (profile === 'raw') {
        assert.equal(result.recording.encoder, 'pcm-wav');
        assert.equal(result.recording.mimeType, 'audio/wav');
        assert.equal(result.recording.bitrateMode, 'uncompressed-pcm');
      }
      if (profile === 'whatsapp-voice') {
        assert.equal(result.profile.pipeline, 'worklet');
        assert.equal(result.recording.pipeline, 'worklet');
        assert.equal(result.recording.encoder, 'wasm-opus');
        assert.equal(result.recording.mimeType, 'audio/ogg; codecs=opus');
        assert.equal(result.recording.requestedBitrate, values.mediaBitrate);
        assert.equal(result.recording.bitrateMode, 'requested');
      }
      if (profile === 'telegram-voice') assert.equal(result.recording.bitrateMode, 'encoder-default-vbr');
      if (call) {
        assert.ok(result.loopback?.receive?.packetsReceived > 0);
        assert.equal(result.loopback.requestedBitrate, values.bitrate);
        for (const peer of ['senderCodec', 'receiverCodec']) {
          assert.equal(result.loopback[peer]?.source, 'rtc-codec-stats', `${profile}: observed ${peer} provenance`);
          assert.equal(result.loopback[peer]?.mimeType.toLowerCase(), 'audio/opus');
          assert.equal(result.loopback[peer]?.clockRate, 48000);
        }
        assert.equal(result.profile.encoder, null, 'call capture encoder is not the negotiated RTP codec');
        assert.equal(result.recording.encoder, 'mediarecorder');
        assert.match(result.recording.mimeType, /^audio\//);
        assert(['mediarecorder', 'dataavailable'].includes(result.recording.mimeTypeSource));
        assert.equal(result.recording.sampleSource, 'saved-received-audio');
        assert.equal(result.recording.bitrateMode, 'browser-default');
        assert.equal(result.recording.requestedBitrate, null, 'RTP bitrate limit is not a file encoder request');
        assert.equal(result.recording.actualBitrate, null, 'encoder-reported bitrate is not measured file throughput');
      }
    }
    // Run the existing browser-only suites away from the app's live EventBus listeners.
    await page.goto('http://localhost:8080/js/tests/audio-audit-browser.html');
    await page.locator('#results:not([data-status="running"])').waitFor({ timeout: 60000 });
    const legacy = await page.evaluate(async () => ({
      pipelines: await (await import('/js/tests/pipelines.test.js')).runPipelineTests(),
      events: await (await import('/js/tests/eventOrdering.test.js')).runEventOrderingTests()
    }));
    console.log(JSON.stringify({ test: 'existing-browser-suites', ...legacy }));
    assert.equal(legacy.pipelines.failed, 0);
    assert.equal(legacy.events.failed, 0);
    assert.deepEqual(errors, []);
    console.log(`PASS: ${profiles.length} profile capture/playback/report round trips; no live microphone tracks or page errors.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
