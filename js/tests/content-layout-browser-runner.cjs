// Layout fixtures only: no physical microphone, real account or purchase.
const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const { chromium, firefox, webkit } = require('playwright');
const { createPage, ready } = require('./account-browser-runner.cjs');
const BASE = 'http://localhost:8080';
const widths = [320, 390, 480, 768, 1280];

async function resize(page, width, scale) {
  await page.setViewportSize({ width, height: 800 });
  // Stress the application's text tokens; this is not native iOS text zoom.
  await page.evaluate(scale => {
    const root = document.documentElement;
    window.layoutFonts ||= Object.fromEntries(
      [...getComputedStyle(root)].filter(name => name.startsWith('--fs-'))
        .map(name => [name, getComputedStyle(root).getPropertyValue(name).trim()])
        .filter(([, value]) => /^\d+(\.\d+)?px$/.test(value)));
    for (const [name, value] of Object.entries(window.layoutFonts)) {
      root.style.setProperty(name, `${parseFloat(value) * scale}px`);
    }
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, scale);
}

async function assertTextFits(page, selector, label) {
  const failures = await page.locator(selector).evaluateAll(nodes => nodes.filter(node => node.checkVisibility())
    .flatMap(node => {
      const box = node.getBoundingClientRect();
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const rects = [];
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        rects.push(...range.getClientRects());
      }
      const fits = node.scrollWidth <= node.clientWidth + 1 && rects.every(rect =>
        rect.left >= Math.max(0, box.left) - 1 && rect.right <= Math.min(innerWidth, box.right) + 1);
      return fits ? [] : [{ text: node.textContent, width: box.width, scroll: node.scrollWidth }];
    }));
  assert.deepEqual(failures, [], `${label}: text must fit its own box, not just the page`);
}

async function assertPurchaseForm(page, label, inlineExpected = false) {
  const metrics = await page.locator('#accountDialog form').evaluate(form => {
    const input = form.querySelector('input'), button = form.querySelector('[type="submit"]');
    const field = input.getBoundingClientRect(), action = button.getBoundingClientRect();
    const box = form.getBoundingClientRect();
    const inline = action.left >= field.right - 1;
    return { inline, aligned: Math.abs(field.bottom - action.bottom) <= 1,
      stacked: action.top >= field.bottom && Math.abs(field.width - box.width) <= 1,
      usable: field.width >= Math.min(box.width, 12 * parseFloat(getComputedStyle(input).fontSize)) - 1,
      contained: [field, action].every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1),
      width: field.width, offset: field.bottom - action.bottom };
  });
  assert(metrics.contained && metrics.usable, `${label}: usable input width: ${JSON.stringify(metrics)}`);
  assert(metrics.inline ? metrics.aligned : metrics.stacked, `${label}: input/action alignment: ${JSON.stringify(metrics)}`);
  if (inlineExpected) assert(metrics.inline, `${label}: desktop form should stay on one row`);
  await assertTextFits(page, '#accountDialog form button', label);
}

async function purchaseForms(browser, name) {
  for (const state of ['free', 'inactive', 'legacy']) {
    const env = await createPage(browser, { signedIn: state !== 'legacy', purchaseLinked: state === 'inactive' });
    try {
      env.setPremiumUnlocked(false);
      const { page } = env;
      await page.goto(`${BASE}/app`); await ready(page);
      await page.locator('#accountMenuBtn').click();
      await page.locator('.account-restore > summary').click();
      const submit = page.locator('#accountDialog form button');
      const caption = await submit.textContent();
      for (const scale of [1, 2]) {
        for (const width of widths) {
          await resize(page, width, scale);
          await assertPurchaseForm(page, `${name}/${state}/${width}/${scale}`, width >= 768 && scale === 1);
          // Disabled and longer action text must not consume the license input.
          await submit.evaluate(node => { node.disabled = true; node.textContent = 'Checking your purchase…'; });
          await assertPurchaseForm(page, `${name}/${state}/${width}/${scale}/busy`);
          await submit.evaluate((node, caption) => { node.disabled = false; node.textContent = caption; }, caption);
          if (name === 'chrome' && state === 'inactive' && [320, 1280].includes(width)) {
            await page.locator('#accountDialog form').scrollIntoViewIfNeeded();
            await page.screenshot({ path: `.tmp/content-layout/purchase-${width}-${scale}.png` });
          }
        }
      }
      assert.deepEqual(env.pageErrors, []);
      assert.equal(await page.evaluate(() => window.__accountTestMicRequests), 0);
    } finally { await env.context.close(); }
  }
}

async function content(browser, name) {
  const env = await createPage(browser);
  const { page } = env;
  try {
    for (const path of ['/', '/app', '/privacy.html', '/terms.html']) {
      await page.goto(BASE + path);
      const profiles = path === '/app' ? ['discord', 'raw'] : [null];
      if (path === '/app') await ready(page);
      for (const profile of profiles) {
        if (profile) {
          await resize(page, 1280, 1);
          await page.locator(`#scenarioChoices [data-profile="${profile}"]`).click();
          await page.locator('#audioDetails').evaluate(node => { node.open = true; });
        }
        for (const scale of [1, 2]) {
          for (const width of widths) {
            await resize(page, width, scale);
            const label = `${name}/${path}/${profile}/${width}/${scale}`;
            await assertTextFits(page, '.site-footer-heading, .site-footer-links a', label);
            if (path === '/') await assertTextFits(page, '.feature-title, .feature-description, .step-title, .step-description', label);
            if (profile) await assertTextFits(page, '.status-tile-label, .status-tile-value', label);
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: page overflow`);
          }
        }
      }
    }
    assert.deepEqual(env.pageErrors, []);
    assert.equal(await page.evaluate(() => window.__accountTestMicRequests), 0);
  } finally { await env.context.close(); }
}

(async () => {
  await mkdir('.tmp/content-layout', { recursive: true });
  const selected = process.argv.find(arg => arg.startsWith('--browser='))?.split('=')[1];
  for (const name of selected ? [selected] : ['chrome', 'firefox', 'webkit']) {
    assert(['chrome', 'firefox', 'webkit'].includes(name), 'Select chrome, firefox or webkit');
    const browser = await ({ chrome: chromium, firefox, webkit })[name].launch({
      headless: true, ...(name === 'chrome' ? { channel: 'chrome' } : {})
    });
    try {
      await purchaseForms(browser, name);
      await content(browser, name);
      console.log(`PASS ${name}: purchase alignment/usable width, full technical values, card text and shared footer at 1x/2x text`);
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
