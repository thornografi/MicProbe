// Synthetic audio -> production AudioWorklet/MeterSource -> production DOM/CSS.
// This measures browser behavior, not physical microphone-to-display latency.
const { chromium, firefox, webkit } = require('playwright');
const assert = require('node:assert/strict');
const BASE = 'http://localhost:8080';
const engines = process.argv.includes('--all-browsers') ? { chrome: chromium, firefox, webkit } : { chrome: chromium };
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];

(async () => {
  for (const [name, engine] of Object.entries(engines)) {
    const browser = await engine.launch({ headless: true, ...(name === 'chrome'
      ? { channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] } : {}) });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route(url => url.origin !== BASE, route => route.fulfill({ body: '', contentType: 'text/css' }));
      await page.route('**/api/**', route => route.fulfill({ json: { ok: true, configured: false, user: null } }));
      await page.goto(`${BASE}/app`);
      await page.locator('#scenarioChoices [data-profile="raw"]').click();
      const hasAudio = await page.evaluate(() => !!(window.AudioContext || window.webkitAudioContext));
      if (!hasAudio) {
        console.log(`SKIP ${name} audio: this browser build exposes no AudioContext; CSS colors are tested separately`);
        continue;
      }
      await page.evaluate(async () => {
        document.body.dataset.appState = 'recording';
        document.querySelector('#audioDetails').open = true;
        const MeterSource = (await import('/js/modules/MeterSource.js')).default;
        window.makeMeterGraph = async (sampleRate = 48000) => {
          const Context = window.AudioContext || window.webkitAudioContext;
          const ac = new Context({ sampleRate }); await ac.resume();
          const analyser = ac.createAnalyser(), source = ac.createConstantSource();
          source.offset.value = 0; source.connect(analyser);
          const meter = new MeterSource(analyser); await meter.ready;
          source.start();
          return { ac, analyser, source, meter, close: async () => { source.stop(); meter.close(); await ac.close(); } };
        };
      });
      for (const durationMs of [1, 3, 6, 12]) {
        const result = await page.evaluate(async durationMs => {
          const g = await window.makeMeterGraph();
          try {
            const count = 40, period = 0.0713, start = g.ac.currentTime + 0.2, found = new Set();
            for (let i = 0; i < count; i++) {
              g.source.offset.setValueAtTime(1, start + i * period);
              g.source.offset.setValueAtTime(0, start + i * period + durationMs / 1000);
            }
            await new Promise(resolve => {
              const tick = () => {
                const sample = g.meter.read();
                if (sample.peak > 0.95) {
                  const index = Math.floor((g.meter.latest.clipTime - start) / period);
                  if (index >= 0 && index < count) found.add(index);
                }
                if (g.ac.currentTime > start + count * period + 0.1) resolve(); else requestAnimationFrame(tick);
              }; requestAnimationFrame(tick);
            });
            return { durationMs, observed: found.size, count, mode: g.meter.mode, sampleRate: g.ac.sampleRate };
          } finally { await g.close(); }
        }, durationMs);
        assert.equal(result.mode, 'worklet');
        assert.equal(result.observed, result.count, `${name}: ${durationMs} ms pulses`);
        console.log(`PASS ${name} pulses ${JSON.stringify(result)}`);
      }

      const stalled = await page.evaluate(async () => {
        const g = await window.makeMeterGraph();
        try {
          await new Promise(resolve => setTimeout(resolve, 50));
          g.meter.read();
          const start = g.ac.currentTime + 0.1;
          g.source.offset.setValueAtTime(1, start); g.source.offset.setValueAtTime(0, start + 0.001);
          let recovered;
          g.meter.node.port.addEventListener('message', ({ data }) => { if (data.peak > 0.95) recovered = data; });
          // Let all engines commit scheduled AudioParam controls to the audio
          // graph before blocking the page that scheduled our synthetic pulse.
          await new Promise(resolve => setTimeout(resolve, 20));
          const until = performance.now() + 250;
          while (performance.now() < until) { /* intentionally block UI, never audio thread */ }
          const timeout = performance.now() + 500;
          while (!recovered && performance.now() < timeout) await new Promise(resolve => setTimeout(resolve, 5));
          return { recovered: !!recovered, sample: g.meter.read(), latestRms: recovered?.rms };
        } finally { await g.close(); }
      });
      assert(stalled.recovered, `${name}: sound during UI stall retained`);
      assert.equal(stalled.sample.peak, 0, 'old overload does not replay as a current full-scale signal');
      assert.equal(stalled.latestRms, 0);
      assert(stalled.sample.clipAgeMs >= 100 && stalled.sample.clipAgeMs < 700);
      console.log(`PASS ${name} UI-stall recovery ${JSON.stringify(stalled)}`);

      for (let trial = 0; trial < 3; trial++) {
        const measurement = await page.evaluate(async () => {
          const g = await window.makeMeterGraph();
          const VuMeter = (await import('/js/modules/VuMeter.js')).default;
          const view = Object.create(VuMeter.prototype);
          Object.assign(view, { activityBarEl: document.querySelector('#micActivityBar'),
            activityStatusEl: document.querySelector('#micActivityStatus'), dotEl: document.querySelector('#signalDot') });
          const bar = document.querySelector('#vuMeterBar'), data = new Float32Array(g.analyser.fftSize);
          const lowDb = -36, highDb = -6.1, low = 10 ** (lowDb / 20), high = 10 ** (highDb / 20);
          const up = g.ac.currentTime + 0.4, down = up + 1.5, end = down + 1.5;
          g.source.offset.setValueAtTime(low, g.ac.currentTime);
          g.source.offset.setValueAtTime(high, up); g.source.offset.setValueAtTime(low, down);
          const state = { smoothedRms: low, colorDb: lowDb }, rows = [];
          try {
            await new Promise(resolve => {
              const tick = () => {
                const t = performance.now(), audioTime = g.ac.currentTime;
                const sample = g.meter.read();
                const result = view._renderMeter(g.analyser, data, bar, null, 0, 0, 300, state, null, sample);
                view._renderActivity(result.activityLevel, result.signalState, result.color);
                const writeMs = performance.now() - t;
                const width = parseFloat(getComputedStyle(view.activityBarEl).width)
                  / parseFloat(getComputedStyle(view.activityBarEl.parentElement).width) * 100;
                rows.push({ t, audioTime, raw: sample.peak > 0 ? 20 * Math.log10(sample.peak) : -96,
                  color: state.colorDb, width, targetWidth: result.activityLevel, writeMs });
                if (audioTime >= end) resolve(); else requestAnimationFrame(tick);
              }; requestAnimationFrame(tick);
            });
            return { rows, up, down, lowDb, highDb };
          } finally { await g.close(); }
        });
        const { rows, lowDb, highDb, down } = measurement;
        const rise = rows.findIndex(row => row.raw > lowDb + 1);
        const fall = rows.findIndex((row, i) => i > rise && row.audioTime > down && row.raw < highDb - 1);
        const response = (index, rising) => {
          const thresholdDb = rising ? lowDb + (highDb - lowDb) * 0.9 : highDb - (highDb - lowDb) * 0.9;
          const reached = rows.slice(index).find(row => rising ? row.color >= thresholdDb : row.color <= thresholdDb);
          return reached ? +(reached.t - rows[index].t).toFixed(1) : null;
        };
        const result = { trial, rise90Ms: response(rise, true), fall90Ms: response(fall, false),
          frameP95Ms: +quantile(rows.slice(1).map((row, i) => row.t - rows[i].t), 0.95).toFixed(2),
          renderP95Ms: +quantile(rows.map(row => row.writeMs), 0.95).toFixed(2),
          widthErrorPercent: Math.max(...rows.map(row => Math.abs(row.width - row.targetWidth))) };
        assert(result.rise90Ms !== null && result.rise90Ms < 100);
        assert(result.fall90Ms !== null && result.fall90Ms < 550);
        assert(result.widthErrorPercent < 0.1, `computed fill follows the color envelope without a second CSS transition: ${JSON.stringify(result)}`);
        console.log(`PASS ${name} response ${JSON.stringify(result)}`);
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
