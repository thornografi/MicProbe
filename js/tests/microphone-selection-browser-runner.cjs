// localhost:8080, Playwright and Chrome. Uses only Chrome's synthetic microphone.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = 'http://localhost:8080';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  try {
    const context = await browser.newContext();
    await context.grantPermissions(['microphone'], { origin: BASE });
    const page = await context.newPage();
    await require('./scenario-browser-helpers.cjs').allowTestAccess(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(`${BASE}/js/tests/microphone-selection-fixture`, route => route.fulfill({
      contentType: 'text/html', body: '<select id="mic"></select>'
    }));
    await page.goto(`${BASE}/js/tests/microphone-selection-fixture`);
    await page.evaluate(async () => {
      const { default: DeviceInfo } = await import('/js/modules/DeviceInfo.js');
      const { createControllerDeps } = await import('/js/app/Dependencies.js');
      const { default: bus } = await import('/js/modules/EventBus.js');
      const { EVENTS } = await import('/js/modules/constants.js');
      const physical = [
        { kind: 'audioinput', deviceId: 'intel', groupId: 'internal', label: 'Intel microphone' },
        { kind: 'audioinput', deviceId: 'vm', groupId: 'virtual', label: 'Voicemeeter Out B1' }
      ];
      const h = window.harness = {
        physical, devices: [], captures: 0,
        nativeEnumerate: navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices),
        nativeCapture: navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),
        setDefault(id) {
          const mic = physical.find(device => device.deviceId === id);
          this.devices = [
            { ...mic, deviceId: 'default', label: `Default - ${mic.label}` },
            { ...mic, deviceId: 'communications' }, ...physical
          ];
        },
        async mount() {
          this.info?.destroy();
          // A fresh select models reload without keeping the old DOM handlers.
          this.select?.remove();
          this.select = document.createElement('select');
          document.body.appendChild(this.select);
          this.info = new DeviceInfo();
          this.info.micSelector = this.select;
          this.info.setupMicEventListeners();
          this.deps = createControllerDeps({}, {}, this.info);
          await this.info.tryEnumerateWithoutPermission();
        },
        selectMic(id) {
          this.select.value = id;
          this.select.dispatchEvent(new Event('change'));
        },
        async deviceChange() {
          await new Promise(resolve => {
            const done = () => { bus.off(EVENTS.MICROPHONE_ACCESS_CHANGED, done); resolve(); };
            bus.on(EVENTS.MICROPHONE_ACCESS_CHANGED, done);
            navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
          });
        },
        snapshot() {
          return { value: this.select.value, label: this.select.selectedOptions[0]?.textContent,
            options: [...this.select.options].map(option => option.value),
            stored: localStorage.getItem('micprobe_selectedMic'),
            deviceId: this.deps.getConstraints().deviceId ?? null, captures: this.captures,
            access: this.info.accessState };
        }
      };
      navigator.mediaDevices.enumerateDevices = async () => h.devices;
      navigator.mediaDevices.getUserMedia = async () => {
        h.captures++;
        throw new Error('Enumeration must not open a microphone');
      };
      h.setDefault('intel');
      await h.mount();
    });

    const snapshot = () => page.evaluate(() => harness.snapshot());
    let state = await snapshot();
    assert.equal(state.value, '');
    assert.equal(state.label, 'System default (Intel microphone)');
    assert.deepEqual(state.deviceId, { exact: 'default' });
    assert.deepEqual(state.options, ['', 'intel', 'vm']);
    assert.equal(state.stored, null);
    console.log('PASS first visit uses the dynamic default alias, with no duplicate aliases');

    await page.evaluate(async () => { harness.setDefault('vm'); await harness.deviceChange(); });
    state = await snapshot();
    assert.equal(state.value, '');
    assert.equal(state.label, 'System default (Voicemeeter Out B1)');
    assert.deepEqual(state.deviceId, { exact: 'default' });
    assert.equal(state.captures, 0);
    console.log('PASS default change updates the label without capturing or pinning a physical ID');

    await page.evaluate(async () => {
      harness.selectMic('vm');
      harness.setDefault('intel');
      await harness.deviceChange();
      await harness.mount();
    });
    state = await snapshot();
    assert.equal(state.value, 'vm');
    assert.equal(state.stored, 'vm');
    assert.deepEqual(state.deviceId, { exact: 'vm' });
    console.log('PASS explicit microphone survives a system change and a new page instance');

    await page.evaluate(async () => { harness.selectMic(''); await harness.mount(); });
    state = await snapshot();
    assert.equal(state.value, '');
    assert.equal(state.stored, null);
    assert.deepEqual(state.deviceId, { exact: 'default' });
    console.log('PASS choosing System default clears the saved override and survives reload');

    await page.evaluate(async () => {
      harness.selectMic('vm');
      harness.devices = harness.devices.filter(device => device.deviceId !== 'vm');
      await harness.deviceChange();
    });
    state = await snapshot();
    assert.equal(state.value, '');
    assert.equal(state.stored, null);
    assert.deepEqual(state.deviceId, { exact: 'default' });
    console.log('PASS unplugged selection falls back to system mode');

    await page.evaluate(async () => { harness.devices = []; await harness.deviceChange(); });
    state = await snapshot();
    assert.equal(state.access, 'unavailable');
    assert.equal(state.deviceId, null);
    await page.evaluate(async () => { harness.setDefault('intel'); await harness.deviceChange(); });
    state = await snapshot();
    assert.equal(state.access, 'ready');
    assert.equal(state.label, 'System default (Intel microphone)');
    assert.equal(state.captures, 0);
    console.log('PASS disconnecting all microphones and reconnecting recovers through events');

    await page.evaluate(async () => {
      harness.devices = [{ kind: 'audioinput', deviceId: 'default', label: 'Default', groupId: '' }];
      await harness.deviceChange();
    });
    state = await snapshot();
    assert.equal(state.access, 'ready');
    assert.deepEqual(state.options, ['']);
    assert.deepEqual(state.deviceId, { exact: 'default' });
    console.log('PASS a default-only device list remains usable without separate physical entries');

    await page.evaluate(async () => {
      harness.devices = harness.physical;
      await harness.deviceChange();
    });
    state = await snapshot();
    assert.equal(state.label, 'System default');
    assert.equal(state.deviceId, null);
    console.log('PASS browsers without a default alias receive no unsupported deviceId constraint');

    await page.evaluate(async () => {
      harness.selectMic('vm');
      harness.devices = [{ kind: 'audioinput', deviceId: '', label: '', groupId: '' }];
      await harness.deviceChange();
    });
    state = await snapshot();
    assert.deepEqual(state.deviceId, { exact: 'vm' });
    assert.equal(state.stored, 'vm');
    await page.evaluate(async () => { harness.setDefault('intel'); await harness.deviceChange(); });
    state = await snapshot();
    assert.equal(state.value, 'vm');
    assert.equal(state.access, 'ready');
    assert.equal(state.captures, 0);
    console.log('PASS permission placeholder preserves explicit choice and events recover without capture');

    // Check the shared call/record constraints against an actual Chrome media device.
    const native = await page.evaluate(async () => {
      harness.selectMic('');
      // Grant permission using only Chrome's synthetic microphone, then expose labels.
      const permissionStream = await harness.nativeCapture({ audio: true });
      permissionStream.getTracks().forEach(track => track.stop());
      harness.devices = await harness.nativeEnumerate();
      await harness.deviceChange();
      const constraints = harness.deps.getConstraints();
      const stream = await harness.nativeCapture({ audio: constraints });
      const result = { live: stream.getAudioTracks()[0].readyState, label: harness.snapshot().label };
      stream.getTracks().forEach(track => track.stop());
      harness.info.destroy();
      return result;
    });
    assert.equal(native.live, 'live');
    assert.match(native.label, /^System default/);
    console.log('PASS actual Chrome accepts the default capture constraints (synthetic microphone)');

    await page.route(url => url.origin !== BASE, route => route.fulfill({ body: '' }));
    await page.route('**/api/account/**', route => route.fulfill({ json: { ok: true, configured: false, user: null } }));
    await page.route('**/api/freemius/config', route => route.fulfill({ json: { configured: false, mode: 'sandbox' } }));
    await page.goto(`${BASE}/app/`);
    await page.waitForFunction(() => document.querySelector('#micSelector option')?.textContent.startsWith('System default'));
    assert.equal(await page.locator('#micSelector').inputValue(), '');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#micSelector option')?.textContent.startsWith('System default'));
    assert.equal(await page.locator('#micSelector').inputValue(), '');
    console.log('PASS application startup and full page reload display System default');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
