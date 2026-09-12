// Real CSS color interpolation and meter rendering; no microphone or account writes.
const { chromium, firefox, webkit } = require('playwright');
const assert = require('node:assert/strict');
const BASE = 'http://localhost:8080';

(async () => {
  for (const [name, engine] of Object.entries({ chrome: chromium, firefox, webkit })) {
    const browser = await engine.launch({ headless: true, ...(name === 'chrome' ? { channel: 'chrome' } : {}) });
    try {
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route(url => url.origin !== BASE, route => route.fulfill({ body: '', contentType: 'text/css' }));
      await page.route('**/api/**', route => route.fulfill({ json: { ok: true, configured: false, user: null } }));
      await page.goto(`${BASE}/app`);
      await page.locator('#scenarioChoices [data-profile="raw"]').click();
      const result = await page.evaluate(async () => {
        const VuMeter = (await import('/js/modules/VuMeter.js')).default;
        const meter = Object.create(VuMeter.prototype);
        Object.assign(meter, {
          activityBarEl: document.querySelector('#micActivityBar'),
          activityStatusEl: document.querySelector('#micActivityStatus'),
          dotEl: document.querySelector('#signalDot')
        });
        const bar = document.querySelector('#vuMeterBar'), remote = document.querySelector('#remoteVuBar');
        const state = { colorDb: -55, smoothedRms: 0 };
        const data = new Float32Array(256), colors = new Set(), redColors = new Set();
        let same = true, unrecognized = false;
        const paint = db => {
          const analyser = { getFloatTimeDomainData: values => values.fill(10 ** (db / 20)) };
          state.lastRenderTime = performance.now() - 100;
          const current = meter._renderMeter(analyser, data, bar, null, 0, 0, 300, state);
          // Equal input must share the palette on both channels regardless of frame timing.
          remote.style.setProperty('--signal-color', current.color);
          meter._renderActivity(current.level, current.signalState, current.color);
          const css = getComputedStyle(bar).backgroundColor;
          same &&= css === getComputedStyle(meter.activityBarEl).backgroundColor
            && css === getComputedStyle(remote).backgroundColor
            && css === getComputedStyle(meter.activityStatusEl, '::before').backgroundColor
            && css === getComputedStyle(meter.dotEl).backgroundColor;
          unrecognized ||= !CSS.supports('background-color', current.color) || css === 'rgba(0, 0, 0, 0)';
          return css;
        };
        for (let db = -55; db < -6; db += 0.1) colors.add(paint(db));
        for (let db = -6; db <= -0.5; db += 0.02) redColors.add(paint(db));
        return { colors: colors.size, redColors: redColors.size, same, unrecognized };
      });
      assert(result.colors > 450, `${name}: continuous green-to-amber shades`);
      assert(result.redColors > 250, `${name}: continuous amber-to-red shades`);
      assert.equal(result.same, true, `${name}: main, detail, remote and dots agree`);
      assert.equal(result.unrecognized, false, `${name}: native color interpolation supported`);
      assert.deepEqual(errors, []);
      console.log(`PASS ${name}: ${result.colors + result.redColors} intermediate colors across all indicators`);
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
