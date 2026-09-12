const { chromium, firefox, webkit } = require('playwright');
const assert = require('node:assert/strict');
const { mkdirSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const BASE = 'http://localhost:8080';
const output = resolve('.tmp/landing-offer');
const built = process.argv.includes('--built');
const builtRoot = resolve('.tmp/cloudflare-dev-assets');
const widths = [320, 390, 700, 768, 1024, 1199, 1200, 1440, 1920];
mkdirSync(output, { recursive: true });

(async () => {
  for (const name of process.argv.includes('--all-browsers') ? ['chromium', 'firefox', 'webkit'] : ['chromium']) {
    const browser = await ({ chromium, firefox, webkit })[name].launch({ ...(name === 'chromium' ? { channel: 'chrome' } : {}), headless: true });
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [], requests = [];
    let priceCalls = 0, priceFails = false;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(new URL(request.url()).pathname));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== BASE) return route.fulfill({ body: '' });
      if (built && !url.pathname.startsWith('/api/')) {
        const entry = url.pathname === '/' ? '/index.html' : /^\/app\/?$/.test(url.pathname) ? '/app.html' : url.pathname;
        const path = resolve(builtRoot, '.' + entry);
        if (path.startsWith(builtRoot) && existsSync(path)) return route.fulfill({ path });
      }
      return route.continue();
    });
    await page.route('**/api/account/**', route => route.fulfill({ json: { configured: false, authenticated: false, ok: true } }));
    await page.route('**/api/freemius/config', route => route.fulfill({ json: { configured: false } }));
    await page.route('**/api/pricing', route => {
      priceCalls++;
      return route.fulfill({ status: priceFails ? 503 : 200,
        json: priceFails ? { error: 'pricing_unavailable' } : { amount: 7.99, currency: 'USD', billingCycle: 'lifetime' } });
    });
    try {
      await page.goto(BASE);
      await page.locator('#publicPrice[data-state="ready"]').waitFor();
      await page.locator('.hero-photo').evaluate(photo => photo.decode());
      assert.equal(await page.locator('#premiumPrice').innerText(), '$7.99');
      // The shared identity header may check the account; microphone and checkout boot stay lazy.
      assert.ok(!requests.some(path => path === '/api/freemius/config' || path === '/js/app.js'));
      for (const width of widths) {
        await page.setViewportSize({ width, height: 1000 });
        for (const large of [false, true]) {
          await page.evaluate(large => {
            document.documentElement.style.fontSize = large ? '200%' : '';
            return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          }, large);
          const overflow = await page.evaluate(() => {
            const nodes = [...document.querySelectorAll('.navbar, .navbar-nav, .hero, .hero-content, .hero-audio-signature, .hero-visual, .hero-benefits, .hero-scope-note, .landing-card, .landing-section, .pricing-layout, .pricing-option, .pricing-footnote, .plan-price-row, .faq-list, .landing-section .btn')];
            return nodes.filter(node => node.scrollWidth > node.clientWidth + 1 || node.getBoundingClientRect().right > innerWidth + 1
              || node.getBoundingClientRect().left < -1).map(node => ({
                element: node.id || node.className, width: node.clientWidth, scrollWidth: node.scrollWidth,
                children: [...node.children].map(child => ({ element: child.id || child.className, width: child.clientWidth, scrollWidth: child.scrollWidth }))
              }));
          });
          assert.deepEqual(overflow, [], `${name} ${width}px ${large ? 'large' : 'normal'} text`);
          const { positions, ...alignment } = await page.evaluate(() => {
            const box = selector => document.querySelector(selector).getBoundingClientRect();
            const intro = box('#pricing .section-header'), card = box('.pricing-option'), note = box('.pricing-footnote');
            const section = box('#pricing'), center = section.left + section.width / 2;
            const left = box('.hero').left;
            const photo = document.querySelector('.hero-photo');
            return {
              positions: { width: innerWidth, intro: { top: intro.top, bottom: intro.bottom, right: intro.right }, card: { top: card.top, left: card.left } },
              uncroppedPhoto: Math.abs(photo.clientHeight - photo.clientWidth * photo.naturalHeight / photo.naturalWidth) <= 2,
              edges: ['#navbarBrand', '#features-title', '#how-it-works-title', '#faq-title', '.site-footer-content']
                .every(selector => Math.abs(box(selector).left - left) <= 1),
              note: Math.abs(note.left - card.left) <= 1 && note.top >= card.bottom,
              placement: card.top >= intro.bottom && Math.abs(card.left + card.width / 2 - center) <= 1
                && Math.abs(intro.left + intro.width / 2 - center) <= 1
            };
          });
          assert.deepEqual(alignment, { uncroppedPhoto: true, edges: true, note: true, placement: true }, `${name} ${width}px ${large ? 'large' : 'normal'} text alignment: ${JSON.stringify(positions)}`);
        }
        await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
      }
      await page.setViewportSize({ width: 768, height: 1000 });
      await page.locator('#mobileMenuBtn').click();
      assert.equal(await page.locator('#mobileMenuBtn').getAttribute('aria-expanded'), 'true');
      await page.locator('#navbar a[href="#pricing"]').click();
      assert.equal(new URL(page.url()).hash, '#pricing');
      assert.equal(await page.locator('#mobileMenuBtn').getAttribute('aria-expanded'), 'false');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.locator('#navbar a[href="#features"]').click();
      assert.equal(new URL(page.url()).hash, '#features');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'features-title');
      await page.locator('.hero-privacy a').click();
      assert.equal(await page.locator('#faq-privacy').getAttribute('open'), '');
      assert.equal(await page.evaluate(() => document.activeElement.tagName), 'SUMMARY');
      await page.locator('#faq-privacy summary').press('Enter');
      assert.equal(await page.locator('#faq-privacy').getAttribute('open'), null);
      for (const id of ['faq-test-limits', 'faq-saved-reports']) {
        await page.locator(`#pricing a[href="#${id}"]`).click();
        assert.equal(new URL(page.url()).hash, `#${id}`);
        assert.equal(await page.locator(`#${id}`).getAttribute('open'), '');
        assert.equal(await page.evaluate(() => document.activeElement.closest('details')?.id), id);
        await page.locator(`#${id} summary`).press('Enter');
        assert.equal(await page.locator(`#${id}`).getAttribute('open'), null);
      }
      if (name === 'chromium') {
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.locator('#pricing').screenshot({
            path: resolve(output, `pricing-${width}.png`), style: '#navbar { visibility: hidden !important; }'
          });
        }
      }
      assert.equal(priceCalls, 1, 'Section navigation reuses the verified price');
      await page.locator('#pricingPremiumCta').click();
      await page.locator('#accountDialog[open]').waitFor();
      assert.equal(new URL(page.url()).pathname, '/app');
      assert.equal(new URL(page.url()).hash, '#premium');
      await page.goto(BASE + '/app#premium');
      await page.locator('#accountDialog[open]').waitFor();
      assert.equal(priceCalls, 1, 'Direct app entry does not request landing pricing');
      await page.goto(BASE + '/#faq');
      await page.locator('#publicPrice[data-state="ready"]').waitFor();
      assert.equal(new URL(page.url()).hash, '#faq');
      await page.goto(BASE + '/#faq-saved-reports');
      await page.locator('#publicPrice[data-state="ready"]').waitFor();
      assert.equal(await page.locator('#faq-saved-reports').getAttribute('open'), '');
      assert.equal(new URL(page.url()).hash, '#faq-saved-reports');
      assert.equal(await page.locator('#faq-saved-reports p').first().isVisible(), true);
      priceFails = true;
      await page.reload();
      await page.locator('#publicPrice[data-state="error"]').waitFor();
      assert.match(await page.locator('#premiumPrice').innerText(), /checkout/);
      assert.equal(await page.locator('#pricingPremiumCta').isEnabled(), true);
      assert(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#premiumPrice')).fontSize)
        < parseFloat(getComputedStyle(document.querySelector('#premium-plan-title')).fontSize)), 'Unavailable price is secondary to the plan title');
      priceFails = false;
      await page.locator('#pricingRetry').click();
      await page.locator('#publicPrice[data-state="ready"]').waitFor();
      assert.equal(await page.locator('#pricingRetry').isVisible(), false);
      await page.goto(BASE);
      let releaseApp;
      const appGate = new Promise(resolve => { releaseApp = resolve; });
      await page.route(built ? '**/assets/app-*.js' : '**/js/app.js', async route => { await appGate; await route.fallback(); });
      await page.locator('#pricingPremiumCta').click();
      await page.locator('#heroLaunchBtn').click();
      releaseApp();
      await page.waitForFunction(() => document.body.classList.contains('app-mode'));
      assert.equal(await page.locator('#accountDialog').isVisible(), false, 'A later free-test click supersedes the Premium intent');
      assert.deepEqual(errors, []);
      console.log(`PASS ${name}: price/retry, lazy app, section/FAQ navigation, Premium entry, alignment at ${widths.length * 2} width/text combinations`);
    } finally { await context.close(); await browser.close(); }
  }
  console.log(`Screenshots: ${output}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
