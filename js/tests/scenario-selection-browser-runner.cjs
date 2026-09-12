// First-use navigation and remembered choices; microphone capture is never requested.
const { chromium, firefox, webkit } = require('playwright');
const { selectScenario } = require('./scenario-browser-helpers.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const BASE = 'http://localhost:8080';
const KEY = 'micprobe.lastScenario';

(async () => {
  const engine = process.argv.find(arg => arg.startsWith('--browser='))?.split('=')[1] || 'chrome';
  const browser = await ({ chrome: chromium, firefox, webkit })[engine].launch({ headless: true,
    ...(engine === 'chrome' ? { channel: 'chrome' } : {}) });
  const errors = [];
  const artifacts = process.env.MICPROBE_SCENARIO_ARTIFACTS;
  if (artifacts) await fs.mkdir(artifacts, { recursive: true });
  async function open(route = '/app', preference) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ key, preference }) => {
      if (preference !== undefined) localStorage.setItem(key, preference);
      window.__captureRequests = 0;
      // Windows WebKit may not expose microphone APIs; this suite only tests navigation.
      if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { window.__captureRequests++; throw new Error('Unexpected capture'); };
    }, { key: KEY, preference });
    const page = await context.newPage();
    await require('./scenario-browser-helpers.cjs').allowTestAccess(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.origin !== BASE, route => route.fulfill({ body: '' }));
    await page.route('**/api/account/**', route => route.fulfill({ json: { ok: true, configured: false, user: null } }));
    await page.route('**/api/freemius/config', route => route.fulfill({ json: { configured: false } }));
    await page.goto(BASE + route);
    if (route === '/') await page.locator('#heroLaunchBtn').click();
    await page.waitForFunction(() => document.body.classList.contains('app-mode'));
    return { context, page };
  }
  try {
    for (const route of ['/app', '/app/', '/#app', '/']) {
      const { context, page } = await open(route);
      assert(await page.locator('#scenarioPicker').isVisible(), route);
      assert.equal(await page.locator('#scenarioChoices [data-profile]').count(), 13);
      assert.equal(await page.locator('#scenarioChoices [aria-current]').count(), 0);
      assert.equal(await page.locator('#scenarioWorkspace').isVisible(), false);
      assert.equal(await page.locator('#testBtn').isEnabled(), false);
      assert.equal(await page.evaluate(() => window.__captureRequests), 0);
      await context.close();
    }
    console.log('PASS first use on all four entry routes, no selection and no capture');

    const { context, page } = await open();
    for (const width of [320, 390, 479, 480, 767, 768, 1023, 1024, 1199, 1200, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: overflow`);
      assert(await page.locator('#scenarioChoices [data-profile]').evaluateAll(nodes => nodes.every(node => {
        const rect = node.getBoundingClientRect();
        return rect.width >= 200 && rect.height >= 48 && rect.left >= 0 && rect.right <= innerWidth;
      })), `${width}: usable choices`);
      if (artifacts && [390, 1440].includes(width)) await page.screenshot({ path: path.join(artifacts, `chooser-${width}.png`), fullPage: true });
    }
    const profiles = await page.locator('#scenarioChoices [data-profile]').evaluateAll(nodes => nodes.map(node => node.dataset.profile));
    for (const id of profiles) {
      await selectScenario(page, id);
      assert(await page.locator('#scenarioWorkspace').isVisible());
      assert.equal(await page.locator('.nav-item[aria-current]').getAttribute('data-profile'), id);
      const isCall = await page.evaluate(async id => (await import('/js/modules/Config.js')).PROFILES[id].canTest, id);
      assert.equal(await page.locator('#testBtn').isVisible(), isCall);
      assert.equal(await page.locator('#recordToggle').isVisible(), !isCall);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'pageTitle');
      assert.equal(await page.evaluate(key => localStorage.getItem(key), KEY), id);
      assert(await page.locator('#scenarioPicker').isVisible(), 'Desktop keeps scenarios visible');
      assert.equal(await page.locator('#changeScenarioBtn').isVisible(), false);
      assert.equal(await page.locator('#scenarioChoices [aria-current]').getAttribute('data-profile'), id);
    }
    console.log('PASS 11 widths, all scenarios, correct actions and keyboard focus');

    const callsToggle = page.locator('[aria-controls="scenarioCallOptions"]');
    const messagesToggle = page.locator('[aria-controls="scenarioMessageOptions"]');
    assert.equal(await page.locator('.scenario-group-toggle[aria-expanded="true"]').count(), 0, 'Voice recording needs no extra category choice');
    await callsToggle.press('Enter');
    assert(await page.locator('#scenarioCallOptions').isVisible());
    assert.equal(await page.locator('#scenarioChoices [aria-current]').getAttribute('data-profile'), 'raw', 'Browsing a category does not select a different scenario');
    await messagesToggle.press('Space');
    assert.equal(await page.locator('#scenarioCallOptions').isVisible(), false);
    assert(await page.locator('#scenarioMessageOptions').isVisible());
    await messagesToggle.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.profile), 'whatsapp-voice', 'Tab reaches the open category and skips collapsed platforms');
    await messagesToggle.press('Space');
    assert.equal(await page.locator('#scenarioMessageOptions').isVisible(), false);
    await callsToggle.press('Enter');
    await page.locator('#scenarioChoices [data-profile="discord"]').press('Enter');
    await page.locator('#customSettingsToggle').click();
    await page.locator('#customSettingsGrid [data-setting="bitrate"]').selectOption('96000');
    await page.locator('#scenarioChoices [data-profile="discord"]').click();
    assert.equal(await page.locator('#customSettingsGrid [data-setting="bitrate"]').inputValue(), '96000');
    await selectScenario(page, 'telegram-voice');
    await page.reload();
    await page.waitForFunction(() => document.body.classList.contains('app-mode'));
    assert.equal(await page.locator('#scenarioPicker').isVisible(), true);
    assert.equal(await page.locator('.nav-item[aria-current]').getAttribute('data-profile'), 'telegram-voice');
    assert.equal(await messagesToggle.getAttribute('aria-expanded'), 'true', 'Reload opens the remembered scenario category');
    assert.equal(await callsToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => window.__captureRequests), 0);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'selected-desktop.png'), fullPage: true });
    for (const width of [390, 1023, 1024, 1032, 1440, 1920, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      // WebKit excludes its classic scrollbar from the CSS media-query width.
      const desktop = await page.evaluate(() => matchMedia('(min-width: 1024px)').matches);
      assert.equal(await page.locator('#scenarioPicker').isVisible(), desktop, `${width}: sidebar visibility`);
      assert.equal(await page.locator('#changeScenarioBtn').isVisible(), !desktop, `${width}: mobile chooser visibility`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: selected overflow`);
      if (desktop) {
        const picker = await page.locator('#scenarioPicker').boundingBox();
        const workspace = await page.locator('#scenarioWorkspace').boundingBox();
        const card = await page.locator('.console-card--primary').boundingBox();
        assert.equal(picker.x, 0, `${width}: sidebar attaches to the viewport edge`);
        assert(picker.width >= 240 && picker.width <= 300, `${width}: usable navigation width`);
        const header = await page.locator('.app-header').boundingBox();
        assert(Math.abs(picker.y - header.y - header.height) <= 1 && picker.y + picker.height <= 901, `${width}: sidebar fits below the header`);
        assert(picker.x + picker.width <= workspace.x, `${width}: scenarios stay left of test`);
        const consoleBox = await page.locator('.test-console').boundingBox();
        const info = await page.locator('.console-card--secondary').boundingBox();
        const footer = await page.locator('.site-footer').boundingBox();
        assert(consoleBox.width >= workspace.width * 0.69 && consoleBox.width <= 1600, `${width}: workspace uses the available desktop width`);
        if (await page.evaluate(() => matchMedia('(min-width: 1200px)').matches)) {
          assert(info.x >= card.x + card.width && Math.abs(info.y - card.y) <= 1, `${width}: guide and audio details fill the right column`);
          assert(info.width >= 300 && card.width >= info.width, `${width}: useful control and guide proportions`);
        }
        assert(footer.x === 0 && footer.width >= width - 16 && footer.height <= 80 && footer.y + footer.height <= 901, `${width}: compact full-width footer stays visible`);
        assert(await page.locator('#scenarioPicker').evaluate(node => node.scrollHeight <= node.clientHeight), 'The expanded category and top-level choices fit a normal desktop height');
        if (artifacts && [1440, 2560].includes(width)) await page.screenshot({ path: path.join(artifacts, `sidebar-${width}.png`) });
      } else {
        await page.locator('#changeScenarioBtn').click();
        assert.equal(await page.evaluate(() => document.activeElement.id), 'scenarioPickerTitle');
        assert.equal(await page.locator('#scenarioChoices [data-profile]:visible').count(), 13, 'Mobile chooser exposes every scenario without desktop disclosure state leaking');
        await selectScenario(page, 'telegram-voice');
      }
    }
    await page.setViewportSize({ width: 1440, height: 600 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await callsToggle.press('Enter');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator('#scenarioChoices [data-profile="whatsapp-telegram-call"]').focus();
    assert(await page.locator('#scenarioChoices [data-profile="whatsapp-telegram-call"]').evaluate(node => {
      const item = node.getBoundingClientRect(), panel = document.querySelector('#scenarioPicker').getBoundingClientRect();
      return item.top >= panel.top && item.bottom <= innerHeight && panel.top >= 0 && panel.bottom <= innerHeight;
    }), 'Short screens scroll the focused navigation item into the visible panel');
    const categoryScroll = await page.locator('#scenarioCallOptions').evaluate(node => ({
      top: node.scrollTop, height: node.clientHeight, content: node.scrollHeight
    }));
    assert(categoryScroll.top > 0, `Short screens scroll inside the open category: ${JSON.stringify(categoryScroll)}`);
    for (const selector of ['[aria-controls="scenarioCallOptions"]', '[aria-controls="scenarioMessageOptions"]', '#scenarioChoices [data-profile="raw"]']) {
      assert(await page.locator(selector).evaluate(node => {
        const rect = node.getBoundingClientRect();
        return rect.top >= document.querySelector('.app-header').getBoundingClientRect().bottom
          && rect.bottom <= document.querySelector('.site-footer').getBoundingClientRect().top;
      }), 'All three usage types stay visible while the platform list scrolls');
    }
    await page.locator('.site-footer').scrollIntoViewIfNeeded();
    assert(await page.locator('#scenarioPicker').evaluate(node => {
      const panel = node.getBoundingClientRect(), header = document.querySelector('.app-header').getBoundingClientRect();
      return Math.abs(panel.top - header.bottom) <= 1 && panel.bottom <= innerHeight + 1;
    }), 'The sidebar stays below the header when the footer is in view');
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'sidebar-short.png') });
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--fs-base', '28px');
      document.documentElement.style.setProperty('--fs-xs', '24px');
    });
    assert(await page.locator('#scenarioChoices strong').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), 'Navigation labels remain readable at twice the text size');
    await page.locator('#scenarioChoices [data-profile="raw"]').focus();
    assert(await page.locator('#scenarioChoices [data-profile="raw"]').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.top >= document.querySelector('.app-header').getBoundingClientRect().bottom && rect.bottom <= innerHeight;
    }), 'Large-text keyboard navigation remains reachable below the sticky header');
    await context.close();
    console.log('PASS Enter activation, same-scenario settings preserved and scenario choice restored after reload');

    for (const id of ['removed-profile', '__proto__']) {
      const { context, page } = await open('/app', id);
      assert(await page.locator('#scenarioPicker').isVisible());
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log('PASS obsolete preferences recover to chooser; no browser errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
