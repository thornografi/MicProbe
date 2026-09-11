// First-use navigation and remembered choices; microphone capture is never requested.
const { chromium } = require('playwright');
const { selectScenario } = require('./scenario-browser-helpers.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const BASE = 'http://localhost:8080';
const KEY = 'micprobe.lastScenario';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const artifacts = process.env.MICPROBE_SCENARIO_ARTIFACTS;
  if (artifacts) await fs.mkdir(artifacts, { recursive: true });
  async function open(route = '/app', preference) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ key, preference }) => {
      if (preference !== undefined) localStorage.setItem(key, preference);
      window.__captureRequests = 0;
      navigator.mediaDevices.getUserMedia = async () => { window.__captureRequests++; throw new Error('Unexpected capture'); };
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
      assert.equal(await page.locator('#scenarioChoices button').count(), 13);
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
      assert(await page.locator('#scenarioChoices button').evaluateAll(nodes => nodes.every(node => {
        const rect = node.getBoundingClientRect();
        return rect.width >= 200 && rect.height >= 48 && rect.left >= 0 && rect.right <= innerWidth;
      })), `${width}: usable choices`);
      if (artifacts && [390, 1440].includes(width)) await page.screenshot({ path: path.join(artifacts, `chooser-${width}.png`), fullPage: true });
    }
    const profiles = await page.locator('#scenarioChoices [data-profile]').evaluateAll(nodes => nodes.map(node => node.dataset.profile));
    for (const id of profiles) {
      await page.locator(`#scenarioChoices [data-profile="${id}"]`).click();
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
    assert.equal(await page.evaluate(() => window.__captureRequests), 0);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'selected-desktop.png'), fullPage: true });
    for (const width of [390, 1023, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await page.locator('#scenarioPicker').isVisible(), width >= 1024);
      assert.equal(await page.locator('#changeScenarioBtn').isVisible(), width < 1024);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: selected overflow`);
      if (width >= 1024) {
        const picker = await page.locator('#scenarioPicker').boundingBox();
        const workspace = await page.locator('#scenarioWorkspace').boundingBox();
        assert(picker.x + picker.width <= workspace.x, `${width}: scenarios stay left of test`);
      } else {
        await page.locator('#changeScenarioBtn').click();
        assert.equal(await page.evaluate(() => document.activeElement.id), 'scenarioPickerTitle');
        await selectScenario(page, 'telegram-voice');
      }
    }
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
