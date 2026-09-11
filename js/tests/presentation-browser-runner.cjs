// Layout fixtures, not audio-quality tests. Requires localhost:8080, Playwright and Chrome.
const { chromium } = require('playwright');
const { selectScenario } = require('./scenario-browser-helpers.cjs');
const assert = require('node:assert/strict');
const BASE = 'http://localhost:8080';
const widths = [320, 479, 480, 767, 768, 1023, 1024, 1199, 1200, 1440, 1920];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await require('./scenario-browser-helpers.cjs').allowTestAccess(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.origin !== BASE, route => route.fulfill({ body: '' }));
    await page.route('**/api/account/**', route => route.fulfill({ json: { ok: true, configured: false, user: null } }));
    await page.route('**/api/freemius/config', route => route.fulfill({ json: { configured: false } }));

    const noOverflow = async label => assert(await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${label}: horizontal overflow`);
    let footerReference;
    for (const route of ['/', '/app/', '/privacy.html', '/terms.html']) {
      await page.goto(BASE + route);
      if (route === '/app/') {
        await page.waitForFunction(() => document.body.classList.contains('app-mode'));
        await page.locator('#scenarioChoices [data-profile="discord"]').click();
      }
      const links = await page.locator('.site-footer-links a, .site-footer-contact').evaluateAll(nodes =>
        nodes.map(node => ({ text: node.textContent.trim(), href: node.getAttribute('href') })));
      footerReference ||= links;
      assert.deepEqual(links, footerReference, `${route}: footer navigation parity`);
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        // Resize completion precedes the frame that applies media queries to all layout boxes.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
        await noOverflow(`${route} ${width}`);
        assert(await page.locator('.site-footer-brand').isVisible());
        for (const link of await page.locator('.site-footer-links a').all()) {
          assert(await link.isVisible());
          assert(await link.evaluate(node => node.getBoundingClientRect().height >= 40));
        }
        assert(await page.evaluate(() => {
          const header = [...document.querySelectorAll('.header-base')].find(node => node.getClientRects().length);
          const rect = header.getBoundingClientRect();
          return [...header.querySelectorAll('.brand-lockup, .navbar-link, .navbar-cta, .workspace-account-actions')]
            .filter(node => node.getClientRects().length)
            .every(node => {
              const item = node.getBoundingClientRect();
              return item.top >= rect.top && item.bottom <= rect.bottom;
            });
        }), `${route}/${width}: header controls must fit its height`);
        if (route === '/') {
          assert(await page.locator('.hero-buttons .btn').evaluateAll(buttons => buttons.every(button => {
            const outer = button.getBoundingClientRect();
            const label = button.querySelector('.btn-text').getBoundingClientRect();
            return Math.abs((label.left + label.right - outer.left - outer.right) / 2) < 0.1;
          })), `${width}: both hero labels must be centered independently of their icons`);
          const edges = await page.evaluate(() => ['#navbarBrand', '.section-header', '.features-grid', '.steps-container', '.site-footer-content']
            .map(selector => ({ selector, left: document.querySelector(selector).getBoundingClientRect().left })));
          assert(edges.every(rect => Math.abs(rect.left - edges[0].left) < 1),
            `${width}: landing header, content and footer must share a left edge: ${JSON.stringify(edges)}`);
        }
        if (route === '/app/') {
          const edges = await page.evaluate(() => ['.app-header .brand-mark', '.scenario-workspace', '.site-footer-content']
            .map(selector => ({ selector, left: document.querySelector(selector).getBoundingClientRect().left })));
          assert(edges.every(rect => Math.abs(rect.left - edges[0].left) < 1),
            `${width}: app header, workspace and footer must share an edge: ${JSON.stringify(edges)}`);
          assert.equal(await page.locator('#profileSidebar, #profileMenuBtn').count(), 0);
          assert(await page.evaluate(() => {
            const mic = document.querySelector('.mic-selector-row').getBoundingClientRect();
            const settings = document.querySelector('#customSettingsPanel').getBoundingClientRect();
            const action = document.querySelector('#testBtn').getBoundingClientRect();
            return mic.bottom <= settings.top && settings.bottom <= action.top;
          }), `${width}: microphone and optional settings must precede Start test`);
          assert.equal(await page.locator('.console-card-section--meters').isVisible(), false);
        }
      }
    }
    console.log('PASS 44 page/width variants and shared footer content, visibility and target sizes');

    await page.goto(`${BASE}/#how-it-works`);
    assert(await page.locator('#how-it-works-title').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.top >= document.querySelector('#navbar').getBoundingClientRect().bottom && rect.bottom <= innerHeight;
    }), 'Direct section route must reveal its heading below the navbar');
    await page.locator('#heroLaunchBtn').click();
    await page.waitForFunction(() => document.body.classList.contains('app-mode'));
    await page.locator('.site-footer-links a[href="/#features"]').click();
    assert(await page.evaluate(() => !document.body.classList.contains('app-mode')));
    assert(await page.locator('#features').evaluate(node => Math.abs(node.getBoundingClientRect().top) < 180));
    await page.locator('#heroLaunchBtn').click();
    await page.waitForFunction(() => document.body.classList.contains('app-mode'));
    console.log('PASS direct section routes and app-to-landing footer navigation');

    await page.goto(BASE);
    for (const width of [320, 479, 767]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('#mobileMenuBtn').click();
      assert(await page.locator('#mobileNav').evaluate(node => {
        const rect = node.getBoundingClientRect();
        return [...node.querySelectorAll('a, button')].every(child => {
          const item = child.getBoundingClientRect();
          return item.height >= 48 && item.left >= rect.left && item.right <= rect.right
            && item.top >= rect.top && item.bottom <= rect.bottom;
        });
      }), `${width}: expanded mobile menu targets must fit`);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#mobileMenuBtn').getAttribute('aria-expanded'), 'false');
    }
    await page.locator('#heroLaunchBtn').click();
    await page.waitForFunction(() => document.body.classList.contains('app-mode'));
    console.log('PASS mobile navigation geometry and Escape recovery');

    const profiles = await page.locator('.nav-item[data-profile]').evaluateAll(nodes => nodes.map(node => node.dataset.profile));
    for (const profile of profiles) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await selectScenario(page, profile);
      if (await page.locator('#customSettingsToggle').getAttribute('aria-expanded') !== 'true') await page.locator('#customSettingsToggle').click();
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        await noOverflow(`${profile} ${width}, expanded settings`);
      }
    }
    console.log(`PASS ${profiles.length * widths.length} profile/width variants with expanded settings`);

    async function phase(mode, preparing = false) {
      await page.evaluate(async ({ mode, preparing }) => {
        const state = await import('/js/app/AppState.js');
        state.setCurrentMode(mode);
        state.setIsPreparing(preparing);
        (await import('/js/modules/UIStateManager.js')).default.updateButtonStates();
        document.querySelector('#testCountdown').textContent = '7';
      }, { mode, preparing });
    }
    let stateVariants = 0;
    for (const profile of ['discord', 'raw']) {
      await phase(null);
      await page.setViewportSize({ width: 1440, height: 900 });
      await selectScenario(page, profile);
      const mode = profile === 'discord' ? 'test-recording' : 'recording';
      for (const [current, preparing] of [[null, false], [mode, true], [mode, false], ...(profile === 'discord' ? [['test-analysing', false]] : [])]) {
        await phase(current, preparing);
        for (const width of [320, 480, 768, 1200]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
          const metrics = await page.locator(profile === 'discord' ? '#testBtn' : '#recordToggle').evaluate(node => {
            const rect = node.getBoundingClientRect();
            const children = [...node.children].filter(child => {
              const css = getComputedStyle(child);
              return css.display !== 'none' && css.position !== 'absolute';
            }).map(child => child.getBoundingClientRect());
            const label = node.querySelector('.btn-text').getBoundingClientRect();
            return { height: rect.height, clipped: node.scrollWidth > node.clientWidth, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
              centered: Math.abs((label.left + label.right - rect.left - rect.right) / 2),
              fits: children.every(child => child.top >= rect.top && child.bottom <= rect.bottom && child.left >= rect.left && child.right <= rect.right) };
          });
          assert.equal(metrics.height, 48);
          assert.equal(metrics.clipped, false, `${profile}/${current}/${preparing}/${width}: ${JSON.stringify(metrics)}`);
          assert(metrics.fits);
          assert(metrics.centered < 0.1, `${profile}/${current}/${width}: off-center content`);
          if (current) assert(await page.locator('#sharedFooter').evaluate(node => node.inert));
          if (profile === 'discord' && current === 'test-recording' && !preparing && width === 1200) {
            if (!await page.locator('#audioDetails').evaluate(node => node.open)) await page.locator('#audioDetails > summary').click();
            await page.locator('#devConsoleToggle').click();
            assert.equal(await page.locator('#devConsoleToggle').getAttribute('aria-expanded'), 'true');
            await page.getByRole('button', { name: 'Close console', exact: true }).click();
            assert.equal(await page.locator('#devConsoleToggle').getAttribute('aria-expanded'), 'false');
          }
          stateVariants++;
        }
      }
    }
    await phase(null);
    console.log(`PASS ${stateVariants} idle/preparing/capture/analysis button layout variants and footer locks`);

    await page.locator('#changeScenarioBtn').click();
    await page.locator('#scenarioPicker').waitFor({ state: 'visible' });
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
      assert(await page.locator('#scenarioPicker').isVisible());
      assert(await page.evaluate(() => !document.documentElement.classList.contains('is-scroll-locked') && !document.querySelector('.main-content').inert));
      assert(await page.evaluate(() => {
        const picker = document.querySelector('#scenarioPicker').getBoundingClientRect();
        const footer = document.querySelector('.site-footer-content').getBoundingClientRect();
        return Math.abs(picker.left - footer.left) < 1 && Math.abs(picker.right - footer.right) < 1;
      }), `${width}: chooser and footer edges must align`);
      if (width >= 768) assert(await page.evaluate(() => {
        const calls = [...document.querySelectorAll('.scenario-call-choices .scenario-choice')].slice(0, 2).map(node => node.getBoundingClientRect());
        const groups = [...document.querySelectorAll('.scenario-choices > .scenario-group')].slice(-2).map(node => node.getBoundingClientRect());
        return groups.every((rect, index) => Math.abs(rect.left - calls[index].left) < 1 && Math.abs(rect.width - calls[index].width) < 1);
      }), `${width}: scenario groups must use the same column edges`);
    }
    await selectScenario(page, 'raw');

    // A deliberately long result exercises wrapping and scroll ownership without capturing audio.
    await page.evaluate(async () => {
      const panel = (await import('/js/ui/ReportPanelUI.js')).default;
      const { createWavBlob } = await import('/js/modules/utils/wav.js');
      const { EVENTS } = await import('/js/modules/constants.js');
      (await import('/js/modules/EventBus.js')).default.emit(EVENTS.RECORDING_COMPLETED, {
        blob: await createWavBlob([new Float32Array(48000)], 48000, 1), mimeType: 'audio/wav', filename: 'layout.wav', durationMs: 1000,
        runSnapshot: { runId: 'layout-fixture', profileLabel: 'Raw Recording' }
      });
      panel._renderReport({ run: { id: 'layout-fixture', type: 'record' }, profile: { id: 'raw' }, audioMetrics: { status: 'unavailable' } });
      panel.open();
    });
    for (const [width, height] of [[320, 600], [480, 600], [768, 600], [1200, 600], [1280, 360], [667, 375], [844, 390], [320, 360]]) {
      await page.setViewportSize({ width, height });
      assert(await page.locator('#reportPanel').evaluate(node => node.scrollWidth <= node.clientWidth));
      assert(await page.evaluate(() => {
        const header = document.querySelector('.report-popup-header').getBoundingClientRect();
        const body = document.querySelector('.report-popup-body').getBoundingClientRect();
        return [...document.querySelectorAll('.report-popup-actions button')].every(node => node.getBoundingClientRect().bottom <= header.bottom)
          && header.bottom <= body.top;
      }), `${width}: report actions must stay above scrolling content`);
      if (height < 480) assert(await page.locator('.report-popup-body').evaluate(node => node.clientHeight >= 150),
        `${width}x${height}: short report must retain reading space`);
    }
    await page.getByRole('button', { name: 'Close report', exact: true }).click();
    await page.locator('#accountMenuBtn').click();
    await page.setViewportSize({ width: 320, height: 600 });
    // Sign-in is now compact. Supply enough content to actually exercise body scrolling.
    const accountDialog = page.locator('.account-dialog[open]');
    await accountDialog.locator('.account-dialog-body').evaluate(node => {
      for (let i = 0; i < 20; i++) {
        const line = document.createElement('p');
        line.textContent = `Saved report layout fixture ${i + 1}`;
        node.append(line);
      }
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const headerTop = await accountDialog.locator('.account-dialog-header').evaluate(node => node.getBoundingClientRect().top);
    await accountDialog.locator('.account-dialog-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
    assert(await accountDialog.locator('.account-dialog-body').evaluate(node => node.scrollTop > 0));
    assert.equal(await accountDialog.locator('.account-dialog-header').evaluate(node => node.getBoundingClientRect().top), headerTop);
    assert.equal(await accountDialog.locator('.account-dialog-header .btn-overlay-close').evaluate(node => node.getBoundingClientRect().width), 32);
    console.log('PASS narrow report/header containment and persistent account close control');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
