// Layout fixtures, not audio-quality tests. Requires localhost:8080, Playwright and Chrome.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = 'http://localhost:8080';
const widths = [320, 479, 480, 767, 768, 1023, 1024, 1199, 1200, 1440, 1920];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
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
          const edges = await page.evaluate(() => ['#navbarBrand', '.section-header', '.features-grid', '.steps-container', '.site-footer-content']
            .map(selector => ({ selector, left: document.querySelector(selector).getBoundingClientRect().left })));
          assert(edges.every(rect => Math.abs(rect.left - edges[0].left) < 1),
            `${width}: landing header, content and footer must share a left edge: ${JSON.stringify(edges)}`);
        }
        if (route === '/app/' && width >= 768) {
          assert(await page.evaluate(() => {
            const rail = document.querySelector('.sidebar').getBoundingClientRect();
            const note = document.querySelector('.sidebar-note').getBoundingClientRect();
            const console = document.querySelector('#devConsoleToggle').getBoundingClientRect();
            const footer = document.querySelector('.site-footer').getBoundingClientRect();
            return Math.abs(rail.bottom - footer.top) < 1 && console.top >= note.bottom
              && console.bottom <= rail.bottom && console.left >= rail.left && console.right <= rail.right;
          }), `${width}: console must fit below the rail content without a separate footer band`);
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
      await page.locator(`.nav-item[data-profile="${profile}"]`).click();
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
      await page.locator(`.nav-item[data-profile="${profile}"]`).click();
      const mode = profile === 'discord' ? 'test-recording' : 'recording';
      for (const [current, preparing] of [[null, false], [mode, true], [mode, false], ...(profile === 'discord' ? [['test-analysing', false]] : [])]) {
        await phase(current, preparing);
        for (const width of [320, 480, 768, 1200]) {
          await page.setViewportSize({ width, height: 900 });
          const metrics = await page.locator(profile === 'discord' ? '#testBtn' : '#recordToggle').evaluate(node => {
            const rect = node.getBoundingClientRect();
            const children = [...node.children].filter(child => {
              const css = getComputedStyle(child);
              return css.display !== 'none' && css.position !== 'absolute';
            }).map(child => child.getBoundingClientRect());
            const spinner = getComputedStyle(node, '::after');
            const leading = spinner.position === 'static' ? parseFloat(spinner.width) + parseFloat(getComputedStyle(node).gap) : 0;
            return { height: rect.height, clipped: node.scrollWidth > node.clientWidth,
              centered: Math.abs((children[0].left - leading + children.at(-1).right - rect.left - rect.right) / 2),
              fits: children.every(child => child.top >= rect.top && child.bottom <= rect.bottom) };
          });
          assert.equal(metrics.height, 48);
          assert.equal(metrics.clipped, false);
          assert(metrics.fits);
          assert(metrics.centered < 0.1, `${profile}/${current}/${width}: off-center content`);
          if (current) assert(await page.locator('#sharedFooter').evaluate(node => node.inert));
          if (profile === 'discord' && current === 'test-recording' && !preparing && width === 1200) {
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

    // A deliberately long result exercises wrapping and scroll ownership without capturing audio.
    await page.evaluate(async () => {
      const panel = (await import('/js/ui/ReportPanelUI.js')).default;
      panel._renderReport({ run: { id: 'layout-fixture', type: 'record' }, audioMetrics: { status: 'unavailable' } });
      panel.open();
    });
    for (const width of [320, 480, 768, 1200]) {
      await page.setViewportSize({ width, height: 600 });
      assert(await page.locator('#reportPanel').evaluate(node => node.scrollWidth <= node.clientWidth));
      assert(await page.evaluate(() => {
        const header = document.querySelector('.report-popup-header').getBoundingClientRect();
        const body = document.querySelector('.report-popup-body').getBoundingClientRect();
        return [...document.querySelectorAll('.report-popup-actions button')].every(node => node.getBoundingClientRect().bottom <= header.bottom)
          && header.bottom <= body.top;
      }), `${width}: report actions must stay above scrolling content`);
    }
    await page.getByRole('button', { name: 'Close report', exact: true }).click();
    await page.locator('#accountMenuBtn').click();
    await page.setViewportSize({ width: 320, height: 600 });
    const headerTop = await page.locator('.account-dialog-header').evaluate(node => node.getBoundingClientRect().top);
    await page.locator('.account-dialog-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
    assert.equal(await page.locator('.account-dialog-header').evaluate(node => node.getBoundingClientRect().top), headerTop);
    assert.equal(await page.locator('.account-dialog-header .btn-overlay-close').evaluate(node => node.getBoundingClientRect().width), 32);
    console.log('PASS narrow report/header containment and persistent account close control');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
