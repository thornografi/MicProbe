// Presentation fixtures only: no physical microphone, account writes or platform claims.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const pw = require('playwright');
const BASE = 'http://localhost:8080';
const sizes = [[320,568],[375,667],[390,844],[479,800],[480,800],[767,900],[768,900],
  [1023,900],[1024,900],[1199,900],[1200,900],[1440,900],[1920,1080],[2560,1440],[667,375],[320,360]];
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

(async () => {
  const { reviewReport } = await import('./review-fixtures.mjs');
  await fs.mkdir('.tmp/player-layout', { recursive: true });
  const results = [];
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    const firstResult = results.length;
    const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' ? { channel: 'chrome' } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', acceptDownloads: true });
      const page = await context.newPage(), errors = [], downloads = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('download', download => downloads.push(download));
      await page.addInitScript(() => {
        if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {} });
        navigator.mediaDevices.getUserMedia = async () => { throw Error('Layout fixture must not request capture'); };
      });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== BASE) return route.fulfill({ body: '' });
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, configured: false, user: null, reports: [] } });
        return route.continue();
      });
      // Control asynchronous conversion to verify failure and stale-result handling.
      await page.route('**/js/modules/Mp3Converter.js', route => route.fulfill({ contentType: 'text/javascript', body:
        `export function convertToMp3(blob, options) { return new Promise((resolve, reject) => {
          window.__conversion = { resolve, reject, progress: options.onProgress }; options.onProgress(25);
        }); }` }));
      const appSource = await fs.readFile('js/app.js', 'utf8');
      await page.route('**/js/app.js', route => route.fulfill({ contentType:'text/javascript',
        body:appSource + '\nexport { player as fixturePlayer };' }));
      await page.goto(`${BASE}/app`);
      await page.locator('#scenarioChoices [data-profile="raw"]').click();
      await page.evaluate(async () => {
        window.__player = (await import('/js/app.js')).fixturePlayer;
        window.__load = async ({ mime = 'audio/wav', ext = 'wav', label = 'WhatsApp Voice Message', id = 'player-layout' } = {}) => {
          // A silent WAV is retyped for format-label tests; these are not codec validations.
          const { createWavBlob } = await import('/js/modules/utils/wav.js');
          const wav = await createWavBlob([new Float32Array(4800)], 48000, 1);
          window.__player.load({ blob: new Blob([wav], { type: mime }), mimeType: mime, filename: `sample.${ext}`, durationMs: 10000,
            runSnapshot: { runId: id, profileLabel: label, startedAt: '2026-09-12T08:39:00Z' } });
        };
        await window.__load();
      });
      for (const variant of ['normal', 'warning', 'insufficient']) {
        const report = reviewReport('player-' + variant, variant === 'normal' ? { signal: {
          rmsDb: -22, peakDb: -8, maxBlockRmsDb: -17, maxBlockRmsStatus: 'measured', maxBlockRmsWindowMs: 10
        } } : {});
        if (variant === 'insufficient') report.audioMetrics = { source: 'decoded-file-pcm', status: 'unavailable' };
        await page.evaluate(async ({ report, variant }) => {
          const panel = (await import('/js/ui/ReportPanelUI.js')).default;
          panel.setWorkflowActions({ getIsBusy: () => false, canRetest: () => true });
          await window.__load({ id: report.run.id, label: variant === 'warning' ? 'Voice recording' : 'WhatsApp Voice Message' });
          panel._renderReport(report);
        }, { report, variant });
        assert.equal(await page.locator('#testGuide').evaluate(node => node.open), false);
        for (const scale of [1,2]) {
          await page.evaluate(scale => {
            for (const [key, value] of Object.entries({ xs:12, sm:13, base:14, md:15, lg:16, xl:20, '2xl':24 })) {
              document.documentElement.style.setProperty(`--fs-${key}`, `${value * scale}px`);
            }
          }, scale);
          for (const [width,height] of process.argv.includes('--interactions-only') ? [] : sizes) {
            const name = `${engine}/${variant}/${width}x${height}/${scale}x`;
            await page.setViewportSize({ width,height });
            await page.locator('#resultCard').evaluate(node => node.scrollIntoView({ block: 'start' }));
            await settle(page);
            const geometry = await page.evaluate(() => {
              const box = selector => {
                const node = document.querySelector(selector), rect = node.getBoundingClientRect();
                return { top:rect.top, bottom:rect.bottom, right:rect.right, left:rect.left, height:rect.height };
              };
              const time = document.querySelector('#playerTime'), range = document.createRange();
              range.selectNodeContents(time);
              return { card:box('#resultCard'), player:box('#recordingPlayer'), summary:box('#inlineResult'),
                guide:box('#inlineResultGuidance'), progress:box('#progressBar'), button:box('#downloadMenuBtn'), time:box('#playerTime'),
                timeLines:range.getClientRects().length, overflow:document.documentElement.scrollWidth-innerWidth,
                clipped:[...document.querySelectorAll('#resultCard button,#resultCard p,#playerFilename')]
                  .filter(node => node.getClientRects().length && node.scrollWidth > node.clientWidth + 1).map(node => node.id) };
            });
            assert(geometry.overflow <= 1, `${name}: horizontal overflow`);
            assert.deepEqual(geometry.clipped, [], `${name}: clipped text`);
            assert.equal(geometry.timeLines, 1, `${name}: elapsed/total time must stay on one line`);
            assert(geometry.progress.height >= 48, `${name}: seek touch target`);
            assert(geometry.summary.bottom <= geometry.player.top && geometry.player.bottom <= geometry.guide.top, `${name}: result → player → guidance`);
            assert(geometry.button.bottom <= geometry.time.top + 1, `${name}: Download above time`);
            results.push({ name, playerOffset:geometry.player.top-geometry.card.top, cardHeight:geometry.card.height });
            await page.locator('#downloadMenuBtn').click();
            await page.locator('#downloadMenu.is-positioned').waitFor({ state:'visible' });
            await settle(page);
            const menu = await page.locator('#downloadMenu').evaluate(node => {
              const rect = node.getBoundingClientRect();
              return { inside:rect.left >= 15 && rect.top >= 15 && rect.right <= innerWidth-15 && rect.bottom <= innerHeight-15,
                fits:node.scrollWidth <= node.clientWidth+1, rect:rect.toJSON(), viewport:[innerWidth,innerHeight],
                anchor:document.querySelector('#downloadMenuBtn').getBoundingClientRect().toJSON(), style:node.getAttribute('style') };
            });
            assert(menu.inside && menu.fits, `${name}: download menu must fit viewport: ${JSON.stringify(menu)}`);
            if (engine === 'chromium' && variant === 'normal' && [320,390,1920,667].includes(width) && (width !== 320 || height === 568)) {
              await page.screenshot({ path:`.tmp/player-layout/${width}-${height}-${scale}x-menu.png` });
            }
            await page.keyboard.press('Escape');
            await settle(page);
            assert.equal(await page.locator('#downloadMenuBtn').getAttribute('aria-expanded'), 'false');
          }
        }
      }
      await page.setViewportSize({ width:1024,height:900 });
      await page.evaluate(() => { document.documentElement.removeAttribute('style'); });
      for (const [mime,ext] of [['audio/wav','wav'],['audio/ogg;codecs=opus','ogg'],['audio/webm;codecs=opus','webm'],['audio/mp4','m4a'],['audio/mpeg','mp3']]) {
        await page.evaluate(args => window.__load(args), { mime,ext });
        await page.locator('#downloadMenuBtn').focus();
        await page.keyboard.press('ArrowDown');
        await page.locator('#downloadMenu.is-positioned').waitFor({ state:'visible' });
        assert.equal(await page.locator('#downloadOriginalLabel').innerText(), `Original · ${ext.toUpperCase()}`);
        assert.equal(await page.locator('#downloadBtn').evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator('#downloadMp3Btn').isVisible(), ext !== 'mp3');
        if (ext !== 'mp3') {
          await page.keyboard.press('ArrowDown');
          assert.equal(await page.locator('#downloadMp3Btn').evaluate(node => node === document.activeElement), true);
        }
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#downloadMenuBtn').evaluate(node => node === document.activeElement), true);
      }
      await page.evaluate(() => window.__load());
      await page.locator('#downloadMenuBtn').click();
      await page.locator('#playerFilename').click();
      await settle(page);
      assert.equal(await page.locator('#downloadMenu').isVisible(), false, 'Outside click dismisses');
      for (const mode of ['recording','test-recording','test-analysing']) {
        await page.locator('#downloadMenuBtn').click();
        await page.evaluate(async mode => {
          const manager = (await import('/js/modules/UIStateManager.js')).default;
          window.__oldGetMode = manager.getState.currentMode;
          manager.setStateGetters({ currentMode:() => mode }); manager.updateButtonStates();
        }, mode);
        await settle(page);
        assert.equal(await page.locator('#downloadMenuBtn').isDisabled(), true, mode);
        assert.equal(await page.locator('#downloadMenu').isVisible(), false, mode);
        await page.evaluate(async () => {
          const manager = (await import('/js/modules/UIStateManager.js')).default;
          manager.setStateGetters({ currentMode:window.__oldGetMode }); manager.updateButtonStates();
        });
      }
      await page.locator('#downloadMenuBtn').click();
      await page.locator('#downloadMp3Btn').click();
      assert.match(await page.locator('#downloadStatus').innerText(), /25%/);
      assert.equal(await page.locator('#downloadMenu').isVisible(), false);
      await page.evaluate(() => window.__conversion.reject(Error('fixture conversion failure')));
      await page.waitForFunction(() => document.querySelector('#downloadStatus').textContent.includes('could not'));
      await page.locator('#downloadMenuBtn').click();
      const downloaded = page.waitForEvent('download');
      await page.locator('#downloadBtn').click();
      assert.equal((await downloaded).suggestedFilename(), 'sample.wav', 'Original survives MP3 failure');
      await page.locator('#downloadMenuBtn').click();
      await page.locator('#downloadMp3Btn').click();
      const count = downloads.length;
      await page.evaluate(async () => {
        const old = window.__conversion;
        await window.__load({ ext:'webm',mime:'audio/webm',label:'New recording' });
        old.progress(100); old.resolve(new Blob(['old mp3'], { type:'audio/mpeg' }));
      });
      await settle(page);
      assert.equal(downloads.length, count, 'Stale conversion cannot download');
      assert.equal(await page.locator('#downloadStatus').innerText(), '');
      assert.equal(await page.locator('#downloadOriginalLabel').textContent(), 'Original · WEBM');
      await page.locator('#downloadMenuBtn').click();
      await page.evaluate(() => window.__player.reset());
      await settle(page);
      assert.equal(await page.locator('#downloadMenu').isVisible(), false);
      assert.equal(await page.locator('#resultCard').isVisible(), false);
      assert.equal(await page.locator('#testGuide').evaluate(node => node.open), true);
      assert.deepEqual(errors, []);
      console.log(`PASS ${engine}: ${results.length - firstResult} result layouts, five formats, keyboard, dismissal, capture locks, conversion failure/stale result and reset`);
    } finally { await browser.close(); }
  }
  await fs.writeFile('.tmp/player-layout/metrics.json', JSON.stringify(results,null,2));
  console.log(`PASS ${results.length} result/player/menu layouts`);
})().catch(error => { console.error(error); process.exitCode = 1; });
