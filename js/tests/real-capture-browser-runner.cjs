// Measurement run: feeds a known WAV to Chrome as the fake microphone and records every
// profile through the real app, saving the measured file and its report for the reference
// comparison in scripts/reference-audio-metrics.py. No pass/fail assertions live here.
// Requires Playwright (installed locally or via NODE_PATH) and localhost:8080.
//   node js/tests/real-capture-browser-runner.cjs --wav <source.wav> --out <dir> [--profiles raw,discord]
//        [--record-seconds 8] [--base-url http://localhost:8080] [--headed]
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const wavPath = path.resolve(option('wav', ''));
const outDir = path.resolve(option('out', path.join('.tmp', 'real-capture', new Date().toISOString().slice(0, 10))));
const onlyProfiles = option('profiles', '').split(',').map(id => id.trim()).filter(Boolean);
const recordSeconds = Number(option('record-seconds', '8'));
const headed = args.includes('--headed');
const baseUrl = option('base-url', 'http://localhost:8080').replace(/\/$/, '');

if (!wavPath || !fs.existsSync(wavPath)) {
  console.error('Usage: --wav <16-bit PCM WAV> is required (Chrome fake audio capture reads WAV only).');
  process.exit(2);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const sourceCopy = path.join(outDir, 'source.wav');
  if (path.resolve(sourceCopy) !== wavPath) fs.copyFileSync(wavPath, sourceCopy);
  // %noloop keeps a short source from wrapping around; recordings stay shorter than the source anyway.
  const browser = await chromium.launch({ channel: 'chrome', headless: !headed,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`, '--autoplay-policy=no-user-gesture-required'] });
  const manifest = { layer: 'fake-capture', createdAt: new Date().toISOString(), sourceWav: 'source.wav',
    chrome: browser.version(), baseUrl, recordSeconds, entries: [] };
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.__testTracks = [];
      // The Player publishes the measured file through URL.createObjectURL; keep the Blob itself so the
      // saved bytes are exactly what the report measured (matched by report.recording.blobSize).
      const createObjectURL = URL.createObjectURL.bind(URL);
      window.__objectUrls = [];
      URL.createObjectURL = object => {
        const url = createObjectURL(object);
        window.__objectUrls.push({ url, blob: object, type: object?.type || '', size: object?.size ?? null, at: Date.now() });
        return url;
      };
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await original(constraints);
        window.__testTracks.push(...stream.getTracks());
        return stream;
      };
    });
    const page = await context.newPage();
    await require('./scenario-browser-helpers.cjs').allowTestAccess(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${baseUrl}/#app`);
    await page.waitForFunction(() => document.body.classList.contains('app-mode'), null, { timeout: 15000 });
    await page.evaluate(async () => {
      window.__reports = [];
      const bus = (await import('/js/modules/EventBus.js')).default;
      const { EVENTS } = await import('/js/modules/constants.js');
      bus.on(EVENTS.DIAGNOSTIC_REPORT_READY, r => window.__reports.push(r));
    });
    const profiles = (await page.evaluate(async () => Object.values((await import('/js/modules/Config.js')).PROFILES)
      .map(profile => ({ id: profile.id, canTest: profile.canTest, label: profile.label }))))
      .filter(profile => !onlyProfiles.length || onlyProfiles.includes(profile.id));
    for (const { id: profile, canTest: call, label } of profiles) {
      await page.evaluate(async id => {
        (await import('/js/ui/ReportPanelUI.js')).default.close?.();
        await (await import('/js/ui/ProfileUIManager.js')).default.handleProfileSelect(id);
      }, profile);
      const before = await page.evaluate(() => window.__reports.length);
      const selector = call ? '#testBtn' : '#recordToggle';
      const startedAt = Date.now();
      await page.locator(selector).click();
      await page.waitForFunction(async () => !(await import('/js/app/AppState.js')).getIsPreparing(), null, { timeout: 15000 });
      if (!call) {
        await page.waitForTimeout(recordSeconds * 1000);
        await page.locator(selector).click();
      }
      try {
        await page.waitForFunction(count => window.__reports.length > count, before, { timeout: 40000 });
      } catch (error) {
        console.error(JSON.stringify({ profile, message: await page.evaluate(async () => ({
          userMessage: document.querySelector('#userMessage')?.textContent,
          mode: (await import('/js/app/AppState.js')).getCurrentMode(),
          errors: (await import('/js/modules/LogManager.js')).default.getByCategory('error').slice(-5) })) }));
        throw error;
      }
      await page.waitForFunction(since => {
        const report = window.__reports.at(-1);
        return window.__objectUrls.some(entry => entry.at >= since && entry.blob instanceof Blob
          && (entry.size === report?.recording?.blobSize || /^audio\//.test(entry.type)));
      }, startedAt, { timeout: 15000 });
      const captured = await page.evaluate(async since => {
        const report = window.__reports.at(-1);
        const evaluator = (await import('/js/modules/ReportEvaluator.js')).default;
        const evaluation = evaluator.evaluateFree(report);
        const candidates = window.__objectUrls.filter(entry => entry.at >= since && entry.blob instanceof Blob);
        const entry = candidates.find(item => item.size === report?.recording?.blobSize)
          || candidates.filter(item => /^audio\//.test(item.type)).at(-1);
        const blob = entry.blob;
        const button = document.getElementById('downloadBtn');
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        return { report, evaluation, filename: button?.download || '', mimeType: blob.type, size: blob.size,
          sizeMatchesReport: blob.size === report?.recording?.blobSize, downloadHrefMatches: button?.href === entry.url,
          base64: String(dataUrl).split(',')[1],
          liveTracks: window.__testTracks.filter(t => t.readyState !== 'ended').length };
      }, startedAt);
      const mimeExt = { 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/webm': '.webm', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3' };
      const ext = path.extname(captured.filename || '') || mimeExt[captured.mimeType.split(';')[0].trim()] || '.bin';
      const audioName = `${profile}${ext}`;
      const reportName = `${profile}.report.json`;
      fs.writeFileSync(path.join(outDir, audioName), Buffer.from(captured.base64, 'base64'));
      fs.writeFileSync(path.join(outDir, reportName), JSON.stringify({ layer: 'fake-capture', profile, label,
        capturedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, originalFilename: captured.filename,
        report: captured.report, evaluation: captured.evaluation }, null, 2));
      manifest.entries.push({ id: profile, profile, scenario: `fake-capture ${path.basename(wavPath)}`, audio: audioName,
        report: reportName, expectFindings: [], notes: `${label}; ${call ? 'timed call test' : `${recordSeconds}s recording`}` });
      const metrics = captured.report.audioMetrics || {};
      console.log(JSON.stringify({ profile, file: audioName, bytes: captured.size, mime: captured.mimeType,
        sizeMatchesReport: captured.sizeMatchesReport, downloadHrefMatches: captured.downloadHrefMatches,
        deep: captured.report.deepAnalysis?.status, reason: captured.report.deepAnalysis?.reason,
        lufs: metrics.lufs?.integrated, rmsDb: metrics.signal?.rmsDb, peakDb: metrics.signal?.peakDb,
        sampleRate: metrics.coverage?.sampleRate, channels: metrics.coverage?.numberOfChannels,
        findings: (captured.evaluation.findings || []).map(f => f.id), liveTracks: captured.liveTracks }));
    }
    manifest.pageErrors = errors;
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`DONE: ${manifest.entries.length} profile(s) captured into ${outDir}; page errors: ${errors.length}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
